import type { MicroRequestDto } from '@pjgen/shared';

/** Pill styles for GitHub issue decisions (GithubPage, IssuePage). */
export const DECISION_STYLE: Record<string, string> = {
  pending: 'bg-zinc-500/15 text-zinc-300',
  skipped: 'bg-zinc-600/15 text-zinc-500',
  queued: 'bg-sky-500/15 text-sky-300',
  fixing: 'bg-indigo-500/15 text-indigo-300',
  ci_running: 'bg-cyan-500/15 text-cyan-300',
  fixed: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  needs_clarification: 'bg-amber-500/15 text-amber-300',
  escalated: 'bg-violet-500/15 text-violet-300',
  blocked_security: 'bg-red-700/20 text-red-400',
};

/** Pill styles for micro-request statuses (ProjectPage, IssuePage). */
export const MICRO_STATUS_STYLE: Record<MicroRequestDto['status'], string> = {
  pending: 'bg-zinc-500/15 text-zinc-300',
  task_created: 'bg-indigo-500/15 text-indigo-300',
  done: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
  needs_clarification: 'bg-amber-500/15 text-amber-300',
  escalated: 'bg-violet-500/15 text-violet-300',
};
