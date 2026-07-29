import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WorkspaceManager } from '../src/pipeline/workspace.js';
import { WorktreeManager } from '../src/pipeline/worktree.js';
import { auditCommits } from '../src/pipeline/attribution.js';
import { testConfig, tmpDir } from './helpers.js';

const execFileP = promisify(execFile);

async function seed(slug = 'wt-proj') {
  const base = tmpDir('wt');
  const config = testConfig(base, { fakeCli: false });
  fs.mkdirSync(config.workspaceRoot, { recursive: true });
  const ws = new WorkspaceManager(config);
  const wt = new WorktreeManager(config);
  const workspace = await ws.create(slug, 'Worktree Test');
  return { config, ws, wt, workspace, slug };
}

/** Commits a file inside a worktree using its own git config (inherited from the main repo). */
async function commitIn(dir: string, file: string, content: string, message: string) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await execFileP('git', ['add', '-A'], { cwd: dir });
  await execFileP('git', ['commit', '-m', message], { cwd: dir });
}

describe('WorktreeManager', () => {
  it('creates worktrees outside every workspace so commitAll never sweeps them up', async () => {
    const { config, wt, workspace, slug, ws } = await seed();
    const dir = await wt.ensure(workspace, slug, 'T01');

    expect(dir.startsWith(path.join(config.workspaceRoot, '.wt'))).toBe(true);
    expect(dir.startsWith(workspace + path.sep)).toBe(false);

    // The main workspace sees nothing new.
    await ws.commitAll(workspace, 'noop');
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: workspace });
    expect(stdout.trim()).toBe('');
  });

  it('ensure is idempotent — a resume after a park reattaches the same tree', async () => {
    const { wt, workspace, slug } = await seed();
    const first = await wt.ensure(workspace, slug, 'T01');
    await commitIn(first, 'src/a.ts', 'export const a = 1;\n', 'feat(T01): a');
    const { stdout: headA } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: first });

    const second = await wt.ensure(workspace, slug, 'T01');
    expect(second).toBe(first);
    const { stdout: headB } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd: second });
    expect(headB).toBe(headA); // the in-progress commit survived
  });

  it('merges two disjoint branches and keeps the UsrRed attribution', async () => {
    const { wt, workspace, slug } = await seed();
    const a = await wt.ensure(workspace, slug, 'T01');
    const b = await wt.ensure(workspace, slug, 'T02');
    await commitIn(a, 'src/a.ts', 'export const a = 1;\n', 'feat(T01): a');
    await commitIn(b, 'src/b.ts', 'export const b = 2;\n', 'feat(T02): b');

    expect((await wt.merge(workspace, 'T01', 'A')).outcome).toBe('merged');
    expect((await wt.merge(workspace, 'T02', 'B')).outcome).toBe('merged');

    expect(fs.existsSync(path.join(workspace, 'src/a.ts'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'src/b.ts'))).toBe(true);

    // The merge commits must be authored UsrRed: otherwise final_verify's audit sinks the build.
    const audit = await auditCommits(workspace);
    expect(audit.issues).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('aborts a conflicting merge and leaves main untouched', async () => {
    const { wt, workspace, slug, ws } = await seed();
    const a = await wt.ensure(workspace, slug, 'T01');
    const b = await wt.ensure(workspace, slug, 'T02');
    await commitIn(a, 'src/same.ts', 'from A\n', 'feat(T01): same');
    await commitIn(b, 'src/same.ts', 'from B\n', 'feat(T02): same');

    expect((await wt.merge(workspace, 'T01', 'A')).outcome).toBe('merged');
    const headBefore = await ws.headSha(workspace);

    expect((await wt.merge(workspace, 'T02', 'B')).outcome).toBe('conflict');
    // Main is exactly where it was, and the tree is clean (no half-merge left behind).
    expect(await ws.headSha(workspace)).toBe(headBefore);
    const { stdout } = await execFileP('git', ['status', '--porcelain'], { cwd: workspace });
    expect(stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(workspace, 'src/same.ts'), 'utf8')).toBe('from A\n');
  });

  it('merges concurrent PROGRESS.md appends without conflict (merge=union)', async () => {
    const { wt, workspace, slug } = await seed();
    const a = await wt.ensure(workspace, slug, 'T01');
    const b = await wt.ensure(workspace, slug, 'T02');
    // Both worktrees append to the shared append-only progress log.
    fs.appendFileSync(path.join(a, 'docs/PROGRESS.md'), '- depuis A\n');
    await execFileP('git', ['commit', '-am', 'chore(T01): progress'], { cwd: a });
    fs.appendFileSync(path.join(b, 'docs/PROGRESS.md'), '- depuis B\n');
    await execFileP('git', ['commit', '-am', 'chore(T02): progress'], { cwd: b });

    expect((await wt.merge(workspace, 'T01', 'A')).outcome).toBe('merged');
    expect((await wt.merge(workspace, 'T02', 'B')).outcome).toBe('merged');

    const progress = fs.readFileSync(path.join(workspace, 'docs/PROGRESS.md'), 'utf8');
    expect(progress).toContain('- depuis A');
    expect(progress).toContain('- depuis B');
  });

  it('remove and sweep leave no residue', async () => {
    const { config, wt, workspace, slug } = await seed();
    await wt.ensure(workspace, slug, 'T01');
    await wt.ensure(workspace, slug, 'T02');
    const root = path.join(config.workspaceRoot, '.wt', slug);
    expect(fs.readdirSync(root).sort()).toEqual(['T01', 'T02']);

    await wt.sweep(workspace, slug, ['T02']);
    expect(fs.readdirSync(root)).toEqual(['T02']);

    await wt.sweep(workspace, slug, []);
    expect(fs.existsSync(root)).toBe(false);
    const { stdout } = await execFileP('git', ['branch', '--list', 'pjgen/*'], { cwd: workspace });
    expect(stdout.trim()).toBe('');
  });

  it('sweep on a project that never used worktrees is a no-op', async () => {
    const { wt, workspace, slug } = await seed();
    await expect(wt.sweep(workspace, slug, [])).resolves.toBeUndefined();
  });
});

