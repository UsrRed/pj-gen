import type { QuotaWindowDto, ScheduledCut } from '@pjgen/shared';
import type { RunResult } from '../claude/types.js';
import type { Repos } from '../db/repos/index.js';
import type { UsageKind } from '../db/repos/usage.js';

/** Subscription windows are 5 hours; the window start is derived from the stream's resetsAt. */
export const WINDOW_MS = 5 * 3600_000;

/**
 * Records a run's token consumption in usage_log and keeps quota_state's current-window
 * end fresh from the stream's rate_limit_event (emitted on every request).
 * Returns true when the window end meaningfully changed — the caller then emits quota.updated
 * (the scheduler owns the full QuotaDto: auth state lives there).
 */
export function recordUsage(repos: Repos, projectId: string, kind: UsageKind, result: RunResult): boolean {
  const u = result.usage;
  if (u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens > 0) {
    repos.usage.record(projectId, kind, u);
  }
  const info = result.rateLimitInfo;
  if (info && typeof info.resetsAt === 'number') {
    return repos.quota.setWindow(info.resetsAt * 1000, info.rateLimitType ?? null);
  }
  return false;
}

export function windowDto(repos: Repos): QuotaWindowDto {
  const q = repos.quota.get();
  const resetsAt = q.window_resets_at;
  const windowStart = resetsAt !== null ? resetsAt - WINDOW_MS : Date.now() - WINDOW_MS;
  return {
    resetsAt,
    windowType: q.window_type,
    tokensInWindow: repos.usage.tokensSince(windowStart),
    estimatedCeiling: repos.quota.estimatedCeiling(),
  };
}

export interface CutEval {
  binding: boolean;
  /** reservePct < 100 but estimatedCeiling is null — enforced as a full cut. */
  ceilingUnknown: boolean;
  /** now >= targetAt: the cut is spent and should be auto-cleared. */
  expired: boolean;
  /** Earliest ms the verdict can flip (timer target); null while binding. */
  nextCheckAt: number | null;
}

/**
 * Decides whether a scheduled cut must block builds right now.
 * A request at t joins the open window (ends at windowResetsAt) or opens one ending t+5h;
 * tokens fully replenish at reset. The cut binds when the projected window end would
 * overlap targetAt — and, for reserve cuts, once consumption eats into the reserve.
 */
export function evaluateCut(
  cut: ScheduledCut,
  windowResetsAt: number | null,
  tokensInWindow: number,
  estimatedCeiling: number | null,
  now = Date.now()
): CutEval {
  if (now >= cut.targetAt) return { binding: false, ceilingUnknown: false, expired: true, nextCheckAt: null };

  const windowOpen = windowResetsAt !== null && windowResetsAt > now;
  const projectedEnd = windowOpen ? windowResetsAt : now + WINDOW_MS;
  const timeBinding = projectedEnd > cut.targetAt;
  const ceilingUnknown = cut.reservePct < 100 && estimatedCeiling === null;

  let binding: boolean;
  if (cut.reservePct >= 100 || ceilingUnknown) {
    binding = timeBinding;
  } else {
    binding = timeBinding && tokensInWindow >= (1 - cut.reservePct / 100) * estimatedCeiling!;
  }

  let nextCheckAt: number | null = null;
  if (binding) {
    nextCheckAt = null;
  } else if (!timeBinding) {
    nextCheckAt =
      windowOpen && windowResetsAt <= cut.targetAt
        ? Math.max(windowResetsAt, cut.targetAt - WINDOW_MS)
        : cut.targetAt - WINDOW_MS;
  } else {
    // Time-binding but the reserve isn't consumed yet: consumption re-evals come via poke/tick,
    // the timer only guarantees expiry cleanup.
    nextCheckAt = cut.targetAt;
  }
  return { binding, ceilingUnknown, expired: false, nextCheckAt };
}

/** Tokens consumed in the window that just hit the limit — recorded for ceiling estimation. */
export function recordLimitHit(repos: Repos, resetAtMs: number): void {
  const tokens = repos.usage.tokensSince(resetAtMs - WINDOW_MS).total;
  if (tokens > 0) repos.quota.recordLimitHit(tokens);
}
