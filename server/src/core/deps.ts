import type { Config } from '../config.js';
import type { Repos } from '../db/repos/index.js';
import type { Bus } from './bus.js';
import type { KeyedMutex } from './mutex.js';
import type { RunnerFn } from '../claude/types.js';
import type { WorkspaceManager } from '../pipeline/workspace.js';

export interface SchedulerHooks {
  /** Wake the scheduler (something became runnable). */
  poke(): void;
  /** A run hit the subscription usage limit — record it and arm the resume timer. */
  notifyQuotaLimit(resetAt: number, matchedPattern: string | null): void;
  /** A run succeeded while the quota was marked limited — clear it. */
  notifyQuotaCleared(): void;
  /** Broadcast the current QuotaDto (window info changed). */
  emitQuota(): void;
}

export interface CoreDeps {
  config: Config;
  repos: Repos;
  bus: Bus;
  runner: RunnerFn;
  mutex: KeyedMutex;
  ws: WorkspaceManager;
  sched: SchedulerHooks;
}
