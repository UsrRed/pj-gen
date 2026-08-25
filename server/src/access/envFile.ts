import fs from 'node:fs';
import path from 'node:path';

/**
 * Read/merge/write of a workspace `.env`.
 *
 * This is the ONLY place a secret value is ever handled, and it goes straight to disk:
 * nothing is returned, logged, or persisted in SQLite. `.env` is gitignored by
 * `WorkspaceManager.create`, and written 0600 so other local users cannot read it.
 */
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Names only — used to tell the UI which secrets are already present. */
export function readEnvKeys(workspace: string): string[] {
  return Object.keys(readEnvFile(workspace));
}

/**
 * Values for internal, server-side use ONLY (e.g. injecting an integration's API key
 * into the env of an MCP server we spawn) — never expose this over HTTP, unlike
 * readEnvKeys. Only the requested names are returned, so a caller can't accidentally
 * pull in a secret it didn't ask for.
 */
export function readEnvValues(workspace: string, names: string[]): Record<string, string> {
  const all = readEnvFile(workspace);
  const out: Record<string, string> = {};
  for (const name of names) if (all[name] !== undefined) out[name] = all[name];
  return out;
}

function readEnvFile(workspace: string): Record<string, string> {
  const file = path.join(workspace, '.env');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      try {
        value = value.startsWith('"') ? (JSON.parse(value) as string) : value.slice(1, -1);
      } catch {
        /* keep the raw (quoted) value on a malformed line rather than throwing */
      }
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * Merges entries into `.env`, preserving comments, ordering and untouched keys.
 * Returns the NAMES written — never the values.
 */
export function writeEnv(workspace: string, entries: Record<string, string>): string[] {
  const file = path.join(workspace, '.env');
  for (const name of Object.keys(entries)) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`nom de variable invalide: ${name}`);
  }

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const remaining = new Map(Object.entries(entries));
  const out: string[] = [];

  for (const line of existing) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && remaining.has(m[1])) {
      out.push(`${m[1]}=${format(remaining.get(m[1])!)}`);
      remaining.delete(m[1]);
    } else {
      out.push(line);
    }
  }
  // Drop a single trailing empty line so appends do not accumulate blank lines.
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const [name, value] of remaining) out.push(`${name}=${format(value)}`);

  fs.writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // an existing file keeps its old mode without this
  return Object.keys(entries);
}

/** Quotes only when needed; a value with a newline would otherwise corrupt the file. */
function format(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ').trim();
  return /[\s"'#]/.test(clean) ? JSON.stringify(clean) : clean;
}
