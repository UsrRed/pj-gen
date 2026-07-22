import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { REOPENABLE_STATUSES, type MicroRequestDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useSse } from '../api/sse.js';
import { useStore } from '../store/useStore.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { QuotaBanner } from '../components/QuotaBanner.js';
import { ChatPanel } from '../components/ChatPanel.js';
import { PipelinePanel } from '../components/PipelinePanel.js';
import { ArtifactsPanel } from '../components/ArtifactsPanel.js';
import { AppPanel } from '../components/AppPanel.js';
import { DeployPanel } from '../components/DeployPanel.js';
import { STEP_LABELS, T } from '../i18n/fr.js';
import { fmtTokens, tokensTitle } from '../lib/format.js';
import { DesignFields, type DesignValue } from '../components/DesignFields.js';
import { MICRO_STATUS_STYLE } from '../components/badges.js';
import { ConfirmButton, Spinner } from '../components/ConfirmButton.js';

type Tab = 'cadrage' | 'pipeline' | 'artifacts' | 'apercu' | 'deploy';

function ImproveModal({
  onClose,
  onSubmit,
  busy,
  error,
}: {
  onClose: () => void;
  onSubmit: (request: string, design: DesignValue) => void;
  busy: boolean;
  error: string | null;
}) {
  const [request, setRequest] = useState('');
  const [design, setDesign] = useState<DesignValue>({ designUrl: '', designContent: '' });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-xl border-zinc-700 bg-zinc-900 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">🔄 {T.improveTitle}</h2>
        <p className="mt-1 text-sm text-zinc-400">{T.improveDesc}</p>
        <textarea className="input mt-3 min-h-36" placeholder={T.improvePlaceholder} value={request} onChange={(e) => setRequest(e.target.value)} autoFocus />
        <div className="mt-3">
          <DesignFields value={design} onChange={setDesign} />
        </div>
        {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            {T.cancel}
          </button>
          <button className="btn-primary" disabled={busy || !request.trim()} onClick={() => onSubmit(request.trim(), design)}>
            {busy ? T.loading : T.improveSubmit}
          </button>
        </div>
      </div>
    </div>
  );
}