/**
 * Regression: the exact chain that silently dropped feature F2 from the `emeline` build.
 * A merge failure left a directory behind that no later `ensure` could reuse, and the
 * "reprise en série" the log claimed was never actually performed.
 */
describe('WorktreeManager — robustesse (régression emeline/F2)', () => {
  it('recreates a worktree over a leftover directory that has no .git', async () => {
    const { wt, workspace, slug } = await seed();
    const dir = await wt.ensure(workspace, slug, 'T10');
    await commitIn(dir, 'src/a.ts', 'export const a = 1;\n', 'feat(T10): a');

    // Reproduce the exact leftover: git's checkout is gone, a build artefact remains.
    await execFileP('git', ['worktree', 'remove', '--force', dir], { cwd: workspace });
    fs.mkdirSync(path.join(dir, '.next'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.next', 'build-manifest.json'), '{}');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);

    // Before the fix this threw "fatal: '<dir>' already exists" on every attempt, forever.
    const again = await wt.ensure(workspace, slug, 'T10');
    expect(again).toBe(dir);
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(true);
  });

  it('remove() cleans up the branch even when the directory cannot be deleted', async () => {
    const { wt, workspace, slug } = await seed();
    const dir = await wt.ensure(workspace, slug, 'T10');
    expect((await execFileP('git', ['branch', '--list', 'pjgen/T10'], { cwd: workspace })).stdout.trim()).not.toBe('');

    const gone = await wt.remove(workspace, slug, 'T10');
    expect(gone).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // The branch cleanup used to be skipped whenever rmSync threw, stranding the branch.
    expect((await execFileP('git', ['branch', '--list', 'pjgen/T10'], { cwd: workspace })).stdout.trim()).toBe('');
  });

  it('remove() is idempotent and never throws', async () => {
    const { wt, workspace, slug } = await seed();
    await wt.ensure(workspace, slug, 'T10');
    await expect(wt.remove(workspace, slug, 'T10')).resolves.toBe(true);
    await expect(wt.remove(workspace, slug, 'T10')).resolves.toBe(true);
    await expect(wt.remove(workspace, slug, 'T99')).resolves.toBe(true);
  });

  it('reports a dirty main workspace as an error, NOT as a content conflict', async () => {
    const { wt, workspace, slug } = await seed();
    const dir = await wt.ensure(workspace, slug, 'T10');
    await commitIn(dir, 'src/a.ts', 'export const a = 1;\n', 'feat(T10): a');

    // This is what runBatch used to do: append to PROGRESS.md without committing.
    fs.appendFileSync(path.join(workspace, 'docs/PROGRESS.md'), '- lot parallèle: T10\n');
    // Make the merge actually touch the dirty file so git refuses.
    await commitIn(dir, 'docs/PROGRESS.md', '# Progression\n\n- depuis T10\n', 'chore(T10): progress');

    const r = await wt.merge(workspace, 'T10', 'A');
    expect(r.outcome).toBe('error'); // used to be reported as 'conflict' — a misdiagnosis
    expect(r.detail.length).toBeGreaterThan(0);
    // main must be left untouched and mergeable once committed.
    await execFileP('git', ['checkout', '--', 'docs/PROGRESS.md'], { cwd: workspace });
    expect((await wt.merge(workspace, 'T10', 'A')).outcome).toBe('merged');
  });

  it('still reports a real content conflict as a conflict', async () => {
    const { wt, workspace, slug } = await seed();
    const a = await wt.ensure(workspace, slug, 'T01');
    const b = await wt.ensure(workspace, slug, 'T02');
    await commitIn(a, 'src/same.ts', 'from A\n', 'feat(T01): same');
    await commitIn(b, 'src/same.ts', 'from B\n', 'feat(T02): same');
    expect((await wt.merge(workspace, 'T01', 'A')).outcome).toBe('merged');
    expect((await wt.merge(workspace, 'T02', 'B')).outcome).toBe('conflict');
  });
});
