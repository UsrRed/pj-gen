import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import type { FakeScript } from '../src/claude/fakeRunner.js';
import { fastScript, testContainer, tmpDir } from './helpers.js';

const execFileP = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'UsrRed', GIT_AUTHOR_EMAIL: 'redefendeur@gmail.com', GIT_COMMITTER_NAME: 'UsrRed', GIT_COMMITTER_EMAIL: 'redefendeur@gmail.com' };

/**
 * A push rejected as non-fast-forward is exactly what left real GitHub issues stuck in
 * 'fixing' forever (finalizeFixing calls github.push() on every tick with no reconciliation):
 * the project's local branch had drifted behind origin/main, so the same push failed the
 * same way on every retry. GithubService.push() must now recover on its own.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'UsrRed', GIT_AUTHOR_EMAIL: 'redefendeur@gmail.com', GIT_COMMITTER_NAME: 'UsrRed', GIT_COMMITTER_EMAIL: 'redefendeur@gmail.com' };
  const { stdout } = await execFileP('git', args, { cwd, env });
  return stdout;
}

describe('GithubService.push: auto-recovery from a diverged remote', () => {
  let cRef: Container | null = null;
  afterEach(() => {
    cRef?.close();
    cRef = null;
  });

  async function setup(script?: FakeScript) {
    const { c } = await testContainer({ script });
    cRef = c;
    const slug = 'push-retry';
    const workspacePath = await c.ws.create(slug, 'Push Retry');

    // Bare "origin" seeded from the workspace's initial commit.
    const originPath = path.join(tmpDir('origin'), 'origin.git');
    // -b main: otherwise the bare repo's HEAD symref stays on the (unborn) default branch,
    // and cloning it before any push lands the clone on an unrelated branch of its own.
    await git(path.dirname(originPath), ['init', '--bare', '-b', 'main', originPath]);
    await git(workspacePath, ['remote', 'add', 'origin', originPath]);
    await git(workspacePath, ['push', 'origin', 'HEAD:main']);

    // A second clone pushes an unrelated commit — origin now has one workspacePath never fetched.
    const otherClone = path.join(tmpDir('other'), 'clone');
    await git(path.dirname(otherClone), ['clone', originPath, otherClone]);
    fs.writeFileSync(path.join(otherClone, 'REMOTE.md'), 'from another clone\n');
    await git(otherClone, ['add', 'REMOTE.md']);
    await git(otherClone, ['commit', '-m', 'remote: unrelated addition']);
    await git(otherClone, ['push', 'origin', 'HEAD:main']);

    const id = 'push-retry-id';
    c.repos.projects.insert({ id, slug, title: 'Push Retry', model: null, workspacePath, initialPrompt: 'test' });
    c.repos.projects.casStatus(id, ['draft'], 'deployed');
    c.repos.projects.patch(id, { github_repo: 'usrred/push-retry', github_private: 1 });
    return { c, id, workspacePath };
  }

  it('fetches + merges once and retries on a plain non-fast-forward rejection', async () => {
    const { c, id, workspacePath } = await setup();
    // Local commit on an unrelated file: no textual conflict with the remote's REMOTE.md.
    fs.writeFileSync(path.join(workspacePath, 'LOCAL.md'), 'from the local workspace\n');
    await git(workspacePath, ['add', 'LOCAL.md']);
    await git(workspacePath, ['commit', '-m', 'local: unrelated addition']);

    await expect(c.github.push(id)).resolves.toBeDefined();

    expect(fs.existsSync(path.join(workspacePath, 'REMOTE.md'))).toBe(true); // merged in
    expect(fs.existsSync(path.join(workspacePath, 'LOCAL.md'))).toBe(true); // kept
    const project = c.repos.projects.byId(id)!;
    expect(project.github_last_push_sha).toBe((await git(workspacePath, ['rev-parse', 'HEAD'])).trim());
  });

  it('a genuine conflict aborts the merge and surfaces a clean error instead of a raw git stack', async () => {
    const { c, id, workspacePath } = await setup();
    // Local commit touching the SAME file the other clone already pushed a change for.
    fs.writeFileSync(path.join(workspacePath, 'REMOTE.md'), 'local override — never pushed yet\n');
    await git(workspacePath, ['add', 'REMOTE.md']);
    await git(workspacePath, ['commit', '-m', 'local: conflicting edit']);

    await expect(c.github.push(id)).rejects.toThrow(/conflit|résolution manuelle/i);
    // The failed merge attempt must not leave the workspace mid-merge.
    const status = await git(workspacePath, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
  });

  it('{ autoResolve: true } saves the local work to a recovery branch, resolves the conflict via a tool session, verifies it, then fast-forwards main', async () => {
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Un merge git est en cours')) {
        // Simulates the Claude session resolving the conflicted file and closing the merge.
        fs.writeFileSync(path.join(spec.cwd, 'REMOTE.md'), 'resolved by simulated session\n');
        execFileSync('git', ['add', '-A'], { cwd: spec.cwd, env: GIT_ENV });
        execFileSync('git', ['commit', '--no-edit'], { cwd: spec.cwd, env: GIT_ENV });
        return { result: { outcome: 'success' as const, resultText: 'conflit résolu (simulation)' } };
      }
      return undefined;
    });
    const { c, id, workspacePath } = await setup(script);
    fs.writeFileSync(path.join(workspacePath, 'REMOTE.md'), 'local override — never pushed yet\n');
    await git(workspacePath, ['add', 'REMOTE.md']);
    await git(workspacePath, ['commit', '-m', 'local: conflicting edit']);

    await expect(c.github.push(id, undefined, { autoResolve: true })).resolves.toBeDefined();

    expect((await git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(fs.readFileSync(path.join(workspacePath, 'REMOTE.md'), 'utf8')).toBe('resolved by simulated session\n');
    expect((await git(workspacePath, ['status', '--porcelain=v1'])).trim()).toBe('');
    const remoteBranches = await git(workspacePath, ['ls-remote', '--heads', 'origin']);
    expect(remoteBranches).toMatch(/refs\/heads\/auto\/main-conflict-/); // the recovery branch stays on GitHub as an audit trail
    const project = c.repos.projects.byId(id)!;
    expect(project.github_last_push_sha).toBe((await git(workspacePath, ['rev-parse', 'HEAD'])).trim());
  });

  it('{ autoResolve: true } preserves the local work on a pushed recovery branch when the automated resolution itself fails', async () => {
    // Default fake script: the simulated session returns success without touching git, so the merge never closes.
    const { c, id, workspacePath } = await setup();
    fs.writeFileSync(path.join(workspacePath, 'REMOTE.md'), 'local override — never pushed yet\n');
    await git(workspacePath, ['add', 'REMOTE.md']);
    await git(workspacePath, ['commit', '-m', 'local: conflicting edit']);

    await expect(c.github.push(id, undefined, { autoResolve: true })).rejects.toThrow(/auto\/main-conflict-/);

    // main is left exactly as before the attempt: on branch, no merge in progress, nothing lost.
    expect((await git(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await git(workspacePath, ['status', '--porcelain=v1'])).trim()).toBe('');
    const remoteBranches = await git(workspacePath, ['ls-remote', '--heads', 'origin']);
    expect(remoteBranches).toMatch(/refs\/heads\/auto\/main-conflict-/); // work saved remotely for manual review
  });
});
