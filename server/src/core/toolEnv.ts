import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';

/**
 * Environment shared by every tooling process pj-gen spawns: claude sessions
 * (which run install/build commands themselves), verifyStack, and the preview runner.
 *
 * Two distinct wins:
 *  - Shared package-manager caches. Each generated project is a fresh git repo with
 *    node_modules gitignored, so without a common store every project — and, once
 *    parallel worktrees exist, every worktree — pays a full cold download.
 *  - CI=1. Test runners (vitest, jest, ...) default to WATCH mode outside CI: a
 *    generated project whose test_cmd is `vitest` would sit until the 10-minute
 *    verification timeout on every single attempt of every task.
 */
export interface ToolEnvOpts {
  /** Set CI=1. False for the preview runner, whose whole point is a watching dev server. */
  ci?: boolean;
}

export function toolEnv(config: Config, opts: ToolEnvOpts = {}): NodeJS.ProcessEnv {
  const c = config.cacheDir;
  const env: NodeJS.ProcessEnv = {
    // npm / pnpm / yarn
    npm_config_cache: path.join(c, 'npm'),
    npm_config_store_dir: path.join(c, 'pnpm'),
    YARN_CACHE_FOLDER: path.join(c, 'yarn'),
    // Pure noise on every install, and each costs real seconds.
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
    // python / go / rust
    PIP_CACHE_DIR: path.join(c, 'pip'),
    // As non-root, pip falls back to a --user install. The default user base (~/.local)
    // lives in the image and was wiped by every rebuild; this one sits on the data volume.
    PYTHONUSERBASE: path.join(c, 'python-user'),
    UV_CACHE_DIR: path.join(c, 'uv'),
    GOMODCACHE: path.join(c, 'go'),
    CARGO_HOME: path.join(c, 'cargo'),
  };
  // Non-interactive tooling: no watch mode, no colour codes in captured logs.
  if (opts.ci !== false) env.CI = '1';
  return env;
}

/** Creates the cache root once at boot; package managers create their own subdirectories. */
export function ensureCacheDir(config: Config): void {
  try {
    fs.mkdirSync(config.cacheDir, { recursive: true });
  } catch {
    /* a missing cache dir only costs speed, never correctness */
  }
}
