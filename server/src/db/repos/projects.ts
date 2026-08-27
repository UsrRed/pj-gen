import type { DB } from '../db.js';
import type { ModelName, PipelineMode, ProjectSize, ProjectStatus, ProjectSummary, QueueSnapshot, StackInfo, StepKey } from '@pjgen/shared';
import { tokensOf } from './stepRuns.js';

export interface ProjectRow {
  id: string;
  slug: string;
  title: string;
  status: ProjectStatus;
  model: ModelName | null;
  /** Size tier; NULL = not decided yet (auto). Frozen at spec validation. */
  size: ProjectSize | null;
  /** Who decided it: an explicit operator choice wins over the cadrage suggestion. */
  size_source: 'user' | 'cadrage' | 'default' | null;
  iteration: number;
  reopened_at: number | null;
  step_model_overrides: string;
  stack: string | null;
  workspace_path: string;
  initial_prompt: string;
  spec_sha256: string | null;
  spec_validated_at: number | null;
  enqueued_at: number | null;
  current_step_key: StepKey | null;
  current_task_key: string | null;
  deploy_notes: string | null;
  error_message: string | null;
  design_benchmark: number | null;
  pipeline_mode: PipelineMode;
  github_repo: string | null;
  github_private: number | null;
  github_auto_mode: number;
  github_last_push_sha: string | null;
  github_last_push_at: number | null;
  /** 1 while a generate-ci request is queued, waiting for the project to get a github_repo. */
  github_ci_pending: number;
  created_at: number;
  updated_at: number;
}

export interface NewProject {
  id: string;
  slug: string;
  title: string;
  model: ModelName | null;
  /** null = auto: the cadrage session proposes a tier. */
  size?: ProjectSize | null;
  workspacePath: string;
  initialPrompt: string;
}

const PATCHABLE = new Set([
  'model',
  'size',
  'size_source',
  'iteration',
  'reopened_at',
  'step_model_overrides',
  'stack',
  'spec_sha256',
  'spec_validated_at',
  'enqueued_at',
  'current_step_key',
  'current_task_key',
  'deploy_notes',
  'error_message',
  'design_benchmark',
  'pipeline_mode',
  'github_repo',
  'github_private',
  'github_auto_mode',
  'github_last_push_sha',
  'github_last_push_at',
  'github_ci_pending',
]);

export class ProjectsRepo {
  constructor(private db: DB) {}

  insert(p: NewProject): ProjectRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO projects (id, slug, title, status, model, size, size_source, workspace_path, initial_prompt, created_at, updated_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(p.id, p.slug, p.title, p.model, p.size ?? null, p.size ? 'user' : null, p.workspacePath, p.initialPrompt, now, now);
    return this.byId(p.id)!;
  }

  byId(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  slugExists(slug: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug);
  }

  all(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
  }

  byStatus(statuses: ProjectStatus[]): ProjectRow[] {
    const marks = statuses.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM projects WHERE status IN (${marks}) ORDER BY COALESCE(enqueued_at, created_at) ASC`)
      .all(...statuses) as ProjectRow[];
  }

  /** Compare-and-swap status update. Returns false when the current status is not in `from`. */
  casStatus(id: string, from: ProjectStatus[], to: ProjectStatus, patch: Record<string, unknown> = {}): boolean {
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const values: unknown[] = [to, Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) throw new Error(`non-patchable column: ${k}`);
      sets.push(`${k} = ?`);
      values.push(v as never);
    }
    const marks = from.map(() => '?').join(',');
    const info = this.db
      .prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND status IN (${marks})`)
      .run(...values, id, ...from);
    return info.changes === 1;
  }

  patch(id: string, patch: Record<string, unknown>): void {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) throw new Error(`non-patchable column: ${k}`);
      sets.push(`${k} = ?`);
      values.push(v as never);
    }
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  /**
   * Deletes the project and every row that references it. usage_log and
   * limit_hits are kept on purpose: they are quota telemetry (5h-window gauge,
   * daily stats), not project data — orphan rows simply drop out of the
   * per-project stats (JOIN projects).
   */
  deleteCascade(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM logs WHERE step_run_id IN (SELECT id FROM step_runs WHERE project_id = ?)').run(id);
      for (const table of ['step_runs', 'sessions', 'tasks', 'messages', 'micro_requests', 'issues', 'project_access', 'app_runs', 'events']) {
        this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(id);
      }
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    })();
  }

  queueSnapshot(): QueueSnapshot {
    const active = this.db
      .prepare(`SELECT id FROM projects WHERE status IN ('building','deploying') ORDER BY updated_at ASC`)
      .all() as { id: string }[];
    const queued = this.db
      .prepare(
        `SELECT id FROM projects WHERE status IN ('queued','paused_limit','interrupted')
         ORDER BY COALESCE(enqueued_at, created_at) ASC`
      )
      .all() as { id: string }[];
    return { activeIds: active.map((r) => r.id), queuedIds: queued.map((r) => r.id) };
  }

  summary(row: ProjectRow): ProjectSummary {
    const t = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
         FROM tasks WHERE project_id = ?`
      )
      .get(row.id) as { total: number; done: number };
    const tokenCols = `COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens`;
    const runTokens = this.db
      .prepare(`SELECT ${tokenCols} FROM step_runs WHERE project_id = ?`)
      .get(row.id) as Parameters<typeof tokensOf>[0];
    const chatTokens = this.db
      .prepare(`SELECT ${tokenCols} FROM sessions WHERE project_id = ? AND kind = 'cadrage'`)
      .get(row.id) as Parameters<typeof tokensOf>[0];
    let queuePosition: number | null = null;
    if (row.status === 'queued' || row.status === 'paused_limit' || row.status === 'interrupted') {
      const snapshot = this.queueSnapshot();
      const idx = snapshot.queuedIds.indexOf(row.id);
      queuePosition = idx >= 0 ? idx + 1 : null;
    }
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      model: row.model,
      size: row.size ?? null,
      sizeSource: row.size_source ?? null,
      iteration: row.iteration ?? 1,
      workspacePath: row.workspace_path,
      currentStepKey: row.current_step_key,
      currentTaskKey: row.current_task_key,
      queuePosition,
      tasksDone: t.done,
      tasksTotal: t.total,
      tokens: tokensOf({
        input_tokens: runTokens.input_tokens + chatTokens.input_tokens,
        output_tokens: runTokens.output_tokens + chatTokens.output_tokens,
        cache_creation_tokens: runTokens.cache_creation_tokens + chatTokens.cache_creation_tokens,
        cache_read_tokens: runTokens.cache_read_tokens + chatTokens.cache_read_tokens,
      }),
      errorMessage: row.error_message,
      specValidatedAt: row.spec_validated_at,
      pipelineMode: row.pipeline_mode ?? 'full',
      designBenchmark: row.design_benchmark === null ? null : row.design_benchmark === 1,
      github: row.github_repo
        ? {
            repo: row.github_repo,
            private: row.github_private === 1,
            autoMode: row.github_auto_mode === 1,
            lastPushSha: row.github_last_push_sha,
            lastPushAt: row.github_last_push_at,
          }
        : null,
      githubCiPending: row.github_ci_pending === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  stackOf(row: ProjectRow): StackInfo | null {
    if (!row.stack) return null;
    try {
      return JSON.parse(row.stack) as StackInfo;
    } catch {
      return null;
    }
  }

  stepModelOverridesOf(row: ProjectRow): Partial<Record<StepKey, ModelName>> {
    try {
      return JSON.parse(row.step_model_overrides ?? '{}');
    } catch {
      return {};
    }
  }
}
