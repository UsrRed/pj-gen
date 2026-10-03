import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  /** Shared package-manager caches, mutualised across every generated workspace. */
  cacheDir: string;
  claudeBin: string;
  /** GitHub CLI binary — auth lives in gh's own keyring, never in pj-gen. */
  ghBin: string;
  fakeCli: boolean;
  /** Identity used for every git commit in generated workspaces. */
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** Static dir of the built web UI (served in prod when present). */
  webDist: string;
  schedulerTickMs: number;
  /**
   * Aperçu relay listener (preview/previewProxy.ts), bound on `host`; null = disabled.
   * `previewPublicPort` is the port browsers reach it on when something (tailscale serve…)
   * fronts it on another port — defaults to `previewPort`.
   */
  previewPort: number | null;
  previewPublicPort: number | null;
  logFlushMs: number;
  /** Random extra delay added to quota-resume timers (spreads load at reset time). */
  resumeJitterMaxMs: number;
}

function optionalPort(v: string | undefined): number | null {
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const home = os.homedir();
  const dataDir = process.env.PJGEN_DATA_DIR ?? path.join(home, '.pj-gen');
  const cfg: Config = {
    host: process.env.PJGEN_HOST ?? '127.0.0.1',
    port: Number(process.env.PJGEN_PORT ?? 4310),
    dataDir,
    dbPath: path.join(dataDir, 'db.sqlite'),
    workspaceRoot: process.env.PJGEN_WORKSPACE_ROOT ?? path.join(home, 'pj-workspace'),
    cacheDir: process.env.PJGEN_CACHE_DIR ?? path.join(dataDir, 'cache'),
    claudeBin: process.env.PJGEN_CLAUDE_BIN ?? 'claude',
    ghBin: process.env.PJGEN_GH_BIN ?? 'gh',
    fakeCli: process.env.PJGEN_FAKE_CLI === '1',
    gitAuthorName: 'UsrRed',
    gitAuthorEmail: 'redefendeur@gmail.com',
    webDist: path.resolve(import.meta.dirname, '../../web/dist'),
    schedulerTickMs: Number(process.env.PJGEN_TICK_MS ?? 30_000),
    previewPort: optionalPort(process.env.PJGEN_PREVIEW_PORT),
    previewPublicPort: optionalPort(process.env.PJGEN_PREVIEW_PUBLIC_PORT ?? process.env.PJGEN_PREVIEW_PORT),
    logFlushMs: 250,
    resumeJitterMaxMs: 90_000,
    ...overrides,
  };
  // Both derive from dataDir, which `overrides` may have replaced after the defaults were computed.
  cfg.dbPath = overrides.dbPath ?? path.join(cfg.dataDir, 'db.sqlite');
  cfg.cacheDir = overrides.cacheDir ?? process.env.PJGEN_CACHE_DIR ?? path.join(cfg.dataDir, 'cache');
  return cfg;
}
