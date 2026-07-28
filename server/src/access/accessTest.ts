import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccessKind } from '@pjgen/shared';

const execFileP = promisify(execFile);

/**
 * Connectivity checks for the accesses declared at cadrage.
 *
 * `execFile` (never a shell) plus strict validation BEFORE the argv is built: a value
 * starting with `-` would be read by ssh as an option, and `-oProxyCommand=…` is arbitrary
 * command execution. Anything that could be an option is rejected outright.
 */
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const USER_RE = /^[A-Za-z0-9._-]+$/;

export interface TestOutcome {
  ok: boolean;
  detail: string;
}

export function validateSshFields(f: Record<string, string>): { host: string; user: string; port: string; keyPath?: string } {
  const host = (f.host ?? '').trim();
  const user = (f.user ?? '').trim();
  const portRaw = (f.port ?? '22').trim() || '22';

  if (!host) throw new Error('hôte manquant');
  if (!HOST_RE.test(host)) throw new Error(`hôte invalide: ${host}`);
  if (!user) throw new Error('utilisateur manquant');
  if (!USER_RE.test(user)) throw new Error(`utilisateur invalide: ${user}`);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port invalide: ${portRaw}`);

  let keyPath: string | undefined;
  const rawKey = (f.key_path ?? '').trim();
  if (rawKey) {
    const expanded = rawKey.startsWith('~') ? path.join(os.homedir(), rawKey.slice(1)) : rawKey;
    const resolved = path.resolve(expanded);
    // The key must be a real file under the operator's home: never an arbitrary path.
    if (!resolved.startsWith(os.homedir() + path.sep)) throw new Error('la clé doit se trouver dans le répertoire personnel');
    if (!fs.existsSync(resolved)) throw new Error(`clé introuvable: ${rawKey}`);
    keyPath = resolved;
  }
  return { host, user, port: String(port), keyPath };
}

export async function testSsh(fields: Record<string, string>): Promise<TestOutcome> {
  let v: ReturnType<typeof validateSshFields>;
  try {
    v = validateSshFields(fields);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  const argv = [
    '-o',
    'BatchMode=yes', // never prompt for a password
    '-o',
    'ConnectTimeout=5',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-p',
    v.port,
    ...(v.keyPath ? ['-i', v.keyPath] : []),
    `${v.user}@${v.host}`,
    'true',
  ];
  try {
    await execFileP('ssh', argv, { timeout: 8000 });
    return { ok: true, detail: `connexion OK vers ${v.user}@${v.host}:${v.port}` };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, detail: (e.stderr || e.message || 'échec de connexion').trim().slice(0, 300) };
  }
}

export async function testDomain(fields: Record<string, string>): Promise<TestOutcome> {
  const domain = (fields.domain ?? '').trim();
  if (!domain) return { ok: false, detail: 'domaine manquant' };
  if (!HOST_RE.test(domain)) return { ok: false, detail: `domaine invalide: ${domain}` };
  try {
    const addrs = await dns.promises.resolve(domain);
    return { ok: true, detail: `résolu: ${addrs.slice(0, 3).join(', ')}` };
  } catch (err) {
    return { ok: false, detail: `résolution DNS impossible (${(err as NodeJS.ErrnoException).code ?? 'erreur'})` };
  }
}

/** Only the kinds that can be checked without pulling in a database or SMTP driver. */
export const TESTABLE_KINDS: AccessKind[] = ['ssh', 'domain'];

export async function runAccessTest(kind: AccessKind, fields: Record<string, string>): Promise<TestOutcome> {
  if (kind === 'ssh') return testSsh(fields);
  if (kind === 'domain') return testDomain(fields);
  return { ok: false, detail: 'aucun test disponible pour ce type d’accès' };
}
