/** Incremental NDJSON line splitter (handles chunks that split lines arbitrarily). */
export class NdjsonSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length > 0) lines.push(line);
    }
    return lines;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }
}

export interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}

export interface RateLimitInfo {
  status?: string; // 'allowed' | 'allowed_warning' | 'rejected' | …
  resetsAt?: number; // epoch SECONDS
  rateLimitType?: string; // 'five_hour' | 'weekly' | …
  [k: string]: unknown;
}

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  message?: { role?: string; content?: ContentBlock[] | string; [k: string]: unknown };
  // result event fields
  is_error?: boolean;
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: Record<string, unknown>;
  structured_output?: unknown;
  structured_result?: unknown;
  // rate_limit_event field (emitted on every request under subscription auth)
  rate_limit_info?: RateLimitInfo;
  [k: string]: unknown;
}

/** Tolerant decoder: returns null for non-JSON lines (kept as raw meta by callers). */
export function decodeEvent(line: string): ClaudeEvent | null {
  try {
    const v = JSON.parse(line);
    if (v && typeof v === 'object' && typeof v.type === 'string') return v as ClaudeEvent;
    return null;
  } catch {
    return null;
  }
}

export function assistantTextOf(evt: ClaudeEvent): string {
  const content = evt.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

export function structuredOf(evt: ClaudeEvent): unknown {
  return evt.structured_output ?? evt.structured_result ?? undefined;
}
