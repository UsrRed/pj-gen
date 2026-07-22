import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactNode } from '@pjgen/shared';
import type { WorkspaceManager } from './workspace.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'coverage', '.next', 'target']);
const MAX_ENTRIES = 800;
const MAX_DEPTH = 6;

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
