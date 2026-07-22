import type { DB } from '../db.js';
import type { FailureKind, StepKey, StepRunDto, StepRunStatus, TokenUsage } from '@pjgen/shared';
import type { RunUsage } from '../../claude/types.js';

export interface StepRunRow {
  id: number;
  project_id: string;
  step_key: StepKey;
  task_key: string | null;
  attempt: number;
  status: StepRunStatus;
  session_id: string | null;
  pid: number | null;
  resume_at: number | null;
  model: string | null;
  num_turns: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  error_kind: FailureKind | null;
  error_message: string | null;
  started_at: number | null;
  ended_at: number | null;
}

export function tokensOf(r: { input_tokens: number; output_tokens: number; cache_creation_tokens: number; cache_read_tokens: number }): TokenUsage {
  return {
    input: r.input_tokens,
    output: r.output_tokens,
    cacheCreation: r.cache_creation_tokens,
    cacheRead: r.cache_read_tokens,
    total: r.input_tokens + r.output_tokens + r.cache_creation_tokens + r.cache_read_tokens,
  };
}

export function toStepRunDto(r: StepRunRow): StepRunDto {
  return {
    id: r.id,
    projectId: r.project_id,
    stepKey: r.step_key,
    taskKey: r.task_key,
    attempt: r.attempt,
    status: r.status,
    sessionId: r.session_id,
    resumeAt: r.resume_at,
    model: r.model,
    numTurns: r.num_turns,
    tokens: tokensOf(r),
    errorKind: r.error_kind,
    errorMessage: r.error_message,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

export class StepRunsRepo {
  constructor(private db: DB) {}

  create(projectId: string, stepKey: StepKey, taskKey: string | null, attempt: number, sessionId: string | null, model: string): StepRunRow {
    const info = this.db
      .prepare(
        `INSERT INTO step_runs (project_id, step_key, task_key, attempt, status, session_id, model, started_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`
      )
      .run(projectId, stepKey, taskKey, attempt, sessionId, model, Date.now());
    return this.byId(Number(info.lastInsertRowid))!;
  }

  byId(id: number): StepRunRow | undefined {
    return this.db.prepare('SELECT * FROM step_runs WHERE id = ?').get(id) as StepRunRow | undefined;
  }

  setPid(id: number, pid: number | null): void {
    this.db.prepare('UPDATE step_runs SET pid = ? WHERE id = ?').run(pid, id);
  }

  finish(
    id: number,
    fields: {
      status: StepRunStatus;
      numTurns?: number;
      costUsd?: number;
      usage?: RunUsage;
      errorKind?: FailureKind | null;
      errorMessage?: string | null;
      resumeAt?: number | null;
    }
  ): StepRunRow {
    this.db
      .prepare(
        `UPDATE step_runs SET status = ?, num_turns = ?, cost_usd = ?,
                input_tokens = ?, output_tokens = ?, cache_creation_tokens = ?, cache_read_tokens = ?,
                error_kind = ?, error_message = ?, resume_at = ?, ended_at = ?, pid = NULL
         WHERE id = ?`
      )
      .run(
        fields.status,
        fields.numTurns ?? 0,
        fields.costUsd ?? 0,
        fields.usage?.inputTokens ?? 0,
        fields.usage?.outputTokens ?? 0,
        fields.usage?.cacheCreationTokens ?? 0,
        fields.usage?.cacheReadTokens ?? 0,
        fields.errorKind ?? null,
        fields.errorMessage ?? null,
        fields.resumeAt ?? null,
        Date.now(),
        id
      );
    return this.byId(id)!;
  }

  listForProject(projectId: string): StepRunRow[] {
    return this.db.prepare('SELECT * FROM step_runs WHERE project_id = ? ORDER BY id ASC').all(projectId) as StepRunRow[];
  }

  running(): StepRunRow[] {
    return this.db.prepare(`SELECT * FROM step_runs WHERE status = 'running'`).all() as StepRunRow[];
  }

  latestPaused(projectId: string, stepKey: StepKey, taskKey: string | null): StepRunRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM step_runs WHERE project_id = ? AND step_key = ? AND task_key IS ? AND status = 'paused_limit'
         ORDER BY id DESC LIMIT 1`
      )
      .get(projectId, stepKey, taskKey) as StepRunRow | undefined;
  }

  /** Latest orphaned (crash-interrupted) run for a step — used to resume its session after reboot. */
  latestOrphaned(projectId: string, stepKey: StepKey, taskKey: string | null): StepRunRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM step_runs WHERE project_id = ? AND step_key = ? AND task_key IS ? AND status = 'orphaned'
         ORDER BY id DESC LIMIT 1`
      )
      .get(projectId, stepKey, taskKey) as StepRunRow | undefined;
  }

  minResumeAt(projectId: string): number | null {
    const r = this.db
      .prepare(`SELECT MIN(resume_at) AS m FROM step_runs WHERE project_id = ? AND status = 'paused_limit'`)
      .get(projectId) as { m: number | null };
    return r.m;
  }

  hasSucceeded(projectId: string, stepKey: StepKey): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM step_runs WHERE project_id = ? AND step_key = ? AND status = 'succeeded' LIMIT 1`)
      .get(projectId, stepKey);
  }

  orphanCount(projectId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS c FROM step_runs WHERE project_id = ? AND status = 'orphaned'`)
      .get(projectId) as { c: number };
    return r.c;
  }
}
