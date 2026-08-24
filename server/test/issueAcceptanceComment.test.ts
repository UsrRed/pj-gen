import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { AI_MARKER } from '../src/github/issuePoller.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

async function seedProjectWithIssue(c: Container, githubRepo: string | null): Promise<{ projectId: string; issueId: number }> {
  const slug = 'issue-comment-test';
  const workspacePath = await c.ws.create(slug, 'Issue Comment Test');
  const projectId = `${slug}-id`;
  c.repos.projects.insert({ id: projectId, slug, title: 'Issue Comment Test', model: null, workspacePath, initialPrompt: 'test' });
  if (githubRepo) c.repos.projects.patch(projectId, { github_repo: githubRepo });
  const { row } = c.repos.issues.upsert(projectId, {
    number: 42,
    title: 'Bug important',
    body: 'corps',
    author: 'alice',
    ghUpdatedAt: '2026-07-01T00:00:00Z',
  });
  return { projectId, issueId: row.id };
}

describe('POST /api/issues/:id/decision — commentaire de prise en compte', () => {
  it('poste un commentaire GitHub quand la décision est "queued" (acceptation)', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { issueId } = await seedProjectWithIssue(c, 'octo/repo');
    const issueComment = vi.spyOn(c.github, 'issueComment').mockResolvedValue(undefined);

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'POST', url: `/api/issues/${issueId}/decision`, payload: { decision: 'queued' } });

    expect(res.statusCode).toBe(200);
    expect(issueComment).toHaveBeenCalledTimes(1);
    expect(issueComment.mock.calls[0][0]).toBe('octo/repo');
    expect(issueComment.mock.calls[0][1]).toBe(42);
    expect(issueComment.mock.calls[0][2]).toContain(AI_MARKER);
  });

  it('ne poste aucun commentaire quand la décision est "skipped" (rejet)', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { issueId } = await seedProjectWithIssue(c, 'octo/repo');
    const issueComment = vi.spyOn(c.github, 'issueComment').mockResolvedValue(undefined);

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'POST', url: `/api/issues/${issueId}/decision`, payload: { decision: 'skipped' } });

    expect(res.statusCode).toBe(200);
    expect(issueComment).not.toHaveBeenCalled();
  });

  it("un échec de l'appel GitHub est loggé mais ne fait pas échouer la décision", async () => {
    const { c } = await testContainer();
    cRef = c;
    const { issueId } = await seedProjectWithIssue(c, 'octo/repo');
    vi.spyOn(c.github, 'issueComment').mockRejectedValue(new Error('gh api error'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'POST', url: `/api/issues/${issueId}/decision`, payload: { decision: 'queued' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe('queued');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('ne tente pas de commenter si le projet n\'est pas lié à un dépôt GitHub', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { issueId } = await seedProjectWithIssue(c, null);
    const issueComment = vi.spyOn(c.github, 'issueComment').mockResolvedValue(undefined);

    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'POST', url: `/api/issues/${issueId}/decision`, payload: { decision: 'queued' } });

    expect(res.statusCode).toBe(200);
    expect(issueComment).not.toHaveBeenCalled();
  });
});
