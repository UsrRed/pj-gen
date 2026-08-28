import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProjectSummary } from '@pjgen/shared';
import type { Container } from '../src/container.js';
import { fastScript, testContainer, waitFor } from './helpers.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'UsrRed',
  GIT_AUTHOR_EMAIL: 'redefendeur@gmail.com',
  GIT_COMMITTER_NAME: 'UsrRed',
  GIT_COMMITTER_EMAIL: 'redefendeur@gmail.com',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...IDENTITY } }).toString();
}

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

/** Script that makes the fake claude session write .github/workflows/ci.yml, exactly what
 *  the real generate-ci session is asked to do (see GithubService.runCiGeneration's prompt). */
const ciWritingScript = fastScript((spec) => {
  if (spec.prompt.includes('.github/workflows/ci.yml')) {
    fs.mkdirSync(path.join(spec.cwd, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(spec.cwd, '.github/workflows/ci.yml'), 'name: CI\non: [push]\n');
  }
  return undefined;
});

/**
 * Fake `gh` CLI covering only what GithubService actually calls: `auth status`, `api user`
 * and `repo create <slug> ... --source . --push`. Good enough to exercise the real
 * `linkProject` flow without any network access or real GitHub auth.
 */
function writeFakeGh(binPath: string, remoteRoot: string): void {
  fs.mkdirSync(remoteRoot, { recursive: true });
  const script = `#!/usr/bin/env bash
set -e
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo "testuser"; exit 0; fi
if [ "$1" = "repo" ] && [ "$2" = "create" ]; then
  name="$3"
  bare="${remoteRoot}/$name.git"
  git init --bare -q "$bare"
  git remote remove origin >/dev/null 2>&1 || true
  git remote add origin "$bare"
  git push -q origin HEAD
  echo "https://github.com/testuser/$name"
  exit 0
fi
exit 1
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
}

describe('generate-ci: mise en attente sans lien GitHub', () => {
  it('renvoie "queued" (pas une erreur) et persiste la demande', async () => {
    const { c } = await testContainer({ script: ciWritingScript });
    cRef = c;
    const id = 'ci-pending-noop';
    const workspacePath = await c.ws.create(id, id);
    c.repos.projects.insert({ id, slug: id, title: id, model: null, workspacePath, initialPrompt: 'x' });

    await expect(c.github.generateCi(id)).resolves.toEqual({ status: 'queued' });
    expect(c.repos.projects.byId(id)!.github_ci_pending).toBe(1);

    // A repeated call while still unlinked stays queued (idempotent, no duplicate side effects).
    await expect(c.github.generateCi(id)).resolves.toEqual({ status: 'queued' });
  });

  it('déclenche automatiquement la génération du CI dès que le projet est lié (POST /github/link)', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pjgen-ghfake-'));
    const fakeGh = path.join(scratch, 'gh');
    writeFakeGh(fakeGh, path.join(scratch, 'remotes'));

    const { c } = await testContainer({ script: ciWritingScript, config: { ghBin: fakeGh } });
    cRef = c;
    const id = 'ci-pending-link';
    const workspacePath = await c.ws.create(id, id);
    c.repos.projects.insert({ id, slug: id, title: id, model: null, workspacePath, initialPrompt: 'x' });

    const updates: ProjectSummary[] = [];
    c.bus.subscribe({
      projectId: id,
      fn: (_evId, type, _projectId, payload) => {
        if (type === 'project.updated') updates.push((payload as { project: ProjectSummary }).project);
      },
    });

    // 1) No GitHub link yet: queued, not an error.
    await expect(c.github.generateCi(id)).resolves.toEqual({ status: 'queued' });
    expect(c.repos.projects.byId(id)!.github_ci_pending).toBe(1);
    expect(updates.some((p) => p.githubCiPending)).toBe(true);
    expect(fs.existsSync(path.join(workspacePath, '.github/workflows/ci.yml'))).toBe(false);

    // 2) Link the project — no manual generate-ci call afterwards.
    const linked = await c.github.linkProject(id);
    expect(linked.github_repo).toBe('testuser/ci-pending-link');

    // 3) The queued CI generation fires on its own and the workflow lands in the workspace.
    await waitFor(() => fs.existsSync(path.join(workspacePath, '.github/workflows/ci.yml')), 5000, 'ci.yml généré automatiquement');
    await waitFor(() => c.repos.projects.byId(id)!.github_ci_pending === 0, 5000, 'flag github_ci_pending retombé à 0');
    expect(updates.some((p) => p.github?.repo === 'testuser/ci-pending-link' && !p.githubCiPending)).toBe(true);
  });
});

describe('generate-ci: push non-fast-forward vers un remote divergé', () => {
  it('fetch + merge automatiquement puis pousse le workflow, sans intervention manuelle', async () => {
    const { c, base } = await testContainer({ script: ciWritingScript });
    cRef = c;
    const id = 'ci-nonff';
    const workspacePath = await c.ws.create(id, id);
    c.repos.projects.insert({ id, slug: id, title: id, model: null, workspacePath, initialPrompt: 'x' });
    c.repos.projects.patch(id, { github_repo: 'someone/repo' });

    // Bare "remote" seeded from the workspace's initial commit.
    const remoteDir = path.join(base, 'remote.git');
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ['init', '--bare', '-b', 'main']);
    git(workspacePath, ['remote', 'add', 'origin', remoteDir]);
    git(workspacePath, ['push', 'origin', 'HEAD']);

    // Remote gains a commit the workspace never fetched — the next generate-ci push
    // will be rejected as non-fast-forward.
    const otherClone = path.join(base, 'other-clone');
    git(base, ['clone', remoteDir, otherClone]);
    fs.writeFileSync(path.join(otherClone, 'remote-only.txt'), 'from remote\n');
    git(otherClone, ['add', '-A']);
    git(otherClone, ['commit', '-m', 'remote change']);
    git(otherClone, ['push', 'origin', 'HEAD']);

    await expect(c.github.generateCi(id)).resolves.toEqual({ status: 'generated' });

    const log = git(workspacePath, ['log', '--oneline', 'origin/main']);
    expect(log).toContain('remote change');
    expect(log).toContain('ci: add test workflow');
    expect(fs.existsSync(path.join(workspacePath, '.github/workflows/ci.yml'))).toBe(true);
  });

  it('a genuine merge conflict (T17) is resolved via a Claude session — no raw git error, no manual-resolution message', async () => {
    // The fake CLI script wears two hats: writing ci.yml on the first ("génération CI") session,
    // then resolving the merge conflict when GithubService.attemptAutoMergeResolution runs a
    // second, distinct ('merge_resolve') session.
    const script = fastScript((spec) => {
      if (spec.prompt.includes('.github/workflows/ci.yml')) {
        fs.mkdirSync(path.join(spec.cwd, '.github/workflows'), { recursive: true });
        fs.writeFileSync(path.join(spec.cwd, '.github/workflows/ci.yml'), 'name: CI\non: [push]\n');
        return undefined;
      }
      if (spec.prompt.includes('Un merge git est en cours')) {
        fs.writeFileSync(path.join(spec.cwd, '.github/workflows/ci.yml'), 'name: CI (resolved)\non: [push]\n');
        execFileSync('git', ['add', '-A'], { cwd: spec.cwd, env: { ...process.env, ...IDENTITY } });
        execFileSync('git', ['commit', '--no-edit'], { cwd: spec.cwd, env: { ...process.env, ...IDENTITY } });
        return { result: { outcome: 'success' as const, resultText: 'conflit résolu (simulation)' } };
      }
      return undefined;
    });
    const { c, base } = await testContainer({ script });
    cRef = c;
    const id = 'ci-conflict';
    const workspacePath = await c.ws.create(id, id);
    c.repos.projects.insert({ id, slug: id, title: id, model: null, workspacePath, initialPrompt: 'x' });
    c.repos.projects.patch(id, { github_repo: 'someone/repo' });

    const remoteDir = path.join(base, 'remote-conflict.git');
    fs.mkdirSync(remoteDir, { recursive: true });
    git(remoteDir, ['init', '--bare', '-b', 'main']);
    git(workspacePath, ['remote', 'add', 'origin', remoteDir]);
    git(workspacePath, ['push', 'origin', 'HEAD']);

    // Remote gains a commit on .github/workflows/ci.yml — the same path the CI-generation
    // session writes to — so the eventual merge is a genuine, textual conflict.
    const otherClone = path.join(base, 'other-clone-conflict');
    git(base, ['clone', remoteDir, otherClone]);
    fs.mkdirSync(path.join(otherClone, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(otherClone, '.github/workflows/ci.yml'), 'name: pre-existing remote CI\non: [push]\n');
    git(otherClone, ['add', '-A']);
    git(otherClone, ['commit', '-m', 'remote: add its own ci.yml']);
    git(otherClone, ['push', 'origin', 'HEAD']);

    await expect(c.github.generateCi(id)).resolves.toEqual({ status: 'generated' });

    // Resolved via the Claude session, not left mid-merge, not a plain "résolution manuelle" bail-out.
    expect(fs.readFileSync(path.join(workspacePath, '.github/workflows/ci.yml'), 'utf8')).toBe('name: CI (resolved)\non: [push]\n');
    expect(fs.existsSync(path.join(workspacePath, '.git', 'MERGE_HEAD'))).toBe(false);
    const log = git(workspacePath, ['log', '--oneline', 'origin/main']);
    expect(log).toContain('remote: add its own ci.yml');
  });
});
