import fs from 'node:fs';
import type { CoreDeps } from '../core/deps.js';
import { ProjectStateMachine } from '../core/stateMachine.js';

/** True when the pid is alive AND its cmdline still references the given claude session. */
export function isPidOurClaudeSession(pid: number, sessionId: string | null): boolean {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    if (!/claude/i.test(cmdline)) return false;
    return sessionId ? cmdline.includes(sessionId) : true;
  } catch {
    return false;
  }
}

const MAX_AUTO_RESUMES = 3;

/**
 * Boot recovery: kill/flag runs left 'running' by a previous process, then either
 * auto-requeue interrupted builds (crash-loop guarded) or park them as 'interrupted'.
 */
export function recoverOnBoot(deps: Omit<CoreDeps, 'sched'>): { orphanedRuns: number; requeued: number; parked: number } {
  const { repos, bus } = deps;
  const sm = new ProjectStateMachine(repos.projects);
  const settings = repos.settings.getAll();

  let orphanedRuns = 0;
  for (const run of repos.stepRuns.running()) {
    if (run.pid && isPidOurClaudeSession(run.pid, run.session_id)) {
      try {
        process.kill(-run.pid, 'SIGTERM');
      } catch {
        try {
          process.kill(run.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
    repos.stepRuns.finish(run.id, {
      status: 'orphaned',
      numTurns: run.num_turns,
      costUsd: run.cost_usd,
      usage: {
        inputTokens: run.input_tokens,
        outputTokens: run.output_tokens,
        cacheCreationTokens: run.cache_creation_tokens,
        cacheReadTokens: run.cache_read_tokens,
      },
      errorKind: 'crash',
      errorMessage: 'run interrompu par un arrêt de pj-gen',
    });
    orphanedRuns += 1;
  }

  let requeued = 0;
  let parked = 0;
  for (const project of repos.projects.byStatus(['building'])) {
    // Worktrees of tasks that already landed are dead weight after a crash; the ones
    // belonging to unfinished tasks are kept so their sessions can be resumed in place.
    const keep = repos.tasks
      .list(project.id)
      .filter((t) => t.status !== 'done' && t.worktree_dir)
      .map((t) => t.task_key);
    void deps.wt.sweep(project.workspace_path, project.slug, keep).catch(() => undefined);

    const orphans = repos.stepRuns.orphanCount(project.id);
    if (settings.autoResumeOnBoot && orphans <= MAX_AUTO_RESUMES && !repos.settings.getGlobalPaused()) {
      if (sm.tryTransition(project.id, ['building'], 'queued')) requeued += 1;
    } else if (sm.tryTransition(project.id, ['building'], 'interrupted')) {
      parked += 1;
    }
    const row = repos.projects.byId(project.id);
    if (row) bus.emit('project.updated', project.id, { project: repos.projects.summary(row) });
  }

  if (orphanedRuns || requeued || parked) {
    bus.emit('boot.notice', null, {
      level: 'info',
      message: `Reprise au démarrage: ${orphanedRuns} session(s) orpheline(s), ${requeued} projet(s) re-mis en file, ${parked} projet(s) en attente manuelle.`,
    });
    bus.emit('queue.updated', null, repos.projects.queueSnapshot());
  }
  return { orphanedRuns, requeued, parked };
}
