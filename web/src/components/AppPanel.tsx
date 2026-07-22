import { useEffect, useRef, useState } from 'react';
import type { ProjectDetail } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import { T } from '../i18n/fr.js';

/** Aperçu tab: run the generated project's app (run_cmd) and watch it live. */
export function AppPanel({ detail }: { detail: ProjectDetail }) {
  const app = useStore((s) => s.app);
  const setApp = useStore((s) => s.setApp);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void api.appState(detail.id).then(setApp).catch(() => undefined);
  }, [detail.id, setApp]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [app.lines.length]);

  if (!detail.stack?.run_cmd) {
    return <div className="card p-6 text-sm text-zinc-500">{T.appNoRun}</div>;
  }
  const building = detail.status === 'building' || detail.status === 'deploying';

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-center gap-3 p-4">
        {app.running ? (
          <>
            <span className="flex items-center gap-2 text-sm text-emerald-400">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
              {T.appRunning}
            </span>
            {app.url && (
              <a href={app.url} target="_blank" rel="noreferrer" className="btn-primary !py-1.5 text-sm">
                🔗 {T.appOpen} — {app.url}
              </a>
            )}
            <button className="btn-ghost ml-auto" disabled={busy} onClick={() => void act(() => api.appStop(detail.id))}>
              ■ {T.appStop}
            </button>
          </>
        ) : (
          <>
            <button
              className="btn-primary"
              disabled={busy || building}
              onClick={() => void act(async () => setApp(await api.appStart(detail.id)))}
            >
              ▶ {T.appStart}
            </button>
            <span className="text-xs text-zinc-500">{building ? T.appUnavailableBuilding : T.appHint}</span>
          </>
        )}
      </div>
      <div className="ml-1 font-mono text-xs text-zinc-600">$ {detail.stack.run_cmd}</div>
      {error && <div className="text-sm text-red-400">⚠️ {error}</div>}
      {app.lines.length > 0 && (
        <pre
          ref={logRef}
          className="card max-h-96 overflow-y-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-zinc-400"
        >
          {app.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}
