import { useState } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import { T } from '../i18n/fr.js';

/** Local datetime string (datetime-local input format) for tomorrow 09:00. */
function tomorrowAt9(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CutModal({ onClose }: { onClose: () => void }) {
  const quota = useStore((s) => s.quota);
  const setQuota = useStore((s) => s.setQuota);
  const [target, setTarget] = useState(tomorrowAt9());
  const [full, setFull] = useState(true);
  const [pct, setPct] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ceilingUnknown = quota?.window.estimatedCeiling == null;

  const submit = async () => {
    const targetAt = new Date(target).getTime();
    if (!Number.isFinite(targetAt) || targetAt <= Date.now()) {
      setError(T.cutInPast);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.setCut({ targetAt, reservePct: full ? 100 : pct });
      setQuota(res.quota);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-md space-y-4 p-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold text-zinc-100">{T.cutTitle}</h2>
          <p className="mt-1 text-xs text-zinc-400">{T.cutDesc}</p>
        </div>

        <label className="block text-sm text-zinc-300">
          {T.cutTargetLabel}
          <input
            type="datetime-local"
            className="input mt-1 w-full"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>

        <div className="space-y-2 text-sm text-zinc-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={full} onChange={() => setFull(true)} />
            {T.cutReserveAll}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!full} onChange={() => setFull(false)} />
            {T.cutReserveSome}
            <span className={full ? 'text-zinc-500' : ''}>{T.cutReservePct(pct)}</span>
          </label>
          {!full && (
            <input
              type="range"
              min={10}
              max={90}
              step={5}
              value={pct}
              onChange={(e) => setPct(Number(e.target.value))}
              className="w-full accent-indigo-500"
            />
          )}
          {!full && ceilingUnknown && <p className="text-xs text-amber-300">{T.cutCeilingUnknownWarn}</p>}
        </div>

        {error && <p className="text-sm text-red-300">⚠️ {error}</p>}

        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            {T.cancel}
          </button>
          <button className="btn-primary" disabled={busy} onClick={() => void submit()}>
            {T.cutSubmit}
          </button>
        </div>
      </div>
    </div>
  );
}
