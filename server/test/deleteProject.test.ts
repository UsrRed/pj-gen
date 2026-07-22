import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { seedQueuedProject, testContainer } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

describe('DELETE /api/projects/:id', () => {
  it('refuse tant que le projet n’est pas annulé, puis efface DB + workspace', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const id = await seedQueuedProject(c, 'A Supprimer');
    const row = c.repos.projects.byId(id)!;
    c.repos.messages.insert(id, 'cadrage', 'user', 'bonjour');
    c.repos.stepRuns.create(id, 'scaffold', null, 1, null, 'sonnet');

    // Not canceled yet (queued) → 409, nothing touched.
    const refused = await appRef.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(refused.statusCode).toBe(409);
    expect(c.repos.projects.byId(id)).toBeDefined();
    expect(fs.existsSync(row.workspace_path)).toBe(true);

    const cancel = await appRef.inject({ method: 'POST', url: `/api/projects/${id}/cancel` });
    expect(cancel.statusCode).toBe(200);

    const deleted: string[] = [];
    c.bus.subscribe({ projectId: null, fn: (_i, type, pid) => type === 'project.deleted' && deleted.push(pid!) });
    const res = await appRef.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    expect(c.repos.projects.byId(id)).toBeUndefined();
    expect(c.repos.messages.list(id)).toHaveLength(0);
    expect(c.repos.stepRuns.listForProject(id)).toHaveLength(0);
    expect(fs.existsSync(row.workspace_path)).toBe(false);
    expect(deleted).toEqual([id]);

    const again = await appRef.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(again.statusCode).toBe(404);
  });

  it('ne supprime jamais un dossier hors du workspaceRoot', async () => {
    const { c, base } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const id = await seedQueuedProject(c, 'Chemin Corrompu');
    c.repos.projects.casStatus(id, ['queued'], 'canceled');
    const outside = `${base}/ailleurs`;
    fs.mkdirSync(outside, { recursive: true });
    c.db.prepare('UPDATE projects SET workspace_path = ? WHERE id = ?').run(outside, id);

    const res = await appRef.inject({ method: 'DELETE', url: `/api/projects/${id}` });
    expect(res.statusCode).toBe(200);
    expect(c.repos.projects.byId(id)).toBeUndefined();
    expect(fs.existsSync(outside)).toBe(true);
  });
});
