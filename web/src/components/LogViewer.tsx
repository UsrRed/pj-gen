import { useEffect, useRef } from 'react';
import type { LogLineDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import { T } from '../i18n/fr.js';

/** Stable empty reference — an inline `?? []` makes the zustand snapshot unstable (render loop). */
const EMPTY_LINES: LogLineDto[] = [];

function lineClass(display: string): string {
  if (display.startsWith('⚠') || display.startsWith('✗')) return 'text-red-400';
  if (display.startsWith('→')) return 'text-cyan-300/90';
  if (display.startsWith('✓')) return 'text-zinc-500';
  if (display.startsWith('■')) return 'text-emerald-300';
  if (display.startsWith('▶')) return 'text-indigo-300';
  if (display.startsWith('●')) return 'text-zinc-200';
  return 'text-zinc-400';
}

export function LogViewer({ runId }: { runId: number | null }) {
  const lines = useStore((s) => (runId !== null ? (s.logs[runId] ?? EMPTY_LINES) : EMPTY_LINES));
  const seedLogs = useStore((s) => s.seedLogs);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    if (runId === null) return;
    void api
      .runLogs(runId)
      .then((r) => seedLogs(runId, r.lines))
      .catch(() => undefined);
  }, [runId, seedLogs]);

  useEffect(() => {
    if (autoScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines.length]);

  if (runId === null) {
    return <div className="card flex h-64 items-center justify-center text-sm text-zinc-600">{T.logs} — aucun run sélectionné</div>;
  }

  return (
    <div
      ref={containerRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      }}
      className="card h-64 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed"
    >
      {lines.length === 0 && <div className="text-zinc-600">…</div>}
      {lines
        .filter((l) => l.display.trim().length > 0)
        .map((l) => (
          <div key={l.seq} className={`whitespace-pre-wrap break-all ${lineClass(l.display)}`}>
            {l.display}
          </div>
        ))}
    </div>
  );
}
