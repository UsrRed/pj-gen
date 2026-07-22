import type { QuotaDto } from '@pjgen/shared';
import type { CoreDeps, SchedulerHooks } from '../core/deps.js';
import type { AuthStatus } from '../claude/capabilities.js';
import { ProjectStateMachine } from '../core/stateMachine.js';
import { evaluateCut, windowDto } from '../core/usageTracker.js';
import type { Engine } from './engine.js';

interface ActiveEngine {
  controller: AbortController;
}

/** FIFO scheduler: N build slots (default 2), quota-aware parking, timer-based resume. */
export class Scheduler implements SchedulerHooks {
  private engines = new Map<string, ActiveEngine>();
  private tickTimer: NodeJS.Timeout | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private resumeTimerAt: number | null = null;
  private cutTimer: NodeJS.Timeout | null = null;
  private cutTimerAt: number | null = null;
  /** Inert until start() — pokes fired during boot/seeding must not schedule anything. */
  private stopped = true;
  private ticking = false;
  private auth: AuthStatus = { ok: true, detail: '', checkedAt: 0 };
  private sm: ProjectStateMachine;

  constructor(
    private deps: Omit<CoreDeps, 'sched'>,
    private engine: Engine
  ) {
    this.sm = new ProjectStateMachine(deps.repos.projects);
  }

  start(): void {
    this.stopped = false;
    this.tickTimer = setInterval(() => this.tick(), this.deps.config.schedulerTickMs);
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.clearCutTimer();
    for (const [, active] of this.engines) active.controller.abort('pause');
  }

  setAuth(auth: AuthStatus): void {
    const wasOk = this.auth.ok;
    this.auth = auth;
    if (!auth.ok) {
      this.deps.bus.emit('boot.notice', null, {
        level: 'error',
        message: `Authentification claude KO (${auth.detail || 'inconnue'}) — exécute \`claude auth login\` puis redémarre pj-gen.`,
      });
    }
    this.emitQuota();
    if (auth.ok && !wasOk) this.poke();
  }

  getQuotaDto(): QuotaDto {
    const { repos } = this.deps;
    const q = repos.quota.get();
    const w = windowDto(repos);
    const cut = repos.settings.getScheduledCut();
    const ev = cut ? evaluateCut(cut, w.resetsAt, w.tokensInWindow.total, w.estimatedCeiling) : null;
    return {
      limitedUntil: q.limited_until,
      lastHitAt: q.last_hit_at,
      matchedPattern: q.matched_pattern,
      authOk: this.auth.ok,
      authDetail: this.auth.detail,
      window: w,
      globalPaused: repos.settings.getGlobalPaused(),
      scheduledCut:
        cut && ev && !ev.expired ? { ...cut, binding: ev.binding, ceilingUnknown: ev.ceilingUnknown } : null,
    };
  }

  /** Global pause: persist the flag and halt every in-flight build (→ paused_user, resumable). */
  pauseAll(): void {
    this.deps.repos.settings.setGlobalPaused(true);
    for (const [, active] of this.engines) active.controller.abort('pause');
    this.emitQuota();
  }

  /** Cut created/cancelled by a route: drop the stale timer, re-evaluate, broadcast. */
  cutChanged(): void {
    this.clearCutTimer();
    this.checkCut();
    this.emitQuota();
  }

  emitQuota(): void {
    this.deps.bus.emit('quota.updated', null, { quota: this.getQuotaDto() });
  }

  poke(): void {
    queueMicrotask(() => this.tick());
  }

  notifyQuotaLimit(resetAt: number, matchedPattern: string | null): void {
    const { repos } = this.deps;
    const current = repos.quota.get().limited_until ?? 0;
    repos.quota.setLimited(Math.max(current, resetAt), matchedPattern);
    this.emitQuota();
    this.armResumeTimer(Math.max(current, resetAt));
  }

  notifyQuotaCleared(): void {
    this.deps.repos.quota.clear();
    this.emitQuota();
    this.poke();
  }

