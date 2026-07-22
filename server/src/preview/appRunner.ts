import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppStateDto, StackInfo } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';

const RING_MAX = 500;
const LOG_FLUSH_MS = 300;
const AUTO_STOP_MS = 2 * 3600_000;
const KILL_GRACE_MS = 5_000;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/;

interface AppProc {
  child: ChildProcess;
  pid: number;
  url: string | null;
  startedAt: number;
  lines: string[];
  pending: string[];
  flushTimer: NodeJS.Timeout | null;
  autoStop: NodeJS.Timeout;
  stopping: boolean;
}

/**
 * Runs a generated project's app (stack.run_cmd) inside its workspace so the user can try the
 * result from the UI. One process per project; pids tracked in app_runs for the boot sweep.
 */
export class AppRunner {
  private apps = new Map<string, AppProc>();

  constructor(private deps: CoreDeps) {}

  /** Kill leftovers from a previous pj-gen process (same guard style as pipeline/recovery.ts). */
  sweepOrphans(): number {
    const rows = this.deps.repos.appRuns.all();
    let killed = 0;
    for (const row of rows) {
      if (fs.existsSync(`/proc/${row.pid}`)) {
        try {
          process.kill(-row.pid, 'SIGTERM');
          killed += 1;
        } catch {
          try {
            process.kill(row.pid, 'SIGTERM');
            killed += 1;
          } catch {
            /* already gone */
          }
        }
      }
      this.deps.repos.appRuns.delete(row.project_id);
    }
    return killed;
  }

  state(projectId: string): AppStateDto {
    const app = this.apps.get(projectId);
    if (!app) return { running: false, url: null, startedAt: null, lines: [] };
    return { running: true, url: app.url, startedAt: app.startedAt, lines: app.lines.slice(-RING_MAX) };
  }

  start(projectId: string): AppStateDto {
    const { repos } = this.deps;
    if (this.apps.has(projectId)) throw new Error('L’application tourne déjà — arrête-la d’abord.');
    const row = repos.projects.byId(projectId);
    if (!row) throw new Error('Projet introuvable');
    if (row.status === 'building' || row.status === 'deploying') {
      throw new Error('Impossible de lancer l’aperçu pendant une construction ou un déploiement.');
    }
    const stack = repos.projects.stackOf(row) as StackInfo | null;
    if (!stack?.run_cmd) throw new Error('Aucune commande de lancement (run_cmd) connue pour ce projet.');

    // First run: install dependencies when the stack declares an install step and it clearly never ran.
    const needsInstall = Boolean(stack.install_cmd) && !fs.existsSync(path.join(row.workspace_path, 'node_modules'));
    const cmd = needsInstall ? `${stack.install_cmd} && ${stack.run_cmd}` : stack.run_cmd;

    const child = spawn('bash', ['-c', cmd], {
      cwd: row.workspace_path,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    const pid = child.pid;
    if (!pid) throw new Error('Échec du lancement du process');
    repos.appRuns.set(projectId, pid);

    const app: AppProc = {
      child,
      pid,
      url: null,
      startedAt: Date.now(),
      lines: needsInstall ? [`$ ${stack.install_cmd}`, `$ ${stack.run_cmd}`] : [`$ ${stack.run_cmd}`],
      pending: [],
      flushTimer: null,
      autoStop: setTimeout(() => void this.stop(projectId).catch(() => undefined), AUTO_STOP_MS),
      stopping: false,
    };
    app.autoStop.unref?.();
    this.apps.set(projectId, app);

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const clean = line.trimEnd();
        if (!clean) continue;
        app.lines.push(clean);
        app.pending.push(clean);
        if (app.lines.length > RING_MAX) app.lines.splice(0, app.lines.length - RING_MAX);
        if (!app.url) {
          const m = URL_RE.exec(clean);
          if (m) {
            app.url = m[0];
            this.emitStatus(projectId, app);
          }
        }
      }
      this.scheduleFlush(projectId, app);
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    child.on('close', (code) => {
      this.finish(projectId, app, code);
    });
    child.on('error', (err) => {
      app.lines.push(`✗ ${err.message}`);
      this.finish(projectId, app, -1);
    });

    this.emitStatus(projectId, app);
    return this.state(projectId);
  }

  async stop(projectId: string): Promise<void> {
    const app = this.apps.get(projectId);
    if (!app) return;
    app.stopping = true;
    try {
      process.kill(-app.pid, 'SIGTERM');
    } catch {
      try {
        app.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        try {
          process.kill(-app.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
        resolve();
      }, KILL_GRACE_MS);
      app.child.once('close', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  stopAll(): void {
    for (const [projectId, app] of this.apps) {
      app.stopping = true;
      try {
        process.kill(-app.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
      this.deps.repos.appRuns.delete(projectId);
    }
    this.apps.clear();
  }

  private finish(projectId: string, app: AppProc, code: number | null): void {
    if (!this.apps.has(projectId)) return;
    clearTimeout(app.autoStop);
    if (app.flushTimer) clearTimeout(app.flushTimer);
    this.apps.delete(projectId);
    this.deps.repos.appRuns.delete(projectId);
    const label = app.stopping ? '■ application arrêtée' : `■ process terminé (code ${code ?? '?'})`;
    this.deps.bus.emitTransient('app.log', projectId, { lines: [...app.pending, label] });
    this.deps.bus.emit('app.status', projectId, { running: false, url: null, startedAt: null });
  }

  private scheduleFlush(projectId: string, app: AppProc): void {
    if (app.flushTimer) return;
    app.flushTimer = setTimeout(() => {
      app.flushTimer = null;
      if (!app.pending.length) return;
      const lines = app.pending.splice(0, app.pending.length);
      this.deps.bus.emitTransient('app.log', projectId, { lines });
    }, LOG_FLUSH_MS);
  }

  private emitStatus(projectId: string, app: AppProc): void {
    this.deps.bus.emit('app.status', projectId, { running: true, url: app.url, startedAt: app.startedAt });
  }
}
