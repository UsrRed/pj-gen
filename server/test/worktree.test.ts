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

    expect(await wt.merge(workspace, 'T01', 'A')).toBe('merged');
    expect(await wt.merge(workspace, 'T02', 'B')).toBe('merged');

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

    expect(await wt.merge(workspace, 'T01', 'A')).toBe('merged');
    const headBefore = await ws.headSha(workspace);

    expect(await wt.merge(workspace, 'T02', 'B')).toBe('conflict');
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

    expect(await wt.merge(workspace, 'T01', 'A')).toBe('merged');
    expect(await wt.merge(workspace, 'T02', 'B')).toBe('merged');

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
