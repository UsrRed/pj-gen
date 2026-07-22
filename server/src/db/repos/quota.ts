import type { DB } from '../db.js';

export interface QuotaRow {
  limited_until: number | null;
  last_hit_at: number | null;
  matched_pattern: string | null;
  window_resets_at: number | null;
  window_type: string | null;
}

export class QuotaRepo {
  constructor(private db: DB) {}

  get(): QuotaRow {
    return this.db
      .prepare('SELECT limited_until, last_hit_at, matched_pattern, window_resets_at, window_type FROM quota_state WHERE id = 1')
      .get() as QuotaRow;
  }

  /** Records the latest rate_limit_event window end; returns true when the value meaningfully changed. */
  setWindow(resetsAtMs: number, windowType: string | null): boolean {
    const prev = this.get().window_resets_at;
    this.db.prepare('UPDATE quota_state SET window_resets_at = ?, window_type = ? WHERE id = 1').run(resetsAtMs, windowType);
    return prev === null || Math.abs(prev - resetsAtMs) > 60_000;
  }

  recordLimitHit(tokensInWindow: number, hitAt = Date.now()): void {
    this.db.prepare('INSERT INTO limit_hits (hit_at, tokens_in_window) VALUES (?, ?)').run(hitAt, tokensInWindow);
  }

  /** Median of the tokens consumed at the last 5 limit hits — null until a limit has been hit once. */
  estimatedCeiling(): number | null {
    const rows = this.db
      .prepare('SELECT tokens_in_window AS t FROM limit_hits ORDER BY hit_at DESC LIMIT 5')
      .all() as { t: number }[];
    if (!rows.length) return null;
    const sorted = rows.map((r) => r.t).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  isLimited(marginMs = 0): boolean {
    const q = this.get();
    return q.limited_until !== null && q.limited_until - marginMs > Date.now();
  }

  setLimited(until: number, pattern: string | null): void {
    this.db
      .prepare('UPDATE quota_state SET limited_until = ?, last_hit_at = ?, matched_pattern = ? WHERE id = 1')
      .run(until, Date.now(), pattern);
  }

  clear(): void {
    this.db.prepare('UPDATE quota_state SET limited_until = NULL WHERE id = 1').run();
  }
}
