import type { DB } from '../db.js';

export interface AppRunRow {
  project_id: string;
  pid: number;
  started_at: number;
}

/** Pids of running generated-app processes (Aperçu tab) — swept at boot like claude runs. */
export class AppRunsRepo {
  constructor(private db: DB) {}

  set(projectId: string, pid: number): void {
    this.db
      .prepare(
        `INSERT INTO app_runs (project_id, pid, started_at) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at`
      )
      .run(projectId, pid, Date.now());
  }

  all(): AppRunRow[] {
    return this.db.prepare('SELECT * FROM app_runs').all() as AppRunRow[];
  }

  delete(projectId: string): void {
    this.db.prepare('DELETE FROM app_runs WHERE project_id = ?').run(projectId);
  }
}
