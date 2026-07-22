import { Link } from 'react-router-dom';
import type { ProjectSummary } from '@pjgen/shared';
import { StatusBadge } from './StatusBadge.js';
import { STEP_LABELS, T } from '../i18n/fr.js';
import { fmtTokens, tokensTitle } from '../lib/format.js';

export function ProjectCard({ p, compact }: { p: ProjectSummary; compact?: boolean }) {
  const progress = p.tasksTotal > 0 ? Math.round((p.tasksDone / p.tasksTotal) * 100) : 0;
  return (
    <Link to={`/projects/${p.id}`} className="card block p-4 transition-colors hover:border-zinc-600">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold text-zinc-100">{p.title}</div>
          <div className="truncate text-xs text-zinc-500">{p.slug}</div>
        </div>
        <StatusBadge status={p.status} />
      </div>
      {!compact && (
        <>
          <div className="mt-3 flex items-center gap-3 text-xs text-zinc-400">
            {p.currentStepKey && (
              <span>
                {STEP_LABELS[p.currentStepKey]}
                {p.currentTaskKey ? ` · ${p.currentTaskKey}` : ''}
              </span>
            )}
            {p.queuePosition !== null && <span>{T.queuePosition(p.queuePosition)}</span>}
            <span className="ml-auto" title={tokensTitle(p.tokens)}>
              {T.tokens}: {fmtTokens(p.tokens)}
            </span>
          </div>
          {p.tasksTotal > 0 && (
            <div className="mt-2">
              <div className="flex justify-between text-[11px] text-zinc-500">
                <span>
                  {T.tasks}: {p.tasksDone}/{p.tasksTotal}
                </span>
                <span>{progress}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}
          {p.errorMessage && <div className="mt-2 truncate text-xs text-red-400">{p.errorMessage}</div>}
        </>
      )}
    </Link>
  );
}
