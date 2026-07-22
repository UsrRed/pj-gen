import type { DB } from '../db.js';
import type { TaskDto, TaskStatus } from '@pjgen/shared';

export interface TaskRow {
  project_id: string;
  task_key: string;
  position: number;
  title: string;
  description: string;
  files_hint: string;
  acceptance: string;
  depends_on: string;
  status: TaskStatus;
  commit_sha: string | null;
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
    acceptance: parseArr(r.acceptance),
    dependsOn: parseArr(r.depends_on),
    status: r.status,
    commitSha: r.commit_sha,
  };
}

export class TasksRepo {
  constructor(private db: DB) {}

  replaceAll(projectId: string, tasks: Omit<TaskDto, 'status' | 'commitSha'>[]): void {
    const del = this.db.prepare('DELETE FROM tasks WHERE project_id = ?');
    const ins = this.db.prepare(
      `INSERT INTO tasks (project_id, task_key, position, title, description, files_hint, acceptance, depends_on, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    this.db.transaction(() => {
      del.run(projectId);
      for (const t of tasks) {
        ins.run(projectId, t.taskKey, t.position, t.title, t.description, JSON.stringify(t.filesHint), JSON.stringify(t.acceptance), JSON.stringify(t.dependsOn));
      }
    })();
  }

  /** Appends tasks after the existing ones (improvement iterations keep the done history). */
  append(projectId: string, tasks: Omit<TaskDto, 'status' | 'commitSha' | 'position'>[]): void {
    const max = this.db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE project_id = ?').get(projectId) as { m: number };
    const ins = this.db.prepare(
      `INSERT INTO tasks (project_id, task_key, position, title, description, files_hint, acceptance, depends_on, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    );
    this.db.transaction(() => {
      tasks.forEach((t, i) => {
        ins.run(projectId, t.taskKey, max.m + 1 + i, t.title, t.description, JSON.stringify(t.filesHint), JSON.stringify(t.acceptance), JSON.stringify(t.dependsOn));
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
}
