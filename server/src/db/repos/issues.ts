import type { DB } from '../db.js';
import type { IssueDecision, IssueDto } from '@pjgen/shared';

export interface IssueRow {
  id: number;
  project_id: string;
  number: number;
  title: string;
  body: string;
  author: string;
  gh_state: 'open' | 'closed';
  gh_updated_at: string | null;
  decision: IssueDecision;
  posted_comment_at: number | null;
  /** Full iteration opened for this issue (decision escalated/awaiting_reply), null otherwise. */
  iteration: number | null;
  /** Highest task position before that iteration: tasks above it belong to the issue. */
  task_floor: number | null;
  last_synced_at: number;
  created_at: number;
  updated_at: number;
}

export function toIssueDto(r: IssueRow): IssueDto {
  return {
    id: r.id,
    projectId: r.project_id,
    number: r.number,
    title: r.title,
    body: r.body,
    author: r.author,
    ghState: r.gh_state,
    decision: r.decision,
    postedCommentAt: r.posted_comment_at,
    lastSyncedAt: r.last_synced_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const BODY_MAX = 4_000;

export class IssuesRepo {
  constructor(private db: DB) {}

  /** Idempotent sync upsert; returns the row and whether the GitHub side changed. */
  upsert(
    projectId: string,
    issue: { number: number; title: string; body: string; author: string; ghUpdatedAt: string }
  ): { row: IssueRow; changed: boolean } {
    const now = Date.now();
    const existing = this.byNumber(projectId, issue.number);
    if (!existing) {
      const info = this.db
        .prepare(
          `INSERT INTO issues (project_id, number, title, body, author, gh_state, gh_updated_at, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
        )
        .run(projectId, issue.number, issue.title, issue.body.slice(0, BODY_MAX), issue.author, issue.ghUpdatedAt, now, now, now);
      return { row: this.byId(Number(info.lastInsertRowid))!, changed: true };
    }
    const changed = existing.gh_updated_at !== issue.ghUpdatedAt;
    this.db
      .prepare(`UPDATE issues SET title = ?, body = ?, gh_state = 'open', gh_updated_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`)
      .run(issue.title, issue.body.slice(0, BODY_MAX), issue.ghUpdatedAt, now, changed ? now : existing.updated_at, existing.id);
    return { row: this.byId(existing.id)!, changed };
  }

  /** Issues no longer open on GitHub (absent from the sync) → gh_state closed. */
  markClosedExcept(projectId: string, openNumbers: number[]): IssueRow[] {
    const rows = this.list(projectId).filter((r) => r.gh_state === 'open' && !openNumbers.includes(r.number));
    const now = Date.now();
    for (const r of rows) {
      this.db.prepare(`UPDATE issues SET gh_state = 'closed', last_synced_at = ?, updated_at = ? WHERE id = ?`).run(now, now, r.id);
    }
    return rows.map((r) => this.byId(r.id)!);
  }

  byId(id: number): IssueRow | undefined {
    return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | undefined;
  }

  byNumber(projectId: string, number: number): IssueRow | undefined {
    return this.db.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').get(projectId, number) as IssueRow | undefined;
  }

  list(projectId: string): IssueRow[] {
    return this.db.prepare('SELECT * FROM issues WHERE project_id = ? ORDER BY number ASC').all(projectId) as IssueRow[];
  }

  listAll(): IssueRow[] {
    return this.db.prepare('SELECT * FROM issues ORDER BY number ASC LIMIT 500').all() as IssueRow[];
  }

  byDecision(projectId: string, decisions: IssueDecision[]): IssueRow[] {
    const marks = decisions.map(() => '?').join(',');
    return this.db
      .prepare(`SELECT * FROM issues WHERE project_id = ? AND decision IN (${marks}) AND gh_state = 'open' ORDER BY number ASC`)
      .all(projectId, ...decisions) as IssueRow[];
  }

  patch(id: number, patch: Partial<Pick<IssueRow, 'decision' | 'posted_comment_at' | 'iteration' | 'task_floor'>>): IssueRow {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      values.push(v as never);
    }
    this.db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return this.byId(id)!;
  }

  trustedUsers(): string[] {
    return (this.db.prepare('SELECT login FROM trusted_users ORDER BY login ASC').all() as { login: string }[]).map((r) => r.login);
  }

  isTrusted(login: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM trusted_users WHERE login = ?').get(login);
  }

  addTrustedUser(login: string): void {
    this.db.prepare('INSERT INTO trusted_users (login, added_at) VALUES (?, ?) ON CONFLICT(login) DO NOTHING').run(login, Date.now());
  }

  removeTrustedUser(login: string): void {
    this.db.prepare('DELETE FROM trusted_users WHERE login = ?').run(login);
  }
}
