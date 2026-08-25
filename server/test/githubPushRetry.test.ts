import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { testContainer } from './helpers.js';
import { HttpError } from '../src/core/httpError.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

const IDENTITY = {
  GIT_AUTHOR_NAME: 'UsrRed',
  GIT_AUTHOR_EMAIL: 'redefendeur@gmail.com',
  GIT_COMMITTER_NAME: 'UsrRed',
  GIT_COMMITTER_EMAIL: 'redefendeur@gmail.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY } }).toString();
}

/** Sets up a workspace project pushed once to a bare "remote", ready to diverge. */
async function setupProject(id: string) {
  const { c, base } = await testContainer();
  cRef = c;
  const workspacePath = await c.ws.create(id, id);
  c.repos.projects.insert({ id, slug: id, title: id, model: null, workspacePath, initialPrompt: 'x' });
  c.repos.projects.patch(id, { github_repo: 'someone/repo' });

  const remoteDir = path.join(base, 'remote.git');
  fs.mkdirSync(remoteDir, { recursive: true });
  git(remoteDir, ['init', '--bare', '-b', 'main']);
  git(workspacePath, ['remote', 'add', 'origin', remoteDir]);
  git(workspacePath, ['push', 'origin', 'HEAD']);

  // A second clone simulates changes landing on the remote from elsewhere.
  const otherClone = path.join(base, 'other-clone');
  git(base, ['clone', remoteDir, otherClone]);
  git(otherClone, ['config', 'user.name', 'UsrRed']);
  git(otherClone, ['config', 'user.email', 'redefendeur@gmail.com']);

  return { c, workspacePath, remoteDir, otherClone };
}

describe('github push: non-fast-forward retry', () => {
  it('auto-merges and retries once when the divergence is conflict-free', async () => {
    const id = 'push-ff-ok';
    const { c, workspacePath, otherClone } = await setupProject(id);

    // Remote gains a commit on a file the workspace never touched.
    fs.writeFileSync(path.join(otherClone, 'remote-only.txt'), 'from remote\n');
    git(otherClone, ['add', '-A']);
    git(otherClone, ['commit', '-m', 'remote change']);
    git(otherClone, ['push', 'origin', 'HEAD']);

    // Local workspace gains its own unrelated commit, unaware of the remote one.
    fs.writeFileSync(path.join(workspacePath, 'local-only.txt'), 'from local\n');
    await c.ws.commitAll(workspacePath, 'local change');

    await expect(c.github.push(id)).resolves.toBeTruthy();

    const log = git(workspacePath, ['log', '--oneline', 'origin/main']);
    expect(log).toContain('local change');
    expect(log).toContain('remote change');
    expect(fs.existsSync(path.join(workspacePath, 'remote-only.txt'))).toBe(true);
  });

  it('returns a clean French error and logs it when the auto-merge conflicts', async () => {
    const id = 'push-conflict';
    const { c, workspacePath, otherClone } = await setupProject(id);

    const target = path.join(otherClone, 'shared.txt');
    fs.writeFileSync(target, 'remote version\n');
    git(otherClone, ['add', '-A']);
    git(otherClone, ['commit', '-m', 'remote edits shared.txt']);
    git(otherClone, ['push', 'origin', 'HEAD']);

    fs.writeFileSync(path.join(workspacePath, 'shared.txt'), 'local version\n');
    await c.ws.commitAll(workspacePath, 'local edits shared.txt');

    const appLogs: string[] = [];
    c.bus.subscribe({
      projectId: id,
      fn: (_id, type, _projectId, payload) => {
        if (type === 'app.log') appLogs.push(...(payload as { lines: string[] }).lines);
      },
    });

    await expect(c.github.push(id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('conflit'),
    });
    await expect(c.github.push(id)).rejects.toBeInstanceOf(HttpError);
    expect(appLogs.some((l) => l.includes('conflit'))).toBe(true);

    // The workspace is left clean (merge aborted), not mid-conflict.
    const status = git(workspacePath, ['status', '--porcelain']);
    expect(status.trim()).toBe('');
  });

  it('leaves other push failures untouched (not a non-fast-forward rejection)', async () => {
    const id = 'push-other-error';
    const { c, workspacePath } = await setupProject(id);
    git(workspacePath, ['remote', 'set-url', 'origin', '/nonexistent/path/to/repo.git']);

    await expect(c.github.push(id)).rejects.not.toBeInstanceOf(HttpError);
  });
});
