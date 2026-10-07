import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { testContainer, tmpDir } from './helpers.js';

const execFileP = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'UsrRed', GIT_AUTHOR_EMAIL: 'redefendeur@gmail.com', GIT_COMMITTER_NAME: 'UsrRed', GIT_COMMITTER_EMAIL: 'redefendeur@gmail.com' };
  return (await execFileP('git', args, { cwd, env })).stdout;
}

/** Commits pushed straight to the repo (outside pj-gen) must reach the workspace without anyone clicking. */
describe('RepoSync / GithubService.pullIfBehind', () => {
  let cRef: Container | null = null;
  afterEach(() => {
    cRef?.close();
    cRef = null;
  });

  async function setup(status: 'deployed' | 'building' = 'deployed') {
    const { c } = await testContainer({});
    cRef = c;
    const workspacePath = await c.ws.create('sync', 'Sync');
    const originPath = path.join(tmpDir('origin'), 'origin.git');
    await git(path.dirname(originPath), ['init', '--bare', '-b', 'main', originPath]);
    await git(workspacePath, ['remote', 'add', 'origin', originPath]);
    await git(workspacePath, ['push', 'origin', 'HEAD:main']);
    const other = path.join(tmpDir('other'), 'clone');
    await git(path.dirname(other), ['clone', originPath, other]);
    const pushRemote = async (file: string, content: string) => {
      fs.writeFileSync(path.join(other, file), content);
      await git(other, ['add', file]);
      await git(other, ['commit', '-m', `remote: ${file}`]);
      await git(other, ['push', 'origin', 'HEAD:main']);
    };
    c.repos.projects.insert({ id: 'sync-id', slug: 'sync', title: 'Sync', model: null, workspacePath, initialPrompt: 'test' });
    c.repos.projects.casStatus('sync-id', ['draft'], status === 'building' ? 'building' : 'deployed');
    c.repos.projects.patch('sync-id', { github_repo: 'usrred/sync', github_private: 1 });
    return { c, workspacePath, pushRemote };
  }

  it('does nothing when already up to date', async () => {
    const { c } = await setup();
    await expect(c.github.pullIfBehind('sync-id')).resolves.toBe('uptodate');
  });

  it('fast-forwards a workspace that has no commit of its own', async () => {
    const { c, workspacePath, pushRemote } = await setup();
    await pushRemote('REMOTE.md', 'a\n');
    await expect(c.github.pullIfBehind('sync-id')).resolves.toBe('fast-forward');
    expect(fs.existsSync(path.join(workspacePath, 'REMOTE.md'))).toBe(true);
  });

  it('merges when both sides moved on different files', async () => {
    const { c, workspacePath, pushRemote } = await setup();
    await pushRemote('REMOTE.md', 'a\n');
    fs.writeFileSync(path.join(workspacePath, 'LOCAL.md'), 'b\n');
    await git(workspacePath, ['add', 'LOCAL.md']);
    await git(workspacePath, ['commit', '-m', 'local']);
    await expect(c.github.pullIfBehind('sync-id')).resolves.toBe('merged');
    expect(fs.existsSync(path.join(workspacePath, 'REMOTE.md'))).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, 'LOCAL.md'))).toBe(true);
    expect(await git(workspacePath, ['status', '--porcelain'])).toBe('');
  });

  it('aborts a conflicting merge and leaves the workspace untouched', async () => {
    const { c, workspacePath, pushRemote } = await setup();
    await pushRemote('SAME.md', 'remote\n');
    fs.writeFileSync(path.join(workspacePath, 'SAME.md'), 'local\n');
    await git(workspacePath, ['add', 'SAME.md']);
    await git(workspacePath, ['commit', '-m', 'local']);
    const head = await git(workspacePath, ['rev-parse', 'HEAD']);
    await expect(c.github.pullIfBehind('sync-id')).resolves.toBe('conflict');
    expect(await git(workspacePath, ['rev-parse', 'HEAD'])).toBe(head);
    expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(workspacePath, 'SAME.md'), 'utf8')).toBe('local\n');
  });

  it('skips a workspace with uncommitted changes, or one a session is building in', async () => {
    const { c, workspacePath, pushRemote } = await setup();
    await pushRemote('REMOTE.md', 'a\n');
    fs.writeFileSync(path.join(workspacePath, 'WIP.md'), 'wip\n');
    await expect(c.github.pullIfBehind('sync-id')).resolves.toBe('skipped');
    expect(fs.existsSync(path.join(workspacePath, 'REMOTE.md'))).toBe(false);

    const busy = await setup('building');
    await busy.pushRemote('REMOTE.md', 'a\n');
    await expect(busy.c.github.pullIfBehind('sync-id')).resolves.toBe('skipped');
  });

  it('RepoSync.runOnce covers every published project and ignores the others', async () => {
    const { c, workspacePath, pushRemote } = await setup();
    c.repos.projects.insert({ id: 'local-only', slug: 'lo', title: 'Lo', model: null, workspacePath: await c.ws.create('lo', 'Lo'), initialPrompt: 't' });
    await pushRemote('REMOTE.md', 'a\n');
    expect(await c.repoSync.runOnce()).toEqual({ 'sync-id': 'fast-forward' });
    expect(fs.existsSync(path.join(workspacePath, 'REMOTE.md'))).toBe(true);
  });
});
