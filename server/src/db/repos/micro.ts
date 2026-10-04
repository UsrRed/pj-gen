import type { DB } from '../db.js';
import type { MicroRequestDto, MicroRequestStatus } from '@pjgen/shared';

export interface MicroRequestRow {
  id: number;
  project_id: string;
  source: 'manual' | 'issue';
  issue_id: number | null;
  request: string;
  task_key: string | null;
  status: MicroRequestStatus;
  error_message: string | null;
  created_at: number;
  updated_at: number;
}

export function toMicroDto(r: MicroRequestRow): MicroRequestDto {
  return {
    id: r.id,
    projectId: r.project_id,
    source: r.source,
    issueId: r.issue_id,
    request: r.request,
    taskKey: r.task_key,
    status: r.status,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class MicroRepo {
  constructor(private db: DB) {}

  insert(projectId: string, source: 'manual' | 'issue', request: string, issueId: number | null = null): MicroRequestRow {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO micro_requests (project_id, source, issue_id, request, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(projectId, source, issueId, request, now, now);
    return this.byId(Number(info.lastInsertRowid))!;
  }

  byId(id: number): MicroRequestRow | undefined {
    return this.db.prepare('SELECT * FROM micro_requests WHERE id = ?').get(id) as MicroRequestRow | undefined;
  }

  list(projectId: string, limit = 100): MicroRequestRow[] {
    return this.db
      .prepare('SELECT * FROM micro_requests WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as MicroRequestRow[];
  }

  /** Requests whose task is created but whose cycle has not settled yet. */
  open(projectId: string): MicroRequestRow[] {
    return this.db
      .prepare(`SELECT * FROM micro_requests WHERE project_id = ? AND status = 'task_created' ORDER BY id ASC`)
      .all(projectId) as MicroRequestRow[];
  }

  latestForIssue(issueId: number): MicroRequestRow | undefined {
    return this.db
      .prepare('SELECT * FROM micro_requests WHERE issue_id = ? ORDER BY id DESC LIMIT 1')
      .get(issueId) as MicroRequestRow | undefined;
  }

  patch(id: number, patch: Partial<Pick<MicroRequestRow, 'task_key' | 'status' | 'error_message'>>): MicroRequestRow {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(v as never);
    }
    this.db.prepare(`UPDATE micro_requests SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.byId(id)!;
  }

  /**
   * Settle open requests at the end of a build cycle: task done → 'done', task failed/missing
   * → 'failed'. A failed cycle (`cycleFailure`) settles every open request as 'failed' with
   * that reason, whatever its task status — a done task is not a satisfied request.
   * Returns the settled rows.
   */
  settleForProject(projectId: string, cycleFailure?: string): MicroRequestRow[] {
    const settled: MicroRequestRow[] = [];
    for (const r of this.open(projectId)) {
      const task = r.task_key
        ? (this.db.prepare('SELECT status FROM tasks WHERE project_id = ? AND task_key = ?').get(projectId, r.task_key) as
            | { status: string }
            | undefined)
        : undefined;
      const ok = task?.status === 'done' && !cycleFailure;
      const reason = cycleFailure ?? r.error_message ?? 'tâche non terminée';
      settled.push(this.patch(r.id, { status: ok ? 'done' : 'failed', error_message: ok ? null : reason }));
    }
    return settled;
  }
}
