import { useState } from 'react';
import type { ProjectDetail } from '@pjgen/shared';
import { api } from '../api/client.js';
import { T } from '../i18n/fr.js';
import { ChatPanel } from './ChatPanel.js';
import { LogViewer } from './LogViewer.js';
import { useStore } from '../store/useStore.js';

export function DeployPanel({ detail }: { detail: ProjectDetail }) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quota = useStore((s) => s.quota);
  const quotaLimited = Boolean(quota?.limitedUntil && quota.limitedUntil > Date.now());

  const deployRuns = detail.stepRuns.filter((r) => r.stepKey === 'deploy');
  const liveDeploy = deployRuns.find((r) => r.status === 'running');
  const lastDeployRun = liveDeploy ?? deployRuns[deployRuns.length - 1];

  if (detail.status === 'awaiting_deploy_approval') {
    return (
      <div className="card mx-auto max-w-2xl p-6">
        <h3 className="text-lg font-semibold text-emerald-300">{T.deployGateTitle}</h3>
        <p className="mt-1 text-sm text-zinc-400">{T.deployGateDesc}</p>
        <textarea className="input mt-4 min-h-32" placeholder={T.deployNotes} value={notes} onChange={(e) => setNotes(e.target.value)} />
        <p className="mt-2 text-xs text-amber-300/80">{T.deployNotesWarning}</p>
        {error && <div className="mt-2 text-sm text-red-400">{error}</div>}
        <div className="mt-4 flex justify-end">
          <button
            className="btn-primary !bg-emerald-600 hover:!bg-emerald-500"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              api
                .approveDeploy(detail.id, notes)
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? T.loading : T.approveDeploy}
          </button>
        </div>
      </div>
    );
  }

  if (detail.status === 'deploying' || detail.status === 'deploy_failed' || detail.status === 'deployed') {
    return (
      <div className="space-y-4">
        {detail.status !== 'deployed' && (
          <div className="flex justify-end">
            <button
              className="btn-primary !bg-emerald-600 hover:!bg-emerald-500"
              onClick={() => void api.markDeployed(detail.id).catch(() => undefined)}
            >
              {T.markDeployed}
            </button>
          </div>
        )}
        <ChatPanel
          projectId={detail.id}
          messages={detail.messages}
          kind="deploy"
          disabled={detail.status === 'deployed' || quotaLimited}
          disabledHint={quotaLimited ? '⏳ Quota épuisé — le chat reprendra après la fenêtre de 5 h.' : undefined}
          emptyHint="La session de déploiement démarre…"
        />
        {lastDeployRun && (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold text-zinc-300">{T.logs} (déploiement)</h3>
            <LogViewer runId={lastDeployRun.id} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card p-8 text-center text-sm text-zinc-500">
      Le déploiement sera disponible quand la construction sera terminée et vérifiée.
    </div>
  );
}