function MicroPanel({ projectId, requests }: { projectId: string; requests: MicroRequestDto[] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const submit = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    void api
      .micro(projectId, text.trim())
      .then((r) => {
        if (r.status === 'needs_clarification') setFeedback(`❓ ${r.question ?? T.microUnclear}`);
        else if (r.status === 'failed') setFeedback(`⚠️ ${r.message ?? T.microFailed}`);
        else {
          setFeedback(r.status === 'appended' ? T.microAppended(r.taskKey ?? '') : T.microQueued(r.taskKey ?? ''));
          setText('');
        }
      })
      .catch((e: Error) => setFeedback(`⚠️ ${e.message}`))
      .finally(() => setBusy(false));
  };
  return (
    <div className="card space-y-3 p-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-300">⚡ {T.microTitle}</h3>
        <p className="mt-0.5 text-xs text-zinc-500">{T.microDesc}</p>
      </div>
      <div className="flex gap-2">
        <textarea
          className="input min-h-16 flex-1 resize-y"
          placeholder={T.microPlaceholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn-primary self-end whitespace-nowrap" disabled={busy || !text.trim()} onClick={submit}>
          {busy ? (
            <>
              <Spinner /> {T.loading}
            </>
          ) : (
            T.microSubmit
          )}
        </button>
      </div>
      {feedback && <div className="text-xs text-zinc-300">{feedback}</div>}
      {requests.length > 0 && (
        <div className="space-y-1.5">
          {requests.slice(0, 8).map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs">
              <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${MICRO_STATUS_STYLE[r.status]}`}>
                {T.microStatus[r.status]}
              </span>
              {r.taskKey && <span className="shrink-0 font-mono text-zinc-500">{r.taskKey}</span>}
              {r.source === 'issue' && (
                <Link to={`/projects/${projectId}/issues/${r.issueId}`} className="shrink-0 text-zinc-600 underline hover:text-indigo-300">
                  issue #{r.issueId}
                </Link>
              )}
              <span className="truncate text-zinc-400" title={r.errorMessage ?? r.request}>
                {r.request}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectPage() {
  const { id = '' } = useParams();
  const detail = useStore((s) => s.detail);
  const setDetail = useStore((s) => s.setDetail);
  const quota = useStore((s) => s.quota);
  const setQuota = useStore((s) => s.setQuota);
  const [tab, setTab] = useState<Tab | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showImprove, setShowImprove] = useState(false);
  const patchDetail = useStore((s) => s.patchDetail);
  const appRunning = useStore((s) => s.app.running);
  useSse(id);

  const refresh = useCallback(() => {
    void api
      .getProject(id)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [id, setDetail]);

  useEffect(() => {
    refresh();
    void api.quota().then(setQuota);
    return () => setDetail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Refetch the full detail when the status crosses a phase boundary (fresh tasks/runs lists).
  const status = detail?.status;
  useEffect(() => {
    if (status === 'building' || status === 'awaiting_deploy_approval' || status === 'failed') refresh();
  }, [status, refresh]);

  if (!detail || detail.id !== id) return <div className="p-10 text-center text-zinc-500">{T.loading}</div>;

  const defaultTab: Tab =
    detail.status === 'draft' || detail.status === 'spec_ready'
      ? 'cadrage'
      : ['awaiting_deploy_approval', 'deploying', 'deploy_failed', 'deployed'].includes(detail.status)
        ? 'deploy'
        : 'pipeline';
  const activeTab = tab ?? defaultTab;

  const quotaLimited = Boolean(quota?.limitedUntil && quota.limitedUntil > Date.now());
  const canValidate = detail.status === 'spec_ready';
  const lastAssistant = [...detail.messages].reverse().find((m) => m.role === 'assistant' && m.sessionKind === 'cadrage');
  const readyForSpec = lastAssistant?.structured?.ready_for_spec === true;

  const act = (name: string, fn: () => Promise<unknown>) => {
    if (busyAction) return;
    setActionError(null);
    setBusyAction(name);
    void fn()
      .catch((e) => setActionError((e as Error).message))
      .finally(() => setBusyAction(null));
  };

  const specBusy = detail.specGenerating || busyAction === 'spec';

  return (
    <div className="space-y-4">
      <QuotaBanner />

      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{detail.title}</h1>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="font-mono">{detail.slug}</span>
            <span>·</span>
            <span>
              {T.model}: {detail.model ?? 'défaut'}
            </span>
            <span>·</span>
            <span title={tokensTitle(detail.tokens)}>
              {T.tokens}: {fmtTokens(detail.tokens)}
            </span>
            {detail.currentStepKey && (
              <>
                <span>·</span>
                <span>
                  {STEP_LABELS[detail.currentStepKey]}
                  {detail.currentTaskKey ? ` ${detail.currentTaskKey}` : ''}
                </span>
              </>
            )}
            {['draft', 'spec_ready'].includes(detail.status) && (
              <>
                <span>·</span>
                <label className="flex items-center gap-1" title={T.sDesignBenchmarkHint}>
                  <span>{T.projBenchmark}:</span>
                  <select
                    className="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
                    value={detail.designBenchmark === null ? 'default' : detail.designBenchmark ? 'on' : 'off'}
                    onChange={(e) => {
                      const v = e.target.value;
                      void api.patchProject(id, { designBenchmark: v === 'default' ? null : v === 'on' }).then(setDetail);
                    }}
                  >
                    <option value="default">{T.modelDefault}</option>
                    <option value="on">{T.projBenchmarkOn}</option>
                    <option value="off">{T.projBenchmarkOff}</option>
                  </select>
                </label>
              </>
            )}
          </div>
        </div>
        <StatusBadge status={detail.status} />
        {detail.iteration > 1 && (
          <span className="rounded-full border border-violet-500/30 bg-violet-500/15 px-2.5 py-0.5 text-xs font-medium text-violet-300">
            {T.iteration(detail.iteration)}
          </span>
        )}

        <div className="ml-auto flex flex-wrap gap-2">
          {REOPENABLE_STATUSES.includes(detail.status) && (
            <button className="btn-ghost !border-violet-500/40 !text-violet-300" disabled={busyAction !== null} onClick={() => setShowImprove(true)}>
              🔄 {T.improve}
            </button>
          )}
          {canValidate && (
            <ConfirmButton
              className="btn-primary !bg-emerald-600 hover:!bg-emerald-500"
              label={`▶ ${T.validateSpec}`}
              confirmLabel="Confirmer le lancement ?"
              busyLabel="Lancement…"
              busy={busyAction === 'validate'}
              disabled={specBusy || busyAction !== null}
              onConfirm={() => act('validate', () => api.validateSpec(id))}
            />
          )}
          {(detail.status === 'building' || detail.status === 'queued') && (
            <button className="btn-ghost" disabled={busyAction !== null} onClick={() => act('pause', () => api.pause(id))}>
              ⏸ {T.pause}
            </button>
          )}
          {(detail.status === 'paused_user' || detail.status === 'interrupted') && (
            <button className="btn-primary" disabled={busyAction !== null} onClick={() => act('resume', () => api.resume(id))}>
              ▶ {T.resume}
            </button>
          )}
          {(detail.status === 'failed' || detail.status === 'deploy_failed') && (
            <button className="btn-primary" disabled={busyAction !== null} onClick={() => act('retry', () => api.retry(id))}>
              ↻ {T.retry}
            </button>
          )}
          {!['deployed', 'canceled'].includes(detail.status) && (
            <ConfirmButton
              className="btn-danger"
              label={`✕ ${T.cancel}`}
              confirmLabel="Confirmer l'annulation ?"
              busyLabel="Annulation…"
              busy={busyAction === 'cancel'}
              disabled={busyAction !== null}
              onConfirm={() => act('cancel', () => api.cancel(id))}
            />
          )}
        </div>
      </div>

      {detail.errorMessage && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">{detail.errorMessage}</div>}
      {actionError && <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">{actionError}</div>}

      {['deployed', 'awaiting_deploy_approval', 'building', 'failed'].includes(detail.status) && (
        <MicroPanel projectId={id} requests={detail.microRequests} />
      )}

      <nav className="flex gap-1 border-b border-zinc-800">
        {(['cadrage', 'pipeline', 'artifacts', 'apercu', 'deploy'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t ? 'border border-b-0 border-zinc-800 bg-zinc-900 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {T.tabs[t === 'artifacts' ? 'artifacts' : t]}
            {t === 'deploy' && detail.status === 'awaiting_deploy_approval' && <span className="ml-1.5 inline-block h-2 w-2 rounded-full bg-emerald-400" />}
            {t === 'apercu' && appRunning && <span className="ml-1.5 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />}
          </button>
        ))}
      </nav>

      {activeTab === 'cadrage' && (
        <ChatPanel
          projectId={id}
          messages={detail.messages}
          kind="cadrage"
          disabled={!['draft', 'spec_ready'].includes(detail.status) || quotaLimited}
          disabledHint={
            quotaLimited
              ? '⏳ Quota épuisé — le chat reprendra après la fenêtre de 5 h.'
              : !['draft', 'spec_ready'].includes(detail.status)
                ? 'Le cadrage est clos (SPEC validé).'
                : undefined
          }
          headerActions={
            ['draft', 'spec_ready'].includes(detail.status) ? (
              <button
                className={`btn-ghost whitespace-nowrap ${specBusy ? '!border-indigo-500/50 !text-indigo-300' : readyForSpec ? '!border-emerald-500/50 !text-emerald-300' : ''}`}
                title={specBusy ? T.specGenerating : T.specHint}
                onClick={() =>
                  act('spec', async () => {
                    await api.generateSpec(id);
                    patchDetail(id, { specGenerating: true });
                  })
                }
                disabled={specBusy || quotaLimited || detail.messages.filter((m) => m.sessionKind === 'cadrage' && m.role === 'assistant').length === 0}
              >
                {specBusy ? (
                  <>
                    <Spinner /> {T.specGenerating}
                  </>
                ) : (
                  <>📄 {T.generateSpec}</>
                )}
              </button>
            ) : undefined
          }
        />
      )}
      {activeTab === 'pipeline' && <PipelinePanel detail={detail} />}
      {activeTab === 'artifacts' && <ArtifactsPanel projectId={id} workspacePath={detail.workspacePath} />}
      {activeTab === 'apercu' && <AppPanel detail={detail} />}
      {activeTab === 'deploy' && <DeployPanel detail={detail} />}

      {showImprove && (
        <ImproveModal
          onClose={() => setShowImprove(false)}
          busy={busyAction === 'reopen'}
          error={actionError}
          onSubmit={(request, design) => {
            act('reopen', async () => {
              await api.reopen(id, request, {
                designUrl: design.designUrl.trim() || undefined,
                designContent: design.designContent.trim() || undefined,
              });
              setShowImprove(false);
              setTab('cadrage');
            });
          }}
        />
      )}
    </div>
  );
}
