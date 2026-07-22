import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore.js';
import { api } from '../api/client.js';
import { fmtCount, fmtDateTime, fmtTime, fmtTokens, tokensTitle } from '../lib/format.js';
import { T } from '../i18n/fr.js';
import { ConfirmButton } from './ConfirmButton.js';
import { CutModal } from './CutModal.js';

const REFRESH_MS = 60_000;

/** Compact always-visible gauge of the current 5h subscription window. */
function WindowGauge({ onScheduleCut }: { onScheduleCut: () => void }) {
  const quota = useStore((s) => s.quota);
  const setQuota = useStore((s) => s.setQuota);

  // The window fills from runs finishing elsewhere too — refresh periodically, not only on SSE.
  useEffect(() => {
    const t = setInterval(() => void api.quota().then(setQuota).catch(() => undefined), REFRESH_MS);
    return () => clearInterval(t);
  }, [setQuota]);

  const w = quota?.window;
  if (!w) return null;
  const consumed = w.tokensInWindow.total;

  const pct = w.estimatedCeiling ? Math.min(100, Math.round((consumed / w.estimatedCeiling) * 100)) : null;
  const barColor = pct === null ? 'bg-indigo-500' : pct < 60 ? 'bg-emerald-500' : pct < 85 ? 'bg-amber-500' : 'bg-red-500';

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-2 text-xs text-zinc-400">
      <div className="flex items-center justify-between gap-3">
        <span title={tokensTitle(w.tokensInWindow)}>
          {consumed ? T.windowGauge(fmtTokens(w.tokensInWindow)) : T.windowNoData}
          {pct !== null && w.estimatedCeiling && <span className="text-zinc-500"> · {T.windowCeiling(fmtCount(w.estimatedCeiling), pct)}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {w.resetsAt && <span className="text-zinc-500">{T.windowReset(fmtTime(w.resetsAt))}</span>}
          {!quota?.scheduledCut && (
            <button className="text-zinc-500 hover:text-zinc-200" onClick={onScheduleCut}>
              {T.cutSchedule}
            </button>
          )}
        </span>
      </div>
      {pct !== null && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-800">
          <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

/** Scheduled-cut status line: target time, reserve, binding state, cancel. */
function CutBanner() {
  const quota = useStore((s) => s.quota);
  const cut = quota?.scheduledCut;
  if (!cut) return null;
  const tone = cut.binding
    ? 'border-red-500/40 bg-red-500/10 text-red-200'
    : 'border-indigo-500/40 bg-indigo-500/10 text-indigo-200';
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${tone}`}>
      <span>
        {T.cutScheduled(fmtDateTime(cut.targetAt))}
        <span className="opacity-70"> · {cut.reservePct >= 100 ? T.cutReserveFull : T.cutReserveInfo(cut.reservePct)}</span>
        <span
          className={`ml-2 rounded-full border px-2 py-0.5 text-xs ${
            cut.binding ? 'border-red-400/50' : 'border-indigo-400/50'
          }`}
        >
          {cut.binding ? T.cutBindingBadge : T.cutPendingBadge}
        </span>
      </span>
      <span className="flex items-center gap-3">
        {cut.ceilingUnknown && <span className="text-xs text-amber-300">{T.cutCeilingUnknownWarn}</span>}
        <ConfirmButton
          label={T.cutCancel}
          confirmLabel={T.cutCancelConfirm}
          className="btn-ghost shrink-0"
          onConfirm={() => void api.deleteCut().catch(() => undefined)}
        />
      </span>
    </div>
  );
}

export function QuotaBanner() {
  const quota = useStore((s) => s.quota);
  const notices = useStore((s) => s.notices);
  const [showCutModal, setShowCutModal] = useState(false);
  const lastError = [...notices].reverse().find((n) => n.level === 'error');

  const limited = quota?.limitedUntil && quota.limitedUntil > Date.now();

  return (
    <div className="space-y-2">
      {quota?.globalPaused && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          <span>⏸ {T.globalPausedBanner}</span>
          <button
            className="btn-ghost shrink-0 !border-amber-500/40 !text-amber-200"
            onClick={() => void api.resumeAll().catch(() => undefined)}
          >
            {T.resumeAll}
          </button>
        </div>
      )}
      <CutBanner />
      {limited && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-200">
          <span>⏳ {T.quotaBanner(fmtTime(quota!.limitedUntil))}</span>
          <button className="btn-ghost shrink-0 !border-amber-500/40 !text-amber-200" onClick={() => void api.quotaProbe().catch(() => undefined)}>
            {T.quotaProbe}
          </button>
        </div>
      )}
      {quota?.authOk === false && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">
          🔒 {T.authBanner} {quota.authDetail && <span className="text-red-300/70">({quota.authDetail})</span>}
        </div>
      )}
      {lastError && quota?.authOk !== false && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-200">⚠️ {lastError.message}</div>
      )}
      <WindowGauge onScheduleCut={() => setShowCutModal(true)} />
      {showCutModal && <CutModal onClose={() => setShowCutModal(false)} />}
    </div>
  );
}
