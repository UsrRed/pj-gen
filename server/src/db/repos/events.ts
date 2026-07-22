import type { DB } from '../db.js';

export interface EventRow {
  id: number;
  project_id: string | null;
  type: string;
  payload: string;
  created_at: number;
}

export class EventsRepo {
  constructor(private db: DB) {}

  insert(type: string, projectId: string | null, payload: object): EventRow {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO events (project_id, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(projectId, type, JSON.stringify(payload), now);
    return { id: Number(info.lastInsertRowid), project_id: projectId, type, payload: JSON.stringify(payload), created_at: now };
  }

  /** Replay events after a given id. projectId=null → global channel (all events). */
  listAfter(afterId: number, projectId: string | null, limit = 500): EventRow[] {
    if (projectId === null) {
      return this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?').all(afterId, limit) as EventRow[];
    }
    return this.db
      .prepare('SELECT * FROM events WHERE id > ? AND (project_id IS NULL OR project_id = ?) ORDER BY id ASC LIMIT ?')
      .all(afterId, projectId, limit) as EventRow[];
  }

  lastId(): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get() as { m: number };
    return r.m;
  }

  pruneOlderThan(ms: number): number {
    const info = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(Date.now() - ms);
    return info.changes;
  }
}
