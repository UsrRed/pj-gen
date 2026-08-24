import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { testContainer } from './helpers.js';

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

describe('POST /api/projects — validation des entrées', () => {
  it('refuse un title absent, ne crée aucun projet, et laisse le serveur opérationnel', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { initialPrompt: 'Construire une app' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/title/);
    expect(cRef!.repos.projects.all()).toHaveLength(0);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });

  it('refuse un title vide, ne crée aucun projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: '', initialPrompt: 'Construire une app' },
    });
    expect(res.statusCode).toBe(400);
    expect(cRef!.repos.projects.all()).toHaveLength(0);
  });

  it('refuse un size hors enum, ne crée aucun projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Projet Test', initialPrompt: 'Construire une app', size: 'gigantic' },
    });
    expect(res.statusCode).toBe(400);
    expect(cRef!.repos.projects.all()).toHaveLength(0);
  });

  it('refuse un model hors enum, ne crée aucun projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Projet Test', initialPrompt: 'Construire une app', model: 'gpt-4' },
    });
    expect(res.statusCode).toBe(400);
    expect(cRef!.repos.projects.all()).toHaveLength(0);
  });

  it('refuse un initialPrompt non-string, ne crée aucun projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Projet Test', initialPrompt: 12345 },
    });
    expect(res.statusCode).toBe(400);
    expect(cRef!.repos.projects.all()).toHaveLength(0);
  });

  it('refuse un initialPrompt excessivement long, ne crée aucun projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Projet Test', initialPrompt: 'x'.repeat(20_001) },
    });
    expect(res.statusCode).toBe(400);
    expect(cRef!.repos.projects.all()).toHaveLength(0);
  });

  it('reste opérationnel (GET /api/health = 200) après une salve de requêtes invalides', async () => {
    const app = await setup();
    await app.inject({ method: 'POST', url: '/api/projects', payload: { initialPrompt: 'x' } });
    await app.inject({ method: 'POST', url: '/api/projects', payload: { title: '', initialPrompt: 'x' } });
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 't', initialPrompt: 'x', size: 'nope' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 't', initialPrompt: 'x', model: 'nope' },
    });
    expect(cRef!.repos.projects.all()).toHaveLength(0);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
  });

  it('accepte un payload valide et crée le projet', async () => {
    const app = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { title: 'Projet Valide', initialPrompt: 'Construire une app', size: 'mvp', model: 'sonnet' },
    });
    expect(res.statusCode).toBe(201);
    expect(cRef!.repos.projects.all()).toHaveLength(1);
  });
});
