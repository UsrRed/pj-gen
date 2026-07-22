import { useMemo, useState } from 'react';
import { PIPELINE_ORDER, type ProjectDetail, type StepKey, type StepRunDto } from '@pjgen/shared';
import { STEP_LABELS, T } from '../i18n/fr.js';
import { fmtDuration, fmtTokens, tokensTitle } from '../lib/format.js';
import { LogViewer } from './LogViewer.js';

function stepIcon(state: 'done' | 'active' | 'pending' | 'failed' | 'paused'): string {
  switch (state) {
    case 'done':
      return '✓';
    case 'active':
      return '●';
    case 'failed':
      return '✗';
    case 'paused':
      return '⏸';
    default:
      return '○';
  }
}

const STATE_COLORS = {
  done: 'text-emerald-400 border-emerald-500/30',
  active: 'text-indigo-300 border-indigo-500/40',
  failed: 'text-red-400 border-red-500/40',
  paused: 'text-amber-300 border-amber-500/40',
  pending: 'text-zinc-600 border-zinc-800',
};

export function PipelinePanel({ detail }: { detail: ProjectDetail }) {
  const [selectedRun, setSelectedRun] = useState<number | null>(null);

  const runsByStep = useMemo(() => {
    const m = new Map<StepKey, StepRunDto[]>();
    for (const r of detail.stepRuns) {
      const arr = m.get(r.stepKey) ?? [];
      arr.push(r);
      m.set(r.stepKey, arr);
    }
    return m;
  }, [detail.stepRuns]);

  const liveRun = detail.stepRuns.find((r) => r.status === 'running');
  const shownRun = selectedRun ?? liveRun?.id ?? detail.stepRuns[detail.stepRuns.length - 1]?.id ?? null;

  const stepState = (key: StepKey): keyof typeof STATE_COLORS => {
    const runs = runsByStep.get(key) ?? [];
    const idx = PIPELINE_ORDER.indexOf(key);
    const curIdx = detail.currentStepKey ? PIPELINE_ORDER.indexOf(detail.currentStepKey) : -1;
    if (runs.some((r) => r.status === 'running')) return 'active';
    if (runs.some((r) => r.status === 'paused_limit') && detail.status === 'paused_limit') return 'paused';
    if (detail.status === 'failed' && detail.currentStepKey === key) return 'failed';
    if (curIdx >= 0 && idx < curIdx) return 'done';
    if (curIdx === idx && (detail.status === 'building' || detail.status === 'paused_limit')) return 'active';
    const doneStatuses = ['awaiting_deploy_approval', 'deploying', 'deploy_failed', 'deployed'];
    if (doneStatuses.includes(detail.status)) return 'done';
    if (runs.length > 0 && runs[runs.length - 1].status === 'succeeded') {
      if (key !== 'implement_task') return 'done';
      if (detail.tasksTotal > 0 && detail.tasksDone === detail.tasksTotal) return 'done';
    }
    return 'pending';
  };

  return (
    <div className="space-y-4">
      <div className="card p-4">
        <ol className="flex flex-wrap gap-2">
          {PIPELINE_ORDER.map((key) => {
            const state = stepState(key);
            const runs = runsByStep.get(key) ?? [];
            const last = runs[runs.length - 1];
            return (
              <li key={key}>
                <button
                  onClick={() => last && setSelectedRun(last.id)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${STATE_COLORS[state]} ${last ? 'hover:bg-zinc-800/60' : 'cursor-default'}`}
                  title={last ? `${runs.length} run(s) — dernier: ${last.status}` : 'pas encore exécuté'}
                >
                  <span>{stepIcon(state)}</span>
                  <span>{STEP_LABELS[key]}</span>
                  {key === 'implement_task' && detail.tasksTotal > 0 && (
                    <span className="text-zinc-500">
                      {detail.tasksDone}/{detail.tasksTotal}
                    </span>
                  )}
                  {last && state !== 'pending' && <span className="text-zinc-600">{fmtDuration(last.startedAt, last.endedAt)}</span>}
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {detail.tasks.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-zinc-300">{T.tasks}</h3>
          <ul className="space-y-1">
            {detail.tasks.map((t) => {
              const taskRuns = detail.stepRuns.filter((r) => r.taskKey === t.taskKey);
              const last = taskRuns[taskRuns.length - 1];
              const icon = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : t.status === 'failed' ? '✗' : '○';
              const color =
                t.status === 'done' ? 'text-emerald-400' : t.status === 'in_progress' ? 'text-indigo-300' : t.status === 'failed' ? 'text-red-400' : 'text-zinc-600';
              return (
                <li key={t.taskKey} className="flex items-center gap-2 text-sm">
                  <span className={`w-4 ${color}`}>{icon}</span>
                  <span className="font-mono text-xs text-zinc-500">{t.taskKey}</span>
                  <button
                    className={`truncate text-left ${last ? 'hover:underline' : ''} ${t.status === 'in_progress' ? 'text-zinc-100' : 'text-zinc-400'}`}
                    onClick={() => last && setSelectedRun(last.id)}
                    disabled={!last}
                  >
                    {t.title}
                  </button>
                  {t.commitSha && <span className="ml-auto font-mono text-[10px] text-zinc-600">{t.commitSha.slice(0, 8)}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm text-zinc-400">
          <h3 className="font-semibold text-zinc-300">{T.logs}</h3>
          {shownRun !== null && (
            <RunMeta run={detail.stepRuns.find((r) => r.id === shownRun)} live={liveRun?.id === shownRun} />
          )}
        </div>
        <LogViewer runId={shownRun} />
      </div>
    </div>
  );
}

export function RunMeta({ run, live }: { run?: StepRunDto; live: boolean }) {
  if (!run) return null;
  return (
    <span className="flex items-center gap-2 text-xs text-zinc-500">
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />}
      run #{run.id} · {STEP_LABELS[run.stepKey]}
      {run.taskKey ? ` ${run.taskKey}` : ''} · {T.attempt} {run.attempt} · {run.numTurns} {T.turns} ·{' '}
      <span title={tokensTitle(run.tokens)}>{fmtTokens(run.tokens)} tok</span>
      {run.errorKind ? ` · ${run.errorKind}` : ''}
    </span>
  );
}
