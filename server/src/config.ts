import os from 'node:os';
import path from 'node:path';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
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
  logFlushMs: number;
  /** Random extra delay added to quota-resume timers (spreads load at reset time). */
  resumeJitterMaxMs: number;
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
    claudeBin: process.env.PJGEN_CLAUDE_BIN ?? 'claude',
    ghBin: process.env.PJGEN_GH_BIN ?? 'gh',
    fakeCli: process.env.PJGEN_FAKE_CLI === '1',
    gitAuthorName: 'UsrRed',
    gitAuthorEmail: 'redefendeur@gmail.com',
    webDist: path.resolve(import.meta.dirname, '../../web/dist'),
    schedulerTickMs: Number(process.env.PJGEN_TICK_MS ?? 30_000),
    logFlushMs: 250,
    resumeJitterMaxMs: 90_000,
    ...overrides,
  };
  cfg.dbPath = overrides.dbPath ?? path.join(cfg.dataDir, 'db.sqlite');
  return cfg;
}
