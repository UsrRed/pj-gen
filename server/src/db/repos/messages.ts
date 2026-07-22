import type { DB } from '../db.js';
import type { CadrageStructured, ChatMessageDto } from '@pjgen/shared';

export interface MessageRow {
  id: number;
  project_id: string;
  session_kind: 'cadrage' | 'deploy';
  role: 'user' | 'assistant' | 'system';
  content: string;
  structured: string | null;
  session_id: string | null;
  created_at: number;
}

export function toMessageDto(r: MessageRow): ChatMessageDto {
  let structured: CadrageStructured | null = null;
  if (r.structured) {
    try {
      structured = JSON.parse(r.structured);
    } catch {
      structured = null;
    }
  }
  return {
    id: r.id,
    projectId: r.project_id,
    sessionKind: r.session_kind,
    role: r.role,
    content: r.content,
    structured,
    createdAt: r.created_at,
  };
}

export class MessagesRepo {
  constructor(private db: DB) {}

  insert(
    projectId: string,
    sessionKind: 'cadrage' | 'deploy',
    role: 'user' | 'assistant' | 'system',
    content: string,
    structured: object | null = null,
    sessionId: string | null = null
  ): MessageRow {
    const info = this.db
      .prepare(
        `INSERT INTO messages (project_id, session_kind, role, content, structured, session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(projectId, sessionKind, role, content, structured ? JSON.stringify(structured) : null, sessionId, Date.now());
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)) as MessageRow;
  }

  list(projectId: string, limit = 200): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as MessageRow[];
    return rows.reverse();
  }

  listByKind(projectId: string, kind: 'cadrage' | 'deploy', limit = 200): MessageRow[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE project_id = ? AND session_kind = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, kind, limit) as MessageRow[];
    return rows.reverse();
  }
}
