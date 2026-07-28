import type { DB } from '../db.js';
import type { StatsDto, TokenUsage } from '@pjgen/shared';
import type { RunUsage } from '../../claude/types.js';
import { tokensOf } from './stepRuns.js';

export type UsageKind = 'step' | 'cadrage' | 'deploy' | 'micro' | 'ci' | 'import';

/** Timestamped token consumption — powers the 5h-window gauge and the /stats page. */
export class UsageRepo {
  constructor(private db: DB) {}

  record(projectId: string, kind: UsageKind, usage: RunUsage, at = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO usage_log (at, project_id, kind, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(at, projectId, kind, usage.inputTokens, usage.outputTokens, usage.cacheCreationTokens, usage.cacheReadTokens);
  }

  tokensSince(sinceMs: number): TokenUsage {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
         FROM usage_log WHERE at >= ?`
      )
      .get(sinceMs) as Parameters<typeof tokensOf>[0];
    return tokensOf(r);
  }

  /** Daily totals over the last `days` days (local dates). */
  statsDays(days = 14): StatsDto['days'] {
    const since = Date.now() - days * 86_400_000;
    const rows = this.db
      .prepare(
        `SELECT date(at / 1000, 'unixepoch', 'localtime') AS day,
                COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
         FROM usage_log WHERE at >= ? GROUP BY day ORDER BY day ASC`
      )
      .all(since) as ({ day: string } & Parameters<typeof tokensOf>[0])[];
    return rows.map((r) => ({ day: r.day, tokens: tokensOf(r) }));
  }

  /** Effective tokens (cache reads excluded — they are re-counted at every turn and would dwarf real usage). */
  statsPerProject(limit = 10): StatsDto['perProject'] {
    return this.db
      .prepare(
        `SELECT p.slug, p.title,
                SUM(u.input_tokens + u.output_tokens + u.cache_creation_tokens) AS total
         FROM usage_log u JOIN projects p ON p.id = u.project_id
         GROUP BY u.project_id ORDER BY total DESC LIMIT ?`
      )
      .all(limit) as StatsDto['perProject'];
  }

  /** All-time cache hit rate on the input side — objectifies prompt-prefix stability. */
  cacheRate(): number | null {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(cache_read_tokens), 0) AS read,
                COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_creation_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) AS total
         FROM usage_log`
      )
      .get() as { read: number; total: number };
    return r.total > 0 ? r.read / r.total : null;
  }

  /** Per-step averages come from step_runs (they carry step_key), not usage_log.
   *  Effective tokens only (cache reads excluded); the "has data" filter keeps all four columns. */
  statsPerStep(): StatsDto['perStep'] {
    const rows = this.db
      .prepare(
        `SELECT step_key AS stepKey, COUNT(*) AS runs,
                SUM(input_tokens + output_tokens + cache_creation_tokens) AS totalTokens
         FROM step_runs
         WHERE input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens > 0
         GROUP BY step_key ORDER BY totalTokens DESC`
      )
      .all() as { stepKey: string; runs: number; totalTokens: number }[];
    return rows.map((r) => ({ ...r, avgTokens: Math.round(r.totalTokens / r.runs) }));
  }

  /**
   * Wall-clock per step. Median and p90 rather than a mean: a single cap kill (30 min)
   * would drag the mean of a step that normally lands in 4 minutes.
   * Rows written before the timing migration have NULL duration_ms and are excluded.
   */
  timePerStep(): StatsDto['timePerStep'] {
    const rows = this.db
      .prepare(
        `SELECT step_key AS stepKey, duration_ms AS durationMs, COALESCE(verify_ms, 0) AS verifyMs
         FROM step_runs WHERE duration_ms IS NOT NULL ORDER BY step_key ASC, duration_ms ASC`
      )
      .all() as { stepKey: string; durationMs: number; verifyMs: number }[];

    const byStep = new Map<string, { durations: number[]; verifyMs: number }>();
    for (const r of rows) {
      const entry = byStep.get(r.stepKey) ?? { durations: [], verifyMs: 0 };
      entry.durations.push(r.durationMs); // already sorted ascending by the query
      entry.verifyMs += r.verifyMs;
      byStep.set(r.stepKey, entry);
    }

    return [...byStep.entries()]
      .map(([stepKey, { durations, verifyMs }]) => ({
        stepKey,
        runs: durations.length,
        medianMs: quantile(durations, 0.5),
        p90Ms: quantile(durations, 0.9),
        totalMs: durations.reduce((a, b) => a + b, 0),
        verifyMs,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
  }

  /** Wall-clock summed per project — the number to compare before/after a parallelism change. */
  timePerProject(limit = 10): StatsDto['timePerProject'] {
    return this.db
      .prepare(
        `SELECT p.slug, p.title, SUM(r.duration_ms) AS totalMs, COUNT(*) AS runs
         FROM step_runs r JOIN projects p ON p.id = r.project_id
         WHERE r.duration_ms IS NOT NULL
         GROUP BY r.project_id ORDER BY totalMs DESC LIMIT ?`
      )
      .all(limit) as StatsDto['timePerProject'];
  }
}

/** Nearest-rank quantile over an ASCENDING-sorted array. */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
