import type { DB } from '../db.js';
import type { ModelName, ScheduledCut, SettingsDto, StepCap } from '@pjgen/shared';

/**
 * Turn caps are a runaway safety valve, not an economy tool (the timeout and
 * --max-budget-usd do that). Counted in LOGICAL turns (unique assistant message ids).
 */
export const DEFAULT_STEP_CAPS: Record<string, StepCap> = {
  cadrage: { turns: 8, timeoutMin: 6 },
  spec: { turns: 8, timeoutMin: 8 },
  design_benchmark: { turns: 8, timeoutMin: 5 },
  design: { turns: 8, timeoutMin: 12 },
  architecture: { turns: 8, timeoutMin: 8 },
  task_breakdown: { turns: 8, timeoutMin: 8 },
  scaffold: { turns: 60, timeoutMin: 20 },
  implement_task: { turns: 80, timeoutMin: 30 },
  polish: { turns: 80, timeoutMin: 25 },
  test_hardening: { turns: 50, timeoutMin: 20 },
  feature_check: { turns: 60, timeoutMin: 25 },
  review_fix: { turns: 60, timeoutMin: 30 },
  docs: { turns: 25, timeoutMin: 10 },
  final_verify: { turns: 50, timeoutMin: 20 },
  deploy: { turns: 80, timeoutMin: 30 },
  micro: { turns: 4, timeoutMin: 5 },
  ci: { turns: 20, timeoutMin: 10 },
  import: { turns: 30, timeoutMin: 12 },
};

/**
 * "Équilibré" routing profile: opus where the thinking happens (framing, spec,
 * architecture, design), sonnet for execution, haiku for routine docs.
 */
export const DEFAULT_STEP_MODELS: Record<string, ModelName> = {
  cadrage: 'opus',
  spec: 'opus',
  design_benchmark: 'sonnet',
  design: 'opus',
  architecture: 'opus',
  task_breakdown: 'sonnet',
  scaffold: 'sonnet',
  implement_task: 'sonnet',
  polish: 'sonnet',
  test_hardening: 'sonnet',
  review_fix: 'sonnet',
  feature_check: 'sonnet',
  docs: 'haiku',
  final_verify: 'sonnet',
  deploy: 'sonnet',
  micro: 'sonnet',
  ci: 'sonnet',
  import: 'sonnet',
};

export const DEFAULT_SETTINGS: SettingsDto = {
  maxConcurrentBuilds: 2,
  maxConcurrentSessions: 4,
  // Ships at 1: parallelism is opt-in until measured against the timing baseline.
  taskParallelism: 1,
  defaultModel: 'opus',
  autoResumeOnBoot: true,
  skipTestHardening: false,
  maxBudgetUsdPerSession: 5,
  stepCaps: DEFAULT_STEP_CAPS,
  stepModels: DEFAULT_STEP_MODELS,
  designBenchmark: true,
  githubDefaultPrivate: true,
  issuePollMinutes: 5,
  notifyUrl: '',
  notifyEvents: { deployReady: true, buildFailed: true, quotaResumed: true },
  exposeLan: false,
  sizeProfiles: {},
  integrations: { context7: false, exa: false, memoryProvider: 'none' },
};

export class SettingsRepo {
  constructor(private db: DB) {}

