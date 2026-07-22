import type { DB } from '../db.js';
import { ZERO_USAGE, type RunUsage } from '../../claude/types.js';

export type SessionKind = 'cadrage' | 'deploy' | 'step' | 'micro' | 'ci' | 'import';

export interface SessionRow {
  id: string;
  project_id: string;
  kind: SessionKind;
  status: 'active' | 'closed' | 'lost';
  num_turns: number;
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  created_at: number;
  last_used_at: number | null;
}

export class SessionsRepo {
  constructor(private db: DB) {}

  insert(id: string, projectId: string, kind: SessionKind): void {
    this.db
      .prepare(`INSERT INTO sessions (id, project_id, kind, status, created_at) VALUES (?, ?, ?, 'active', ?)`)
      .run(id, projectId, kind, Date.now());
  }

  byId(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  latestActive(projectId: string, kind: SessionKind): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE project_id = ? AND kind = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`)
      .get(projectId, kind) as SessionRow | undefined;
  }

  bump(id: string, turnsDelta: number, costDelta: number, usage: RunUsage = ZERO_USAGE): void {
    this.db
      .prepare(
        `UPDATE sessions SET num_turns = num_turns + ?, total_cost_usd = total_cost_usd + ?,
                input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
                cache_creation_tokens = cache_creation_tokens + ?, cache_read_tokens = cache_read_tokens + ?,
                last_used_at = ? WHERE id = ?`
      )
      .run(turnsDelta, costDelta, usage.inputTokens, usage.outputTokens, usage.cacheCreationTokens, usage.cacheReadTokens, Date.now(), id);
  }

  setStatus(id: string, status: SessionRow['status']): void {
    this.db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id);
  }
}
