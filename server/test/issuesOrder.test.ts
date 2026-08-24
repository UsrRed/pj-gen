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

async function seedProjectWithIssues(c: Container, slug: string, title: string, numbers: number[]): Promise<string> {
  const workspacePath = await c.ws.create(slug, title);
  const id = `${slug}-id`;
  c.repos.projects.insert({ id, slug, title, model: null, workspacePath, initialPrompt: 'test' });
  for (const number of numbers) {
    c.repos.issues.upsert(id, {
      number,
      title: `Issue ${number}`,
      body: 'corps',
      author: 'alice',
      ghUpdatedAt: `2026-07-${String(number).padStart(2, '0')}T00:00:00Z`,
    });
  }
  return id;
}

describe('GET /api/issues ordering', () => {
  it('scoped to a project: ascending by number, lowest first', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedProjectWithIssues(c, 'proj-a', 'Proj A', [5, 1, 3]);

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'GET', url: `/api/issues?projectId=${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues.map((i: { number: number }) => i.number)).toEqual([1, 3, 5]);
  });

  it('unscoped (all projects): ascending by number, lowest first', async () => {
    const { c } = await testContainer();
    cRef = c;
    await seedProjectWithIssues(c, 'proj-b', 'Proj B', [9, 2]);

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'GET', url: '/api/issues' });
    expect(res.statusCode).toBe(200);
    expect(res.json().issues.map((i: { number: number }) => i.number)).toEqual([2, 9]);
  });
});
