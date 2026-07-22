import type { DB } from '../db.js';
import type { LogLineDto } from '@pjgen/shared';

export interface LogEntry {
  kind: 'stdout_json' | 'stderr' | 'meta';
  line: string;
  display: string;
}

export class LogsRepo {
  private seqCache = new Map<number, number>();

  constructor(private db: DB) {}

  private nextSeq(runId: number): number {
    let seq = this.seqCache.get(runId);
    if (seq === undefined) {
      const r = this.db.prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM logs WHERE step_run_id = ?').get(runId) as { m: number };
      seq = r.m + 1;
    }
    this.seqCache.set(runId, seq + 1);
    return seq;
  }

  batchInsert(runId: number, entries: LogEntry[]): LogLineDto[] {
    const ins = this.db.prepare('INSERT INTO logs (step_run_id, seq, kind, line, display, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    const out: LogLineDto[] = [];
    const now = Date.now();
    this.db.transaction(() => {
      for (const e of entries) {
        const seq = this.nextSeq(runId);
        ins.run(runId, seq, e.kind, e.line, e.display, now);
        out.push({ seq, kind: e.kind, display: e.display, createdAt: now });
      }
    })();
    return out;
  }

  listAfter(runId: number, afterSeq: number, limit = 1000): LogLineDto[] {
    const rows = this.db
      .prepare('SELECT seq, kind, display, created_at FROM logs WHERE step_run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(runId, afterSeq, limit) as { seq: number; kind: LogLineDto['kind']; display: string; created_at: number }[];
    return rows.map((r) => ({ seq: r.seq, kind: r.kind, display: r.display, createdAt: r.created_at }));
  }

  /** Keep at most `keep` most recent rows per run; returns deleted count. */
  pruneRun(runId: number, keep = 20000): number {
    const info = this.db
      .prepare(
        `DELETE FROM logs WHERE step_run_id = ? AND seq < (
           SELECT COALESCE(MAX(seq), 0) - ? FROM logs WHERE step_run_id = ?
         )`
      )
      .run(runId, keep, runId);
    return info.changes;
  }
}
