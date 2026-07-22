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

  statsPerProject(limit = 10): StatsDto['perProject'] {
    return this.db
      .prepare(
        `SELECT p.slug, p.title,
                SUM(u.input_tokens + u.output_tokens + u.cache_creation_tokens + u.cache_read_tokens) AS total
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

  /** Per-step averages come from step_runs (they carry step_key), not usage_log. */
  statsPerStep(): StatsDto['perStep'] {
    const rows = this.db
      .prepare(
        `SELECT step_key AS stepKey, COUNT(*) AS runs,
                SUM(input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens) AS totalTokens
         FROM step_runs
         WHERE input_tokens + output_tokens + cache_creation_tokens + cache_read_tokens > 0
         GROUP BY step_key ORDER BY totalTokens DESC`
      )
      .all() as { stepKey: string; runs: number; totalTokens: number }[];
    return rows.map((r) => ({ ...r, avgTokens: Math.round(r.totalTokens / r.runs) }));
  }
}