  private armResumeTimer(at: number): void {
    if (this.stopped) return;
    if (this.resumeTimer && this.resumeTimerAt !== null && this.resumeTimerAt <= at) return;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    const jitter = Math.floor(Math.random() * Math.max(1, this.deps.config.resumeJitterMaxMs));
    const delay = Math.max(1000, at - Date.now() + jitter);
    this.resumeTimerAt = at;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.resumeTimerAt = null;
      this.emitQuota();
      this.tick();
    }, delay);
  }

  /** Re-evaluates the scheduled cut; pauses everything the moment it becomes binding. */
  private checkCut(): void {
    const { repos } = this.deps;
    const cut = repos.settings.getScheduledCut();
    if (!cut) {
      this.clearCutTimer();
      return;
    }
    const w = windowDto(repos);
    const ev = evaluateCut(cut, w.resetsAt, w.tokensInWindow.total, w.estimatedCeiling);
    if (ev.expired) {
      // Spent: auto-clear the cut but KEEP globalPaused — resuming is a manual decision.
      repos.settings.setScheduledCut(null);
      this.clearCutTimer();
      this.emitQuota();
      return;
    }
    if (ev.binding) {
      if (!repos.settings.getGlobalPaused()) this.pauseAll();
      this.armCutTimer(cut.targetAt); // wake at expiry to auto-clear
    } else {
      this.armCutTimer(ev.nextCheckAt ?? cut.targetAt);
    }
  }

  /** No jitter: the cut must fire exactly at the flip moment, not late. */
  private armCutTimer(at: number): void {
    if (this.stopped) return;
    if (this.cutTimer && this.cutTimerAt !== null && this.cutTimerAt <= at) return;
    if (this.cutTimer) clearTimeout(this.cutTimer);
    const delay = Math.max(250, at - Date.now());
    this.cutTimerAt = at;
    this.cutTimer = setTimeout(() => {
      this.cutTimer = null;
      this.cutTimerAt = null;
      this.checkCut();
      this.emitQuota();
    }, delay);
  }

  private clearCutTimer(): void {
    if (this.cutTimer) clearTimeout(this.cutTimer);
    this.cutTimer = null;
    this.cutTimerAt = null;
  }

  /** Number of active autonomous builds (deploy chat turns are not slot-limited). */
  get activeBuilds(): number {
    return this.engines.size;
  }

  isEngineActive(projectId: string): boolean {
    return this.engines.has(projectId);
  }

  /** Aborts the running engine of a project. Returns false when no engine is active. */
  abortProject(projectId: string, mode: 'pause' | 'cancel'): boolean {
    const active = this.engines.get(projectId);
    if (!active) return false;
    active.controller.abort(mode);
    return true;
  }

  private tick(): void {
    if (this.stopped || this.ticking) return;
    if (!this.tickTimer) return; // never started
    this.ticking = true;
    try {
      this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private tickInner(): void {
    const { repos } = this.deps;
    if (!this.auth.ok) return;

    // Before the limited_until early-return: a cut scheduled during a rate-limit park must still arm.
    this.checkCut();
    if (repos.settings.getGlobalPaused()) return;

    const quota = repos.quota.get();
    if (quota.limited_until && quota.limited_until > Date.now()) {
      this.armResumeTimer(quota.limited_until);
      return;
    }

    const settings = repos.settings.getAll();
    let capacity = settings.maxConcurrentBuilds - this.engines.size;
    if (capacity <= 0) return;

    const candidates = repos.projects.byStatus(['queued', 'paused_limit']);
    for (const project of candidates) {
      if (capacity <= 0) break;
      if (this.engines.has(project.id)) continue;
      if (!this.sm.tryTransition(project.id, [project.status === 'queued' ? 'queued' : 'paused_limit'], 'building')) continue;

      const controller = new AbortController();
      this.engines.set(project.id, { controller });
      capacity -= 1;

      const row = repos.projects.byId(project.id)!;
      this.deps.bus.emit('project.updated', project.id, { project: repos.projects.summary(row) });
      this.deps.bus.emit('queue.updated', null, repos.projects.queueSnapshot());

      void this.engine
        .runProject(project.id, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          this.engines.delete(project.id);
          this.poke();
        });
    }
  }
}
