import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

async function setup() {
  const { c } = await testContainer();
  cRef = c;
  appRef = await createApp(c);
  return appRef;
}

describe('POST /api/projects/:id/retry — projet importé sans stack', () => {
  it("refait l'analyse d'import puis remet en file, au lieu de rejouer un micro-pipeline voué à « stack inconnue »", async () => {
    const app = await setup();
    const c = cRef!;
    const workspacePath = await c.ws.create('imported', 'imported');
    const id = 'imported-id';
    c.repos.projects.insert({ id, slug: 'imported', title: 'imported', model: null, workspacePath, initialPrompt: 'import' });
    c.repos.projects.casStatus(id, ['draft'], 'failed', {
      github_repo: 'usrred/imported',
      pipeline_mode: 'micro',
      error_message: 'implement_task: stack inconnue',
    });
    expect(c.repos.projects.byId(id)!.stack).toBeNull();

    const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/retry` });
    expect(res.statusCode).toBe(200);

    await waitFor(() => c.repos.projects.byId(id)!.status === 'queued');
    const row = c.repos.projects.byId(id)!;
    expect(row.stack).not.toBeNull();
    expect(row.error_message).toBeNull();
  });
});
