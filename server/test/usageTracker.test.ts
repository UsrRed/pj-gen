import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { WINDOW_MS, evaluateCut, recordLimitHit, recordUsage, windowDto } from '../src/core/usageTracker.js';
import type { RunResult } from '../src/claude/types.js';
import { seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

function fakeResult(tokens: number, resetsAtSec?: number): RunResult {
  return {
    outcome: 'success',
    sessionId: 's',
    resultText: 'ok',
    numTurns: 1,
    costUsd: 0,
    usage: { inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    rateLimitInfo: resetsAtSec ? { status: 'allowed', resetsAt: resetsAtSec, rateLimitType: 'five_hour' } : undefined,
    durationMs: 10,
  };
}

describe('usageTracker', () => {
  it('records usage_log rows and tracks the window end from rate_limit_event', async () => {
    const { c } = await testContainer();
    cRef = c;
    const resetsAtSec = Math.floor(Date.now() / 1000) + 3600;

    // First observation sets the window and reports a meaningful change.
    expect(recordUsage(c.repos, 'p1', 'step', fakeResult(1000, resetsAtSec))).toBe(true);
    // Same window (< 60s drift) → no re-broadcast.
    expect(recordUsage(c.repos, 'p1', 'cadrage', fakeResult(500, resetsAtSec + 10))).toBe(false);
    // Window rolled over → change again.
    expect(recordUsage(c.repos, 'p1', 'step', fakeResult(200, resetsAtSec + 7200))).toBe(true);

    const w = windowDto(c.repos);
    expect(w.resetsAt).toBe((resetsAtSec + 7200) * 1000);
    expect(w.windowType).toBe('five_hour');
    expect(w.tokensInWindow.total).toBe(1700);
    expect(w.estimatedCeiling).toBeNull();
  });

  it('zero-usage results (failures before any turn) do not pollute usage_log', async () => {
    const { c } = await testContainer();
    cRef = c;
    recordUsage(c.repos, 'p1', 'step', fakeResult(0));
    expect(windowDto(c.repos).tokensInWindow.total).toBe(0);
  });

  it('limit hits record the window consumption; ceiling = median of the last hits', async () => {
    const { c } = await testContainer();
    cRef = c;
    for (const tokens of [8000, 10_000, 9000]) {
      c.repos.usage.record('p1', 'step', { inputTokens: tokens, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
      recordLimitHit(c.repos, Date.now() + 1000);
      // isolate each "window" by aging the previous rows out of it
      c.db.prepare('UPDATE usage_log SET at = at - ?').run(WINDOW_MS + 60_000);
    }
    // Hits accumulate: 8000, then 8000+10000=18000... — assert the ceiling is the median of recorded hits.
    const hits = c.db.prepare('SELECT tokens_in_window AS t FROM limit_hits ORDER BY id').all() as { t: number }[];
    expect(hits).toHaveLength(3);
    const sorted = hits.map((h) => h.t).sort((a, b) => a - b);
    expect(c.repos.quota.estimatedCeiling()).toBe(sorted[1]);
  });

  describe('evaluateCut', () => {
    const now = 1_800_000_000_000; // fixed clock

    it('no open window, target beyond now+5h → not binding, flip at target-5h', () => {
      const target = now + WINDOW_MS + 3_600_000;
      const ev = evaluateCut({ targetAt: target, reservePct: 100 }, null, 0, null, now);
      expect(ev).toEqual({ binding: false, ceilingUnknown: false, expired: false, nextCheckAt: target - WINDOW_MS });
    });

    it('no open window, target within now+5h → binding (a new window would overlap it)', () => {
      const ev = evaluateCut({ targetAt: now + 3_600_000, reservePct: 100 }, null, 0, null, now);
      expect(ev.binding).toBe(true);
      expect(ev.nextCheckAt).toBeNull();
    });

    it('open window ending before target → not binding, flip at max(reset, target-5h)', () => {
      const resetsAt = now + 1_800_000;
      const target = now + 3_600_000; // target-5h is in the past → flip at window reset
      const ev = evaluateCut({ targetAt: target, reservePct: 100 }, resetsAt, 5000, null, now);
      expect(ev.binding).toBe(false);
      expect(ev.nextCheckAt).toBe(resetsAt);

      const farTarget = now + WINDOW_MS + 7_200_000; // target-5h after the reset → flip there
      const ev2 = evaluateCut({ targetAt: farTarget, reservePct: 100 }, resetsAt, 5000, null, now);
      expect(ev2.nextCheckAt).toBe(farTarget - WINDOW_MS);
    });

    it('open window ending after target → binding for a full cut', () => {
      const ev = evaluateCut({ targetAt: now + 1_000_000, reservePct: 100 }, now + 2_000_000, 0, null, now);
      expect(ev.binding).toBe(true);
    });

    it('reserve cut binds only once consumption eats into the reserve', () => {
      const cut = { targetAt: now + 1_000_000, reservePct: 60 }; // time-binding window below
      const resetsAt = now + 2_000_000;
      expect(evaluateCut(cut, resetsAt, 39_999, 100_000, now).binding).toBe(false);
      expect(evaluateCut(cut, resetsAt, 39_999, 100_000, now).nextCheckAt).toBe(cut.targetAt);
      expect(evaluateCut(cut, resetsAt, 40_000, 100_000, now).binding).toBe(true);
      // Not time-binding → consumption is irrelevant.
      expect(evaluateCut(cut, now + 500_000, 99_999, 100_000, now).binding).toBe(false);
    });

    it('reserve cut without a known ceiling degrades to a full cut with a warning flag', () => {
      const ev = evaluateCut({ targetAt: now + 1_000_000, reservePct: 60 }, now + 2_000_000, 0, null, now);
      expect(ev.binding).toBe(true);
      expect(ev.ceilingUnknown).toBe(true);
      const evSafe = evaluateCut({ targetAt: now + 1_000_000, reservePct: 60 }, now + 500_000, 0, null, now);
      expect(evSafe.binding).toBe(false);
      expect(evSafe.ceilingUnknown).toBe(true);
    });

    it('past target → expired', () => {
      const ev = evaluateCut({ targetAt: now - 1, reservePct: 100 }, null, 0, null, now);
      expect(ev.expired).toBe(true);
      expect(ev.binding).toBe(false);
    });
  });

  it('a fake pipeline populates usage_log and the /quota window end-to-end', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Usage E2E');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const w = c.scheduler.getQuotaDto().window;
    expect(w.resetsAt).not.toBeNull();
    expect(w.windowType).toBe('five_hour');
    expect(w.tokensInWindow.total).toBeGreaterThan(0);
    const logged = c.db.prepare('SELECT COUNT(*) AS n FROM usage_log WHERE project_id = ?').get(id) as { n: number };
    expect(logged.n).toBeGreaterThan(5);
  });
});
