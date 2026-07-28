import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactNode } from '@pjgen/shared';
import type { WorkspaceManager } from './workspace.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'coverage', '.next', 'target']);
const MAX_ENTRIES = 800;
const MAX_DEPTH = 6;

/**
 * Files the artifacts API must never serve. The tree walk already hides dotfiles, but
 * the read-by-path route does not go through it: without this, `?path=.env` returns the
 * project's secrets verbatim — and `settings.exposeLan` publishes that API on the LAN
 * with no auth. Internal readers (steps reading docs/SPEC.md) bypass this deliberately.
 */
const SECRET_PATHS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.npmrc$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx)$/i,
];

/**
 * Template files that LOOK like `.env` but are meant to be committed and read: they list
 * variable names with placeholder values and never carry a real secret. Blocking them
 * would hide a file the operator legitimately needs from the Artefacts tab.
 */
const ENV_TEMPLATES = /(^|\/)\.env\.(example|sample|template|dist|defaults)$/i;

/** True when the path must not be exposed through the artifacts API. */
export function isSecretArtifact(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (ENV_TEMPLATES.test(normalized)) return false;
  return SECRET_PATHS.some((re) => re.test(normalized));
}

export function listArtifacts(ws: WorkspaceManager, workspace: string): ArtifactNode[] {
  let count = 0;
  const walk = (dirAbs: string, rel: string, depth: number): ArtifactNode[] => {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return [];
    }
    const nodes: ArtifactNode[] = [];
    const sorted = entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of sorted) {
      if (++count > MAX_ENTRIES) break;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: relPath, type: 'dir', children: walk(abs, relPath, depth + 1) });
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* raced */
        }
        nodes.push({ name: e.name, path: relPath, type: 'file', size });
      }
    }
    return nodes;
  };
  // jail check via WorkspaceManager (throws on escape)
  ws.assertInside(workspace, '.');
  return walk(workspace, '', 0);
}
