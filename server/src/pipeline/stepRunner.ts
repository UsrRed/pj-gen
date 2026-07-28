import { randomUUID } from 'node:crypto';
import type { FailureKind, StepKey } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';
import type { LogEntryInput, RunResult, SessionSpec } from '../claude/types.js';
import { RESET_FALLBACK_MS } from '../claude/failure.js';
import { recordLimitHit, recordUsage } from '../core/usageTracker.js';
import { toStepRunDto } from '../db/repos/index.js';
import type { LogEntry } from '../db/repos/logs.js';

export interface ExecSession {
  id: string;
  resume: boolean;
  fork?: boolean;
  kind: 'step' | 'deploy';
}

export interface ExecOpts {
  projectId: string;
  stepKey: StepKey;
  taskKey: string | null;
  attempt: number;
  isLastAttempt: boolean;
  session: ExecSession;
  spec: Omit<SessionSpec, 'sessionId' | 'resume' | 'forkSession'>;
  /** Runs on raw success BEFORE the run row is finalized; a returned error downgrades to failure. */
  validate?: (result: RunResult) => Promise<{ ok: true } | { ok: false; kind: FailureKind; message: string }>;
  signal?: AbortSignal;
}

export interface ExecOutcome {
  runId: number;
  result: RunResult;
}

export function newSessionId(): string {
  return randomUUID();
}

/**
 * Shared claude execution path for pipeline steps and deploy turns:
 * session bookkeeping, step_run row, log batching to DB + SSE, quota notifications.
 */
export async function executeClaudeRun(deps: CoreDeps, opts: ExecOpts): Promise<ExecOutcome> {
  const { repos, bus, runner, config, sched } = deps;

  if (!opts.session.resume && !repos.sessions.byId(opts.session.id)) {
    repos.sessions.insert(opts.session.id, opts.projectId, opts.session.kind);
  }

  const run = repos.stepRuns.create(opts.projectId, opts.stepKey, opts.taskKey, opts.attempt, opts.session.id, opts.spec.model);
  bus.emit('step.started', opts.projectId, { run: toStepRunDto(run) });

  const buffer: LogEntry[] = [];
  const flush = () => {
    if (!buffer.length) return;
    const batch = buffer.splice(0, buffer.length);
    try {
      const lines = repos.logs.batchInsert(run.id, batch);
      const visible = lines.filter((l) => l.display.trim().length > 0);
      if (visible.length) bus.emit('step.log', opts.projectId, { runId: run.id, lines: visible });
    } catch {
      /* logging must never kill a run */
    }
  };
  const flushTimer = setInterval(flush, config.logFlushMs);

  const onLog = (entry: LogEntryInput) => {
    buffer.push(entry);
    if (buffer.length >= 40) flush();
  };

  const handle = runner(
    {
      ...opts.spec,
      sessionId: opts.session.id,
      resume: opts.session.resume,
      forkSession: opts.session.fork,
    },
    {
      onLog,
      onPid: (pid) => repos.stepRuns.setPid(run.id, pid),
    }
  );

  let onAbort: (() => void) | null = null;
  if (opts.signal) {
    if (opts.signal.aborted) handle.cancel('canceled');
    else {
      onAbort = () => handle.cancel('canceled');
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  let result = await handle.result;
  clearInterval(flushTimer);
  flush();
  if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);

  // `validate` is where verifyStack (install/build/test) runs: timing it separately
  // tells apart "the model is slow" from "the test suite is slow".
  let verifyMs: number | null = null;
  if (result.outcome === 'success' && opts.validate) {
    const validateStarted = Date.now();
    const v = await opts.validate(result);
    verifyMs = Date.now() - validateStarted;
    if (!v.ok) {
      result = {
        ...result,
        outcome: 'failure',
        failure: { kind: v.kind, message: v.message },
      };
    }
  }

  repos.sessions.bump(opts.session.id, result.numTurns, result.costUsd, result.usage);
  if (recordUsage(repos, opts.projectId, opts.session.kind, result)) sched.emitQuota();
  sched.poke(); // fresh tokensInWindow → re-evaluate a reserve cut promptly

  let status: 'succeeded' | 'paused_limit' | 'canceled' | 'failed' | 'failed_retryable';
  let resumeAt: number | null = null;
  if (result.outcome === 'success') {
    status = 'succeeded';
    if (repos.quota.get().limited_until) sched.notifyQuotaCleared();
  } else {
    const f = result.failure!;
    if (f.kind === 'usage_limit') {
      status = 'paused_limit';
      resumeAt = f.resetAt ?? Date.now() + RESET_FALLBACK_MS;
      recordLimitHit(repos, resumeAt);
      sched.notifyQuotaLimit(resumeAt, f.matchedPattern ?? null);
    } else if (f.kind === 'canceled') {
      status = 'canceled';
    } else {
      status = opts.isLastAttempt ? 'failed' : 'failed_retryable';
    }
  }

  const finished = repos.stepRuns.finish(run.id, {
    status,
    numTurns: result.numTurns,
    costUsd: result.costUsd,
    usage: result.usage,
    errorKind: result.failure?.kind ?? null,
    errorMessage: result.failure?.message?.slice(0, 1000) ?? null,
    resumeAt,
    durationMs: result.durationMs,
    verifyMs,
  });
  bus.emit('step.finished', opts.projectId, { run: toStepRunDto(finished) });

  // Deploy sessions are conversational: they stay active across turns so --resume keeps the context.
  const closeOnSuccess = opts.session.kind !== 'deploy';
  if ((status === 'succeeded' && closeOnSuccess) || status === 'failed') {
    repos.sessions.setStatus(opts.session.id, 'closed');
  } else if (result.failure?.kind === 'resume_lost') {
    repos.sessions.setStatus(opts.session.id, 'lost');
  }

  return { runId: run.id, result };
}
