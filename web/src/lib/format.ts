import type { TokenUsage } from '@pjgen/shared';

export function fmtCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace('.', ',').replace(/,0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(2).replace('.', ',').replace(/,?0+$/, '')}M`;
}

/** Effective consumption: fresh input + output + cache writes. Cache re-reads (~96 % of the raw
 *  cumulative total, recounted at every agent turn) are excluded — they don't reflect real usage. */
export function effectiveTokens(t: TokenUsage): number {
  return t.input + t.output + t.cacheCreation;
}

// `t` may be undefined: replayed SSE events recorded before the tokens migration carry old DTO shapes.
export function fmtTokens(t: TokenUsage | null | undefined): string {
  if (!t?.total) return '—';
  return fmtCount(effectiveTokens(t));
}

/** Native tooltip text with the in/out/cache breakdown. */
export function tokensTitle(t: TokenUsage | null | undefined): string {
  if (!t?.total) return 'Aucune donnée de tokens (runs antérieurs à cette version)';
  return `entrée ${fmtCount(t.input)} · sortie ${fmtCount(t.output)} · cache écrit ${fmtCount(t.cacheCreation)} · cache lu ${fmtCount(t.cacheRead)} — cumul brut avec cache : ${fmtCount(t.total)}`;
}

export function fmtTime(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(epochMs: number | null | undefined): string {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Formats a raw duration in ms (stats rows carry spans, not endpoints). */
export function fmtSpan(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}min${s % 60 ? ` ${s % 60}s` : ''}` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ''}`;
}

export function fmtDuration(startMs: number | null | undefined, endMs: number | null | undefined): string {
  if (!startMs) return '—';
  return fmtSpan((endMs ?? Date.now()) - startMs);
}

export function fmtSize(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}
