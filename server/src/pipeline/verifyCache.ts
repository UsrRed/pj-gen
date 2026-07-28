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

const STATE_FILE = ['.git', 'pjgen-verify.json'];

function stateFile(workspace: string): string {
  return path.join(workspace, ...STATE_FILE);
}

export function installFingerprint(workspace: string, installCmd: string): string {
  const h = crypto.createHash('sha256').update(installCmd).update('\0');
  for (const name of MANIFESTS) {
    const abs = path.join(workspace, name);
    try {
      // Name included too: adding an empty lockfile must change the fingerprint.
      h.update(name).update('\0').update(fs.readFileSync(abs)).update('\0');
    } catch {
      /* absent manifest — contributes nothing */
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
  return INSTALL_OUTPUTS.some((d) => fs.existsSync(path.join(workspace, d)));
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
