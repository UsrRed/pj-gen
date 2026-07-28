import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface Capabilities {
  ok: boolean;
  version: string;
  versionWarning: string | null;
  hasJsonSchema: boolean;
  hasMaxBudget: boolean;
  hasFallbackModel: boolean;
  hasStrictMcpConfig: boolean;
  hasSettingSources: boolean;
  hasForkSession: boolean;
  hasMaxTurns: boolean;
  hasAgents: boolean;
}

export const FAKE_CAPABILITIES: Capabilities = {
  ok: true,
  version: 'fake',
  versionWarning: null,
  hasJsonSchema: true,
  hasMaxBudget: true,
  hasFallbackModel: true,
  hasStrictMcpConfig: true,
  hasSettingSources: true,
  hasForkSession: true,
  hasMaxTurns: false,
  hasAgents: true,
};

/** Tested CLI range; outside it we still run but surface a warning banner. */
const TESTED_RANGE = /^2\.[12]\./;

export async function probeCapabilities(claudeBin: string): Promise<Capabilities> {
  try {
    const [help, version] = await Promise.all([
      execFileP(claudeBin, ['--help'], { timeout: 20000, maxBuffer: 1024 * 1024 }),
      execFileP(claudeBin, ['--version'], { timeout: 20000 }),
    ]);
    const h = help.stdout + help.stderr;
    const v = (version.stdout + version.stderr).trim();
    const has = (flag: string) => h.includes(flag);
    return {
      ok: true,
      version: v,
      versionWarning: TESTED_RANGE.test(v)
        ? null
        : `Version du CLI claude non testée (${v}) — le format de sortie peut avoir changé`,
      hasJsonSchema: has('--json-schema'),
      hasMaxBudget: has('--max-budget-usd'),
      hasFallbackModel: has('--fallback-model'),
      hasStrictMcpConfig: has('--strict-mcp-config'),
      hasSettingSources: has('--setting-sources'),
      hasForkSession: has('--fork-session'),
      hasMaxTurns: has('--max-turns'),
      hasAgents: has('--agents <json>'),
    };
  } catch (err) {
    return {
      ...FAKE_CAPABILITIES,
      ok: false,
      version: 'introuvable',
      versionWarning: `CLI claude introuvable ou en erreur (${(err as Error).message?.slice(0, 120)})`,
    };
  }
}

export interface AuthStatus {
  ok: boolean;
  detail: string;
  checkedAt: number;
}

export async function checkAuth(claudeBin: string): Promise<AuthStatus> {
  try {
    const r = await execFileP(claudeBin, ['auth', 'status'], { timeout: 20000, maxBuffer: 256 * 1024 });
    const text = (r.stdout + r.stderr).trim();
    const bad = /not logged|logged out|no credentials|expired/i.test(text);
    return { ok: !bad, detail: text.split('\n')[0]?.slice(0, 200) ?? '', checkedAt: Date.now() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const text = [e.stdout, e.stderr, e.message].filter(Boolean).join(' ').trim();
    return { ok: false, detail: text.slice(0, 200) || 'claude auth status en erreur', checkedAt: Date.now() };
  }
}