  getAll(): SettingsDto {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const parse = <T>(key: string, fallback: T): T => {
      const raw = map.get(key);
      if (raw === undefined) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    };
    return {
      maxConcurrentBuilds: Math.max(1, Math.min(4, parse('max_concurrent_builds', DEFAULT_SETTINGS.maxConcurrentBuilds))),
      maxConcurrentSessions: Math.max(1, Math.min(8, parse('max_concurrent_sessions', DEFAULT_SETTINGS.maxConcurrentSessions))),
      taskParallelism: Math.max(1, Math.min(4, parse('task_parallelism', DEFAULT_SETTINGS.taskParallelism))),
      defaultModel: parse('default_model', DEFAULT_SETTINGS.defaultModel),
      autoResumeOnBoot: parse('auto_resume_on_boot', DEFAULT_SETTINGS.autoResumeOnBoot),
      skipTestHardening: parse('skip_test_hardening', DEFAULT_SETTINGS.skipTestHardening),
      maxBudgetUsdPerSession: parse('max_budget_usd_per_session', DEFAULT_SETTINGS.maxBudgetUsdPerSession),
      stepCaps: { ...DEFAULT_STEP_CAPS, ...parse('step_caps', {}) },
      stepModels: { ...DEFAULT_STEP_MODELS, ...parse('step_models', {}) },
      designBenchmark: parse('design_benchmark', DEFAULT_SETTINGS.designBenchmark),
      githubDefaultPrivate: parse('github_default_private', DEFAULT_SETTINGS.githubDefaultPrivate),
      issuePollMinutes: Math.max(1, parse('issue_poll_minutes', DEFAULT_SETTINGS.issuePollMinutes)),
      notifyUrl: parse('notify_url', DEFAULT_SETTINGS.notifyUrl),
      notifyEvents: { ...DEFAULT_SETTINGS.notifyEvents, ...parse('notify_events', {}) },
      exposeLan: parse('expose_lan', DEFAULT_SETTINGS.exposeLan),
      sizeProfiles: parse('size_profiles', DEFAULT_SETTINGS.sizeProfiles),
      integrations: { ...DEFAULT_SETTINGS.integrations, ...parse('integrations', {}) },
    };
  }

  set(partial: Partial<SettingsDto>): SettingsDto {
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const mapping: [keyof SettingsDto, string][] = [
      ['maxConcurrentBuilds', 'max_concurrent_builds'],
      ['maxConcurrentSessions', 'max_concurrent_sessions'],
      ['taskParallelism', 'task_parallelism'],
      ['defaultModel', 'default_model'],
      ['autoResumeOnBoot', 'auto_resume_on_boot'],
      ['skipTestHardening', 'skip_test_hardening'],
      ['maxBudgetUsdPerSession', 'max_budget_usd_per_session'],
      ['stepCaps', 'step_caps'],
      ['stepModels', 'step_models'],
      ['designBenchmark', 'design_benchmark'],
      ['githubDefaultPrivate', 'github_default_private'],
      ['issuePollMinutes', 'issue_poll_minutes'],
      ['notifyUrl', 'notify_url'],
      ['notifyEvents', 'notify_events'],
      ['exposeLan', 'expose_lan'],
      ['sizeProfiles', 'size_profiles'],
      ['integrations', 'integrations'],
    ];
    this.db.transaction(() => {
      for (const [prop, key] of mapping) {
        if (partial[prop] !== undefined) upsert.run(key, JSON.stringify(partial[prop]));
      }
    })();
    return this.getAll();
  }

  /**
   * Caps the operator actually persisted, WITHOUT the DEFAULT_STEP_CAPS merge that
   * getAll() applies. A size profile scales the built-in defaults but must never
   * override a value the operator typed by hand — and after the merge the two are
   * indistinguishable.
   */
  rawStepCaps(): Partial<Record<string, StepCap>> {
    return this.getRaw<Partial<Record<string, StepCap>>>('step_caps') ?? {};
  }

  /** Same rationale as rawStepCaps, for the per-step model routing. */
  rawStepModels(): Partial<Record<string, ModelName>> {
    return this.getRaw<Partial<Record<string, ModelName>>>('step_models') ?? {};
  }

  // Runtime control state (not part of SettingsDto: mutations must go through the
  // scheduler/control routes so timers and engine aborts stay consistent).

  getGlobalPaused(): boolean {
    return this.getRaw<boolean>('global_paused') === true;
  }

  setGlobalPaused(v: boolean): void {
    this.upsertRaw('global_paused', v);
  }

  getScheduledCut(): ScheduledCut | null {
    const cut = this.getRaw<ScheduledCut>('scheduled_cut');
    if (!cut || typeof cut.targetAt !== 'number' || typeof cut.reservePct !== 'number') return null;
    return cut;
  }

  setScheduledCut(cut: ScheduledCut | null): void {
    if (cut === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run('scheduled_cut');
    else this.upsertRaw('scheduled_cut', cut);
  }

  private getRaw<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private upsertRaw(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
}
