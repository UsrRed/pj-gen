import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import type { SessionSpec } from '../src/claude/types.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

function isToolStep(spec: SessionSpec): boolean {
  // plain tool steps only — the feature_check audit uses tools + jsonSchema and needs structured output
  return spec.tools === 'default' && !spec.jsonSchema;
}

describe('Scheduler', () => {
  it('runs max 2 builds concurrently, FIFO for the rest', async () => {
    const { c } = await testContainer({
      script: fastScript((spec) => (isToolStep(spec) ? { delayMs: 400, result: { outcome: 'success', resultText: 'ok' } } : undefined)),
    });
    cRef = c;
    const a = await seedQueuedProject(c, 'Alpha');
    const b = await seedQueuedProject(c, 'Beta');
    const d = await seedQueuedProject(c, 'Gamma');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byStatus(['building']).length === 2, 5_000, '2 builds actifs');
    expect(c.repos.projects.byId(d)!.status).toBe('queued');
    expect(c.scheduler.activeBuilds).toBe(2);

    await waitFor(
      () => ['awaiting_deploy_approval'].includes(c.repos.projects.byId(a)!.status) &&
        ['awaiting_deploy_approval'].includes(c.repos.projects.byId(b)!.status) &&
        ['awaiting_deploy_approval'].includes(c.repos.projects.byId(d)!.status),
      30_000,
      'tous terminés'
    );
  });

  it('parks on usage limit and auto-resumes the same session after the reset', async () => {
    let scaffoldCalls = 0;
    let resumedSession: string | null = null;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        // the scaffold attempt is the first tool step; its resume arrives with resume=true
        if (isToolStep(spec) && (spec.prompt.includes('squelette') || spec.resume)) {
          scaffoldCalls += 1;
          if (scaffoldCalls === 1) {
            return {
              delayMs: 10,
              result: {
                outcome: 'failure',
                failure: { kind: 'usage_limit', message: 'usage limit reached', resetAt: Date.now() + 400, matchedPattern: 'usage limit' },
              },
            };
          }
          if (spec.resume) resumedSession = spec.sessionId;
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Limited');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'paused_limit', 5_000, 'park quota');
    expect(c.repos.quota.get().limited_until).toBeGreaterThan(Date.now() - 1000);
    const paused = c.repos.stepRuns.latestPaused(id, 'scaffold', null);
    expect(paused).toBeDefined();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'reprise et fin');
    expect(scaffoldCalls).toBeGreaterThanOrEqual(2);
    expect(resumedSession).toBe(paused!.session_id);
    expect(c.repos.quota.get().limited_until).toBeNull();
  });

  it('does not start anything while the quota is limited', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Waiting');
    c.repos.quota.setLimited(Date.now() + 60_000, 'test');
    c.scheduler.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(c.repos.projects.byId(id)!.status).toBe('queued');
    expect(c.scheduler.activeBuilds).toBe(0);
  });

  it('pause/cancel interrupt a running build', async () => {
    const { c } = await testContainer({
      script: fastScript((spec) => (isToolStep(spec) ? { delayMs: 5_000, result: { outcome: 'success', resultText: 'ok' } } : undefined)),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Pausable');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'building', 5_000, 'build démarré');
    // Wait until the slow tool step (scaffold) is actually running.
    await waitFor(() => c.repos.stepRuns.listForProject(id).some((r) => r.step_key === 'scaffold' && r.status === 'running'), 5_000, 'scaffold en cours');
    expect(c.scheduler.abortProject(id, 'pause')).toBe(true);
    await waitFor(() => c.repos.projects.byId(id)!.status === 'paused_user', 5_000, 'pause effective');
    const canceledRun = c.repos.stepRuns.listForProject(id).find((r) => r.step_key === 'scaffold');
    expect(canceledRun!.status).toBe('canceled');
  });
});
