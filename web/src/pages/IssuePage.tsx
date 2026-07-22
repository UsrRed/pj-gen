import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { StepRunDto } from '@pjgen/shared';
import { api } from '../api/client.js';
import { useSse } from '../api/sse.js';
import { useStore } from '../store/useStore.js';
import { LogViewer } from '../components/LogViewer.js';
import { RunMeta } from '../components/PipelinePanel.js';
import { DECISION_STYLE, MICRO_STATUS_STYLE } from '../components/badges.js';
import { STEP_LABELS, T } from '../i18n/fr.js';
import { fmtDuration } from '../lib/format.js';

const RUN_STYLE: Record<string, { icon: string; cls: string }> = {
  running: { icon: '●', cls: 'text-indigo-300 border-indigo-500/40' },
  succeeded: { icon: '✓', cls: 'text-emerald-400 border-emerald-500/30' },
  failed: { icon: '✗', cls: 'text-red-400 border-red-500/40' },
  failed_retryable: { icon: '✗', cls: 'text-red-400 border-red-500/40' },
  paused_limit: { icon: '⏸', cls: 'text-amber-300 border-amber-500/40' },
};
const RUN_STYLE_DEFAULT = { icon: '○', cls: 'text-zinc-600 border-zinc-800' };

export function IssuePage() {
  const { id = '', issueId = '' } = useParams();
  const detail = useStore((s) => s.detail);
  const setDetail = useStore((s) => s.setDetail);
  const setIssues = useStore((s) => s.setIssues);
  const issue = useStore((s) => s.issues[Number(issueId)]);
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  useSse(id);

  useEffect(() => {
    setLoading(true);
    void Promise.all([
      api.getProject(id).then(setDetail).catch(() => setDetail(null)),
      api.issues(id).then((r) => setIssues(r.issues)).catch(() => undefined),
    ]).finally(() => setLoading(false));
    return () => setDetail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading && (!detail || detail.id !== id)) return <div className="p-10 text-center text-zinc-500">{T.loading}</div>;
  if (!detail || detail.id !== id || !issue || issue.projectId !== id) {
    return (
      <div className="space-y-4 p-10 text-center text-zinc-500">
        <p>{T.issueNotFound}</p>
        <Link to={detail ? `/projects/${detail.id}` : '/github'} className="btn-ghost text-xs">
          ← {detail ? detail.title : T.github}
        </Link>
      </div>
    );
  }

  const micro = detail.microRequests
    .filter((r) => r.issueId === issue.id)
    .reduce<(typeof detail.microRequests)[number] | undefined>((acc, r) => (acc && acc.id > r.id ? acc : r), undefined);
  const task = micro?.taskKey ? detail.tasks.find((t) => t.taskKey === micro.taskKey) : undefined;

  // Micro pipeline = implement_task (carries taskKey) then final_verify (no taskKey): pick up the
  // verify runs started after the task's first run so the whole fix cycle is visible.
  const taskRuns = micro?.taskKey ? detail.stepRuns.filter((r) => r.taskKey === micro.taskKey) : [];
  const firstStart = taskRuns.reduce<number | null>((min, r) => (r.startedAt !== null && (min === null || r.startedAt < min) ? r.startedAt : min), null);
  // Bounded by the next task's start so verify runs of later fix cycles don't leak into this issue.
  const nextTaskStart =
    firstStart === null
      ? null
      : detail.stepRuns
          .filter((r) => r.stepKey === 'implement_task' && r.taskKey !== micro?.taskKey && r.startedAt !== null && r.startedAt > firstStart)
          .reduce<number | null>((min, r) => (min === null || r.startedAt! < min ? r.startedAt : min), null);
  const verifyRuns =
    firstStart === null
      ? []
      : detail.stepRuns.filter(
          (r) =>
            r.stepKey === 'final_verify' &&
            r.startedAt !== null &&
            r.startedAt >= firstStart &&
            (nextTaskStart === null || r.startedAt < nextTaskStart),
        );
  const runs: StepRunDto[] = [...taskRuns, ...verifyRuns].sort((a, b) => a.id - b.id);

  const liveRun = runs.find((r) => r.status === 'running');
  const shownRun = selectedRun ?? liveRun?.id ?? runs[runs.length - 1]?.id ?? null;
  const ghUrl = detail.github ? `https://github.com/${detail.github.repo}/issues/${issue.number}` : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
        <Link to={`/projects/${id}`} className="hover:text-indigo-300">
          {detail.title}
        </Link>
        <span>/</span>
        <span className="text-zinc-300">{T.issuePageTitle(issue.number)}</span>
        <Link to="/github" className="ml-auto btn-ghost text-xs">
          🐙 {T.github}
        </Link>
      </div>

      <div className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-zinc-500">#{issue.number}</span>
          <h1 className="text-lg font-semibold text-zinc-100">{issue.title}</h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${DECISION_STYLE[issue.decision]}`}>
            {T.ghIssueDecision[issue.decision]}
          </span>
          {issue.ghState === 'closed' && <span className="text-xs text-zinc-600">(fermée)</span>}
          <span className="text-xs text-zinc-600">@{issue.author}</span>
          {ghUrl && (
            <a href={ghUrl} target="_blank" rel="noreferrer" className="btn-ghost ml-auto text-xs">
              {T.issueOpenGh}
            </a>
          )}
        </div>
        {issue.body && <p className="whitespace-pre-wrap text-sm text-zinc-400">{issue.body}</p>}
      </div>

      <div className="card space-y-2 p-4">
        <h2 className="text-sm font-semibold text-zinc-300">⚡ {T.issueMicroSection}</h2>
        {micro ? (
          <div className="space-y-1.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`shrink-0 rounded-full px-2 py-0.5 font-medium ${MICRO_STATUS_STYLE[micro.status]}`}>
                {T.microStatus[micro.status]}
              </span>
              {micro.taskKey && <span className="font-mono text-zinc-500">{micro.taskKey}</span>}
            </div>
            <p className="whitespace-pre-wrap text-zinc-400">{micro.request}</p>
            {micro.errorMessage && <p className="text-red-400">{micro.errorMessage}</p>}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">{T.issueNoMicro}</p>
        )}
      </div>

      {task && (
        <div className="card space-y-1.5 p-4">
          <h2 className="text-sm font-semibold text-zinc-300">{T.issueTaskSection}</h2>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs text-zinc-500">{task.taskKey}</span>
            <span className="text-zinc-200">{task.title}</span>
            {task.commitSha && <span className="ml-auto font-mono text-[10px] text-zinc-600">{task.commitSha.slice(0, 8)}</span>}
          </div>
          {task.description && <p className="whitespace-pre-wrap text-xs text-zinc-400">{task.description}</p>}
        </div>
      )}

      {runs.length > 0 && (
        <div className="card p-4">
          <h2 className="mb-2 text-sm font-semibold text-zinc-300">{T.issueRunsSection}</h2>
          <ol className="flex flex-wrap gap-2">
            {runs.map((r) => {
              const style = RUN_STYLE[r.status] ?? RUN_STYLE_DEFAULT;
              return (
                <li key={r.id}>
                  <button
                    onClick={() => setSelectedRun(r.id)}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${style.cls} ${shownRun === r.id ? 'bg-zinc-800/60' : 'hover:bg-zinc-800/60'}`}
                    title={`${T.attempt} ${r.attempt} — ${r.status}`}
                  >
                    <span>{style.icon}</span>
                    <span>{STEP_LABELS[r.stepKey]}</span>
                    <span className="text-zinc-600">{fmtDuration(r.startedAt, r.endedAt)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between text-sm text-zinc-400">
          <h2 className="font-semibold text-zinc-300">{T.logs}</h2>
          {shownRun !== null && <RunMeta run={runs.find((r) => r.id === shownRun)} live={liveRun?.id === shownRun} />}
        </div>
        <LogViewer runId={shownRun} />
      </div>
    </div>
  );
}
