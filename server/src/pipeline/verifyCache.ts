import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Dependency-install memoisation.
 *
 * `final_verify` re-runs install+build+test right after `feature_check` already passed
 * build+test, and nothing touched the dependency manifests in between — on a Node project
 * that is several minutes of pure duplicate work per build.
 *
 * The fingerprint covers the install command plus every dependency manifest present.
 * It is stored in `.git/` rather than the work tree: never committed, invisible in the
 * artifacts tree, and destroyed with the workspace it describes.
 */
const MANIFESTS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'Gemfile.lock',
];

/** Directories a successful install is expected to have produced; at least one must survive. */
const INSTALL_OUTPUTS = ['node_modules', '.venv', 'venv', 'vendor', 'target'];

/**
 * Split layouts (`backend/` + `frontend/`, each with its own manifest and install
 * output) are common: manifests and outputs are looked up at the root AND one
 * directory down. Without that, a change to `frontend/package.json` never
 * invalidated the memo, and the installed tree was never seen as present.
 */
const SKIP_DIRS = new Set([...INSTALL_OUTPUTS, 'dist', 'build', 'coverage', '__pycache__']);

function scanDirs(workspace: string): string[] {
  let subs: string[] = [];
  try {
    subs = fs
      .readdirSync(workspace, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    /* unreadable workspace — root only */
  }
  return ['', ...subs];
}

const STATE_FILE = ['.git', 'pjgen-verify.json'];

function stateFile(workspace: string): string {
  return path.join(workspace, ...STATE_FILE);
}

export function installFingerprint(workspace: string, installCmd: string): string {
  const h = crypto.createHash('sha256').update(installCmd).update('\0');
  for (const dir of scanDirs(workspace)) {
    for (const name of MANIFESTS) {
      const rel = path.join(dir, name);
      try {
        // Path included too: adding an empty lockfile must change the fingerprint.
        h.update(rel).update('\0').update(fs.readFileSync(path.join(workspace, rel))).update('\0');
      } catch {
        /* absent manifest — contributes nothing */
      }
    }
  }
  return h.digest('hex');
}

/**
 * True when this exact dependency state was already installed successfully AND the
 * installed tree is still there (a manual `rm -rf node_modules` must invalidate).
 */
export function installIsFresh(workspace: string, fingerprint: string): boolean {
  let recorded: string | null = null;
  try {
    recorded = (JSON.parse(fs.readFileSync(stateFile(workspace), 'utf8')) as { install?: string }).install ?? null;
  } catch {
    return false;
  }
  if (recorded !== fingerprint) return false;
  return scanDirs(workspace).some((dir) => INSTALL_OUTPUTS.some((d) => fs.existsSync(path.join(workspace, dir, d))));
}

/**
 * The memo lives in `.git/`: only a main workspace (where `.git` is a directory) can
 * own an install. A worktree's `.git` is a file and its dependency trees are symlinks.
 */
export function ownsInstall(workspace: string): boolean {
  try {
    return fs.statSync(path.join(workspace, '.git')).isDirectory();
  } catch {
    return false;
  }
}

export function markInstallOk(workspace: string, fingerprint: string): void {
  try {
    fs.writeFileSync(stateFile(workspace), JSON.stringify({ install: fingerprint }));
  } catch {
    /* the cache is an optimisation: failing to persist it only costs a re-install */
  }
}

/** Drops the memo — used when an install fails, so the next attempt always re-runs it. */
export function clearInstallMark(workspace: string): void {
  try {
    fs.rmSync(stateFile(workspace), { force: true });
  } catch {
    /* nothing to drop */
  }
}
