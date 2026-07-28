import type { DB } from '../db.js';
import type { TaskDto, TaskPhase, TaskStatus } from '@pjgen/shared';
import { DEFAULT_TASK_PHASE } from '@pjgen/shared';

export interface TaskRow {
  project_id: string;
  task_key: string;
  position: number;
  title: string;
  description: string;
  files_hint: string;
  /** JSON array: the paths this task COMMITS to writing — drives parallel batch selection. */
  writes: string;
  acceptance: string;
  depends_on: string;
  /** JSON array: ORDERING edges ("don't start before these are done"), not contract deps. */
  after_keys: string;
  phase: string;
  status: TaskStatus;
  commit_sha: string | null;
  /** Worktree of an in-flight parallel task; survives a quota park so the resume reattaches. */
  worktree_dir: string | null;
}

function parseArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function toTaskDto(r: TaskRow): TaskDto {
  return {
    taskKey: r.task_key,
    position: r.position,
    title: r.title,
    description: r.description,
    filesHint: parseArr(r.files_hint),
    // Older rows were backfilled from files_hint; fall back for anything still empty.
    writes: parseArr(r.writes).length ? parseArr(r.writes) : parseArr(r.files_hint),
    acceptance: parseArr(r.acceptance),
    dependsOn: parseArr(r.depends_on),
    after: parseArr(r.after_keys),
    phase: (r.phase || DEFAULT_TASK_PHASE) as TaskPhase,
    status: r.status,
    commitSha: r.commit_sha,
    worktreeDir: r.worktree_dir,
  };
}

export class TasksRepo {
  constructor(private db: DB) {}

  replaceAll(projectId: string, tasks: Omit<TaskDto, 'status' | 'commitSha'>[]): void {
    const del = this.db.prepare('DELETE FROM tasks WHERE project_id = ?');
    const ins = this.db.prepare(
      `INSERT INTO tasks (project_id, task_key, position, title, description, files_hint, writes, acceptance, depends_on, after_keys, phase, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    this.db.transaction(() => {
      del.run(projectId);
      for (const t of tasks) {
        ins.run(projectId, t.taskKey, t.position, t.title, t.description, JSON.stringify(t.filesHint), JSON.stringify(t.writes ?? []), JSON.stringify(t.acceptance), JSON.stringify(t.dependsOn), JSON.stringify(t.after ?? []), t.phase ?? DEFAULT_TASK_PHASE);
      }
    })();
  }

  /** Appends tasks after the existing ones (improvement iterations keep the done history). */
  append(projectId: string, tasks: Omit<TaskDto, 'status' | 'commitSha' | 'position'>[]): void {
    const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE project_id = ?').get(projectId) as { m: number };
    const ins = this.db.prepare(
      `INSERT INTO tasks (project_id, task_key, position, title, description, files_hint, writes, acceptance, depends_on, after_keys, phase, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    this.db.transaction(() => {
      tasks.forEach((t, i) => {
        ins.run(projectId, t.taskKey, max.m + 1 + i, t.title, t.description, JSON.stringify(t.filesHint), JSON.stringify(t.writes ?? []), JSON.stringify(t.acceptance), JSON.stringify(t.dependsOn), JSON.stringify(t.after ?? []), t.phase ?? DEFAULT_TASK_PHASE);
      });
    })();
  }

  list(projectId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY position ASC').all(projectId) as TaskRow[];
  }

  get(projectId: string, taskKey: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND task_key = ?').get(projectId, taskKey) as TaskRow | undefined;
  }

  setStatus(projectId: string, taskKey: string, status: TaskStatus, commitSha?: string | null): TaskRow {
    this.db
      .prepare('UPDATE tasks SET status = ?, commit_sha = COALESCE(?, commit_sha) WHERE project_id = ? AND task_key = ?')
      .run(status, commitSha ?? null, projectId, taskKey);
    return this.get(projectId, taskKey)!;
  }

  /** Records (or clears) the worktree a parallel task is working in. */
  setWorktree(projectId: string, taskKey: string, dir: string | null): void {
    this.db.prepare('UPDATE tasks SET worktree_dir = ? WHERE project_id = ? AND task_key = ?').run(dir, projectId, taskKey);
  }
}
