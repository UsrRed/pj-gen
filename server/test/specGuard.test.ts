import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import { HttpError } from '../src/core/httpError.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

async function seedDraft(c: Container, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const workspacePath = await c.ws.create(slug, title);
  const id = `${slug}-id`;
  c.repos.projects.insert({ id, slug, title, model: null, workspacePath, initialPrompt: `Projet ${title}` });
  return id;
}

describe('SpecService spam guard', () => {
  it('collapses concurrent generate-spec calls into a single generation', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedDraft(c, 'Spam Spec');

    await Promise.all(Array.from({ length: 6 }, () => c.spec.generateSpec(id)));

    const sessions = c.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND kind = 'cadrage'`).get(id) as { n: number };
    expect(sessions.n).toBe(1);
    const done = c.repos.messages.list(id).filter((m) => m.role === 'system' && m.content.includes('SPEC générée'));
    expect(done).toHaveLength(1);
    const started = c.repos.messages.list(id).filter((m) => m.role === 'system' && m.content.includes('Génération de la SPEC en cours'));
    expect(started).toHaveLength(1);
    expect(c.spec.isGenerating(id)).toBe(false);
    expect(c.repos.projects.byId(id)!.status).toBe('spec_ready');
  });

  it('rejects validate-spec with 409 while a generation is in flight', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedDraft(c, 'Race Validate');

    const generation = c.spec.generateSpec(id); // inFlight is set synchronously
    await expect(c.spec.validateSpec(id)).rejects.toThrowError(HttpError);
    await generation;

    // Once done, validation goes through normally.
    await c.spec.validateSpec(id);
    expect(c.repos.projects.byId(id)!.status).toBe('queued');
  });

  it('emits spec.status started/done events', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedDraft(c, 'Events Spec');
    await c.spec.generateSpec(id);
    const phases = (c.db.prepare(`SELECT payload FROM events WHERE type = 'spec.status' AND project_id = ? ORDER BY id`).all(id) as { payload: string }[]).map(
      (r) => (JSON.parse(r.payload) as { phase: string }).phase
    );
    expect(phases).toEqual(['started', 'done']);
  });
});
