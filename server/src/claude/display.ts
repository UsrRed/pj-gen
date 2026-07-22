import { assistantTextOf, type ClaudeEvent } from './ndjson.js';

const MAX = 400;

function truncate(s: string, max = MAX): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace('.', ',')}M`;
}

/** Compact, human-readable rendering of one stream-json event for the log viewer. */
export function displayForEvent(evt: ClaudeEvent): string | null {
  switch (evt.type) {
    case 'system': {
      if (evt.subtype === 'init') return `▶ session ${evt.session_id ?? '?'} — modèle ${evt.model ?? '?'}`;
      // thinking_tokens / post_turn_summary / task_* etc. are high-frequency noise
      return null;
    }
    case 'assistant': {
      const parts: string[] = [];
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) parts.push(`● ${truncate(block.text, 1500)}`);
          else if (block.type === 'tool_use') parts.push(`→ ${block.name ?? 'outil'} ${truncate(JSON.stringify(block.input ?? {}), 220)}`);
          else if (block.type === 'thinking') parts.push(`… réflexion`);
        }
      } else if (typeof content === 'string' && content.trim()) {
        parts.push(`● ${truncate(content, 1500)}`);
      }
      return parts.length ? parts.join('\n') : null;
    }
    case 'user': {
      const content = evt.message?.content;
      if (Array.isArray(content)) {
        const results = content.filter((b) => b.type === 'tool_result');
        if (results.length) {
          return results
            .map((r) => {
              const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
              return r.is_error ? `✗ erreur outil: ${truncate(text, 300)}` : `✓ ${truncate(text, 160)}`;
            })
            .join('\n');
        }
      }
      return null;
    }
    case 'rate_limit_event': {
      const info = evt.rate_limit_info;
      if (!info) return null;
      const reset = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '?';
      if (info.status && info.status !== 'allowed') return `⏳ quota ${info.rateLimitType ?? '?'}: ${info.status} — reset ${reset}`;
      return null; // 'allowed' on every request → noise
    }
    case 'result': {
      const turns = typeof evt.num_turns === 'number' ? ` — ${evt.num_turns} tours` : '';
      const u = evt.usage as Record<string, unknown> | undefined;
      const num = (k: string) => (typeof u?.[k] === 'number' ? (u[k] as number) : 0);
      const total = num('input_tokens') + num('output_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens');
      const tokens = total
        ? ` — ${fmtK(total)} tokens (in ${fmtK(num('input_tokens'))} · out ${fmtK(num('output_tokens'))} · cache ${fmtK(num('cache_creation_input_tokens') + num('cache_read_input_tokens'))})`
        : typeof evt.total_cost_usd === 'number'
          ? ` — $${evt.total_cost_usd.toFixed(4)}`
          : '';
      if (evt.is_error) return `■ échec (${evt.subtype ?? 'error'})${turns}${tokens}: ${truncate(String(evt.result ?? ''), 500)}`;
      return `■ terminé (${evt.subtype ?? 'success'})${turns}${tokens}`;
    }
    default:
      return null;
  }
}
