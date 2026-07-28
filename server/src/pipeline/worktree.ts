import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';

const execFileP = promisify(execFile);

/**
 * Git worktrees for parallel task implementation.
 *
 * Each task in a batch works on its own branch `pjgen/<taskKey>` in its own checkout,
 * and the orchestrator merges it into main as soon as it succeeds.
 *
 * Worktrees live OUTSIDE every workspace (`<workspaceRoot>/.wt/<slug>/<taskKey>`):
 * a nested worktree would be swept up by `commitAll`'s `git add -A` and would show up
 * in the artifacts tree. `SLUG_RE` forbids a leading dot, so `.wt` can never collide
 * with a project slug.
 *
 * Worktrees share `.git/config` and `.git/hooks` with the main workspace, so the
 * UsrRed identity and the commit-msg attribution hook apply inside them for free.
 */
export class WorktreeManager {
  constructor(private config: Config) {}

  private root(slug: string): string {
    return path.join(this.config.workspaceRoot, '.wt', slug);
  }

  dirFor(slug: string, taskKey: string): string {
    return path.join(this.root(slug), taskKey);
  }

  branchFor(taskKey: string): string {
    return `pjgen/${taskKey}`;
  }

  /**
   * Environment carrying the UsrRed identity. EVERY git call that can create a commit
   * must use it — a merge made without it is authored by the machine's git identity and
   * fails the attribution audit at final_verify, sinking the whole build.
   */
  private gitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_AUTHOR_NAME: this.config.gitAuthorName,
      GIT_AUTHOR_EMAIL: this.config.gitAuthorEmail,
      GIT_COMMITTER_NAME: this.config.gitAuthorName,
      GIT_COMMITTER_EMAIL: this.config.gitAuthorEmail,
    };
  }

  private git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileP('git', args, { cwd, env: this.gitEnv(), maxBuffer: 8 * 1024 * 1024 });
  }

  /**
   * Creates (or reattaches to) the worktree for a task. Idempotent: after a quota park
   * the resume must land in the SAME tree, not a fresh one on a different HEAD.
   */
  async ensure(workspace: string, slug: string, taskKey: string): Promise<string> {
    const dir = this.dirFor(slug, taskKey);
    if (fs.existsSync(path.join(dir, '.git'))) {
      await this.linkDeps(workspace, dir);
      return dir;
    }
    fs.mkdirSync(this.root(slug), { recursive: true });
    // A stale registration (directory deleted under us) blocks `worktree add`.
    await this.git(workspace, ['worktree', 'prune']).catch(() => undefined);

    const branch = this.branchFor(taskKey);
    const branchExists = await this.git(workspace, ['rev-parse', '--verify', branch]).then(
      () => true,
      () => false
    );
    const args = branchExists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, 'HEAD'];
    await this.git(workspace, args);
    await this.linkDeps(workspace, dir);
    return dir;
  }

  /**
   * Symlinks the installed dependency trees from the main workspace. Batched tasks never
   * run an install (their verifyKinds is ['test'], and any task touching a manifest is
   * forced solo by pickBatch), so nothing writes through these links concurrently.
   */
  private async linkDeps(workspace: string, dir: string): Promise<void> {
    for (const name of ['node_modules', '.venv', 'vendor']) {
      const src = path.join(workspace, name);
      const dest = path.join(dir, name);
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
      try {
        fs.symlinkSync(src, dest, 'dir');
      } catch {
        /* a missing link only costs a slower test run */
      }
    }
    // .env is gitignored, so the worktree checkout does not carry it.
    const env = path.join(workspace, '.env');
    if (fs.existsSync(env) && !fs.existsSync(path.join(dir, '.env'))) {
      try {
        fs.symlinkSync(env, path.join(dir, '.env'), 'file');
      } catch {
        /* optional */
      }
    }
  }

  /**
   * Merges a task branch into the main workspace. Runs in the MAIN workspace and must be
   * serialised by the caller.
   *
   * A conflict is never fatal: the merge is aborted, main is left untouched, and the
   * caller requeues the task to be re-run alone on the updated HEAD. Worst case the
   * build degrades to the serial behaviour it had before parallelism existed.
   */
  async merge(workspace: string, taskKey: string, title: string): Promise<'merged' | 'conflict' | 'noop'> {
    const branch = this.branchFor(taskKey);
    const before = await this.headSha(workspace);
    try {
      const { stdout } = await this.git(workspace, ['merge', '--no-ff', '-m', `merge(${taskKey}): ${title}`, branch]);
      if (/already up to date|déjà à jour/i.test(stdout)) return 'noop';
      const after = await this.headSha(workspace);
      return after !== before ? 'merged' : 'noop';
    } catch {
      await this.git(workspace, ['merge', '--abort']).catch(() => undefined);
      return 'conflict';
    }
  }

  async headSha(workspace: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(workspace, ['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** Removes one worktree and its branch. Safe to call when neither exists. */
  async remove(workspace: string, slug: string, taskKey: string): Promise<void> {
    const dir = this.dirFor(slug, taskKey);
    await this.git(workspace, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    await this.git(workspace, ['branch', '-D', this.branchFor(taskKey)]).catch(() => undefined);
    await this.git(workspace, ['worktree', 'prune']).catch(() => undefined);
  }

  /** Drops every worktree except those whose task key is in `keep`. */
  async sweep(workspace: string, slug: string, keep: string[]): Promise<void> {
    const root = this.root(slug);
    const kept = new Set(keep);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return; // nothing was ever created
    }
    for (const taskKey of entries) {
      if (!kept.has(taskKey)) await this.remove(workspace, slug, taskKey);
    }
    if (!kept.size) fs.rmSync(root, { recursive: true, force: true });
  }
}
