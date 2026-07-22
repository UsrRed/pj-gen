import { spawn } from 'node:child_process';
import type { StackInfo } from '@pjgen/shared';
import type { Config } from '../config.js';

export interface VerifyResult {
  ok: boolean;
  label: string;
  tail: string;
  durationMs: number;
}

const TAIL_CAP = 4000;

export function runCmd(workspace: string, cmd: string, timeoutMs: number, label = cmd): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = '';
    const push = (chunk: string) => {
      tail = (tail + chunk).slice(-TAIL_CAP);
    };
    const child = spawn('bash', ['-c', cmd], { cwd: workspace, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, label, tail: `spawn error: ${err.message}`, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: !timedOut && code === 0,
        label,
        tail: timedOut ? `${tail}\n[timeout après ${timeoutMs / 1000}s]` : tail,
        durationMs: Date.now() - started,
      });
    });
  });
}

export type VerifyKind = 'install' | 'build' | 'test';

const CMD_TIMEOUTS: Record<VerifyKind, number> = {
  install: 10 * 60 * 1000,
  build: 10 * 60 * 1000,
  test: 10 * 60 * 1000,
};

/** Runs the stack's commands in order, stopping at the first failure. Fake mode always passes. */
export async function verifyStack(config: Config, workspace: string, stack: StackInfo | null, kinds: VerifyKind[]): Promise<VerifyResult> {
  if (config.fakeCli) return { ok: true, label: 'simulation', tail: '', durationMs: 0 };
  if (!stack) return { ok: false, label: 'stack', tail: 'stack inconnue (architecture manquante)', durationMs: 0 };
  for (const kind of kinds) {
    const cmd = kind === 'install' ? stack.install_cmd : kind === 'build' ? stack.build_cmd : stack.test_cmd;
    if (!cmd || !cmd.trim()) continue;
    const r = await runCmd(workspace, cmd, CMD_TIMEOUTS[kind], `${kind}: ${cmd}`);
    if (!r.ok) return r;
  }
  return { ok: true, label: kinds.join('+'), tail: '', durationMs: 0 };
}
