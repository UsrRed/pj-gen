import { useEffect, useState } from 'react';
import type { StatsDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { fmtCount, tokensTitle } from '../lib/format.js';
import { STEP_LABELS, T } from '../i18n/fr.js';
import type { StepKey } from '@pjgen/shared';

export function StatsPage() {
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.stats().then(setStats).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="text-sm text-red-400">⚠️ {error}</div>;
  if (!stats) return <div className="text-sm text-zinc-500">{T.loading}</div>;

  const empty = !stats.days.length && !stats.perStep.length;
  const maxDay = Math.max(1, ...stats.days.map((d) => d.tokens.total));
  const maxStep = Math.max(1, ...stats.perStep.map((s) => s.totalTokens));

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">{T.statsTitle}</h1>
      {empty && <div className="text-sm text-zinc-500">{T.statsEmpty}</div>}

      {stats.cacheRate !== null && (
        <section className="card flex items-center justify-between p-4">
          <div>
            <h2 className="font-semibold text-zinc-300">{T.statsCacheRate}</h2>
            <p className="mt-1 text-xs text-zinc-500">{T.statsCacheRateHint}</p>
          </div>
          <span className="text-2xl font-bold text-emerald-400">{Math.round(stats.cacheRate * 100)} %</span>
        </section>
      )}

      {stats.days.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-4 font-semibold text-zinc-300">{T.statsDays}</h2>
          <div className="flex h-40 items-end gap-1.5">
            {stats.days.map((d) => (
              <div key={d.day} className="group flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.day} — ${tokensTitle(d.tokens)}`}>
                <span className="text-[10px] text-zinc-500 opacity-0 transition-opacity group-hover:opacity-100">{fmtCount(d.tokens.total)}</span>
                <div
                  className="w-full rounded-t bg-indigo-500/80 transition-colors group-hover:bg-indigo-400"
                  style={{ height: `${Math.max(3, Math.round((d.tokens.total / maxDay) * 120))}px` }}
                />
                <span className="truncate text-[10px] text-zinc-500">{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {stats.perStep.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 font-semibold text-zinc-300">{T.statsPerStep}</h2>
          <div className="space-y-2">
            {stats.perStep.map((s) => (
              <div key={s.stepKey} className="flex items-center gap-3 text-xs">
                <span className="w-40 shrink-0 truncate text-zinc-400">{STEP_LABELS[s.stepKey as StepKey] ?? s.stepKey}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full rounded-full bg-violet-500/80" style={{ width: `${Math.max(2, Math.round((s.totalTokens / maxStep) * 100))}%` }} />
                </div>
                <span className="w-44 shrink-0 text-right text-zinc-500">
                  {s.runs} {T.statsRuns} · {T.statsTotal} {fmtCount(s.totalTokens)} · {T.statsAvg} {fmtCount(s.avgTokens)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {stats.perProject.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 font-semibold text-zinc-300">{T.statsPerProject}</h2>
          <div className="space-y-1.5">
            {stats.perProject.map((p) => (
              <div key={p.slug} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-zinc-300">
                  {p.title} <span className="text-zinc-600">({p.slug})</span>
                </span>
                <span className="shrink-0 font-mono text-zinc-400">{fmtCount(p.total)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
