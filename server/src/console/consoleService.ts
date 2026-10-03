import os from 'node:os';
import type { Config } from '../config.js';
import { toolEnv } from '../core/toolEnv.js';
import { ghCredentialEnv } from '../github/githubService.js';
import { HttpError } from '../core/httpError.js';
import type { ConsoleStatusDto } from '@pjgen/shared';

/** Minimal slice of node-pty's IPty — lets tests inject a fake terminal. */
export interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(fn: (data: string) => void): void;
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): void;
}

export type PtySpawn = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike;

export type ConsoleEvent = { type: 'output'; data: string } | { type: 'started'; status: ConsoleStatusDto } | { type: 'exit'; status: ConsoleStatusDto };

/** Scrollback kept for a reconnecting (or freshly opened) page — enough for a login flow's output. */
const SCROLLBACK_MAX = 256 * 1024;

/**
 * One persistent interactive shell inside pj-gen's own environment (same uid, HOME, gh/claude
 * configs). Its purpose: re-authenticating `gh` / `claude` (OAuth expiry) from the web UI instead
 * of a `docker exec -it` on the host. The shell survives page changes; output is buffered so the
 * page can re-attach and redraw.
 */
export class ConsoleService {
  private pty: PtyLike | null = null;
  private scrollback = '';
  private startedAt: number | null = null;
  private exitCode: number | null = null;
  private listeners = new Set<(e: ConsoleEvent) => void>();
  private spawnFn: PtySpawn | null;
  private loadError: string | null = null;

  constructor(
    private config: Config,
    private hooks: { onExit?: () => void; spawn?: PtySpawn } = {}
  ) {
    this.spawnFn = hooks.spawn ?? null;
  }

  /** node-pty is native: loaded lazily so a failed build only disables the console, not the server. */
  private async spawner(): Promise<PtySpawn | null> {
    if (this.spawnFn || this.loadError) return this.spawnFn;
    try {
      const mod = (await import('node-pty')) as unknown as { spawn: PtySpawn; default?: { spawn: PtySpawn } };
      this.spawnFn = mod.spawn ?? mod.default?.spawn ?? null;
      if (!this.spawnFn) this.loadError = 'node-pty: spawn introuvable';
    } catch (err) {
      this.loadError = `node-pty indisponible (${(err as Error).message?.slice(0, 160)})`;
    }
    return this.spawnFn;
  }

  status(): ConsoleStatusDto {
    return {
      available: !this.loadError,
      reason: this.loadError,
      running: this.pty !== null,
      pid: this.pty?.pid ?? null,
      startedAt: this.startedAt,
      exitCode: this.exitCode,
    };
  }

  snapshot(): string {
    return this.scrollback;
  }

  subscribe(fn: (e: ConsoleEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ConsoleEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a dying SSE connection must not break the others */
      }
    }
  }

  /** Idempotent: an already running shell is kept (and just resized). */
  async start(cols: number, rows: number): Promise<ConsoleStatusDto> {
    if (this.pty) {
      this.resize(cols, rows);
      return this.status();
    }
    const spawn = await this.spawner();
    if (!spawn) return this.status();
    const shell = process.env.SHELL && process.env.SHELL !== '/bin/sh' ? process.env.SHELL : '/bin/bash';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...toolEnv(this.config, { ci: false }),
      // Same git transport as GithubService: `git push` works here once `gh auth login` is done.
      ...ghCredentialEnv(this.config.ghBin, process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    let pty: PtyLike;
    try {
      pty = spawn(shell, ['-l'], { cols, rows, cwd: os.homedir(), env });
    } catch (err) {
      throw new HttpError(500, `Console : impossible de lancer ${shell} (${(err as Error).message})`);
    }
    this.pty = pty;
    this.scrollback = '';
    this.startedAt = Date.now();
    this.exitCode = null;
    pty.onData((data) => {
      if (this.pty !== pty) return;
      this.scrollback += data;
      if (this.scrollback.length > SCROLLBACK_MAX) this.scrollback = this.scrollback.slice(-SCROLLBACK_MAX);
      this.emit({ type: 'output', data });
    });
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return;
      this.pty = null;
      this.exitCode = exitCode;
      this.emit({ type: 'exit', status: this.status() });
      // Typically the end of a `claude auth login`: let pj-gen notice the new credentials now.
      this.hooks.onExit?.();
    });
    this.emit({ type: 'started', status: this.status() });
    return this.status();
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    try {
      this.pty?.resize(cols, rows);
    } catch {
      /* pty already gone */
    }
  }

  kill(): void {
    try {
      this.pty?.kill('SIGHUP');
    } catch {
      /* already exited */
    }
  }
}
