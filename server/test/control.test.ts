import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { WINDOW_MS } from '../src/core/usageTracker.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';
import type { SessionSpec } from '../src/claude/types.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

function isToolStep(spec: SessionSpec): boolean {
  return spec.tools === 'default' && !spec.jsonSchema;
}

const slowScript = () =>
  fastScript((spec) => (isToolStep(spec) ? { delayMs: 5_000, result: { outcome: 'success', resultText: 'ok' } } : undefined));

describe('pause-all / resume-all', () => {
  it('pauseAll halts in-flight builds, keeps the queue parked; resume-all requeues everything', async () => {
    const { c } = await testContainer({ script: slowScript() });
    cRef = c;
    const a = await seedQueuedProject(c, 'Actif A');
    const b = await seedQueuedProject(c, 'Actif B');
    const d = await seedQueuedProject(c, 'En file');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byStatus(['building']).length === 2, 5_000, '2 builds actifs');

    c.scheduler.pauseAll();
    await waitFor(() => c.scheduler.activeBuilds === 0, 5_000, 'moteurs arrêtés');
    await waitFor(
      () => c.repos.projects.byId(a)!.status === 'paused_user' && c.repos.projects.byId(b)!.status === 'paused_user',
      5_000,
      'projets en paused_user'
    );
    expect(c.repos.projects.byId(d)!.status).toBe('queued');
    expect(c.scheduler.getQuotaDto().globalPaused).toBe(true);

    // Nothing restarts while paused (beyond a few ticks at 60ms).
    await new Promise((r) => setTimeout(r, 300));
    expect(c.scheduler.activeBuilds).toBe(0);

    // Resume-all via the HTTP route: flag cleared, paused_user + interrupted → queued.
    c.repos.projects.casStatus(a, ['paused_user'], 'interrupted');
    appRef = await createApp(c);
    const res = await appRef.inject({ method: 'POST', url: '/api/control/resume-all' });
    expect(res.statusCode).toBe(200);
    expect(res.json().resumed).toBe(2); // a (interrupted) + b (paused_user)
    expect(c.scheduler.getQuotaDto().globalPaused).toBe(false);
    await waitFor(() => c.repos.projects.byStatus(['building']).length > 0, 5_000, 'reprise des builds');
  });

  it('globalPaused set before start() gates the scheduler entirely', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Bloque');
    c.repos.settings.setGlobalPaused(true);
    c.scheduler.start();
    await new Promise((r) => setTimeout(r, 400));
    expect(c.repos.projects.byId(id)!.status).toBe('queued');
    expect(c.scheduler.activeBuilds).toBe(0);
  });
});

describe('scheduled cut', () => {
  it('an immediately-binding cut pauses everything synchronously via the route', async () => {
    const { c } = await testContainer({ script: slowScript() });
    cRef = c;
    const id = await seedQueuedProject(c, 'Coupe');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'building', 5_000, 'build démarré');

    appRef = await createApp(c);
    // No open window → a new request would open one ending now+5h > target: binding now.
    const res = await appRef.inject({
      method: 'POST',
      url: '/api/control/cut',
      payload: { targetAt: Date.now() + 3_600_000, reservePct: 100 },
    });
    expect(res.statusCode).toBe(200);
    const quota = res.json().quota;
    expect(quota.globalPaused).toBe(true);
    expect(quota.scheduledCut.binding).toBe(true);
    await waitFor(() => c.repos.projects.byId(id)!.status === 'paused_user', 5_000, 'pause effective');
  });

  it('fires proactively at the flip moment without tick activity', async () => {
    const { c } = await testContainer({ config: { schedulerTickMs: 3_600_000 } });
    cRef = c;
    c.scheduler.start();
    // Open window closing in 700ms, target soon after: not binding while the window is open
    // (requests join it and it resets before target), binding right after the reset.
    c.repos.quota.setWindow(Date.now() + 700, 'five_hour');
    c.repos.settings.setScheduledCut({ targetAt: Date.now() + 1_500, reservePct: 100 });
    c.scheduler.cutChanged();
    expect(c.repos.settings.getGlobalPaused()).toBe(false);
    await waitFor(() => c.repos.settings.getGlobalPaused(), 3_000, 'cut déclenché par timer');
  });

  it('expiry auto-clears the cut but keeps the global pause', async () => {
    const { c } = await testContainer();
    cRef = c;
    c.scheduler.start();
    c.repos.settings.setScheduledCut({ targetAt: Date.now() + 400, reservePct: 100 });
    c.scheduler.cutChanged(); // binding immediately (no window) → pauses
    expect(c.repos.settings.getGlobalPaused()).toBe(true);
    await waitFor(() => c.scheduler.getQuotaDto().scheduledCut === null, 3_000, 'cut expiré');
    expect(c.repos.settings.getScheduledCut()).toBeNull();
    expect(c.repos.settings.getGlobalPaused()).toBe(true);
  });

  it('a reserve cut lets builds run until consumption crosses the threshold', async () => {
    const { c } = await testContainer();
    cRef = c;
    // Known ceiling (single limit hit) + open window overlapping the target.
    c.repos.usage.record('seed', 'step', { inputTokens: 100_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    c.repos.quota.recordLimitHit(100_000);
    c.db.prepare('UPDATE usage_log SET at = at - ?').run(WINDOW_MS + 60_000); // age the seed out of the window
    c.repos.quota.setWindow(Date.now() + WINDOW_MS - 1000, 'five_hour');
    c.repos.settings.setScheduledCut({ targetAt: Date.now() + 3_600_000, reservePct: 60 });
    c.scheduler.cutChanged();
    expect(c.repos.settings.getGlobalPaused()).toBe(false); // 0 consumed < 40% of 100k

    c.repos.usage.record('p1', 'step', { inputTokens: 45_000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    c.scheduler.start();
    await waitFor(() => c.repos.settings.getGlobalPaused(), 3_000, 'réserve franchie → pause');
    const dto = c.scheduler.getQuotaDto();
    expect(dto.scheduledCut!.binding).toBe(true);
    expect(dto.scheduledCut!.ceilingUnknown).toBe(false);
  });

  it('DELETE cancels the cut and lets the queue restart', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Annule');
    c.scheduler.start();
    appRef = await createApp(c);
    await appRef.inject({
      method: 'POST',
      url: '/api/control/cut',
      payload: { targetAt: Date.now() + 3_600_000, reservePct: 100 },
    });
    expect(c.repos.settings.getGlobalPaused()).toBe(true);

    await appRef.inject({ method: 'DELETE', url: '/api/control/cut' });
    expect(c.scheduler.getQuotaDto().scheduledCut).toBeNull();
    // Cancelling the cut does not auto-resume (manual decision) — resume-all does.
    await appRef.inject({ method: 'POST', url: '/api/control/resume-all' });
    await waitFor(() => c.repos.projects.byId(id)!.status !== 'queued', 5_000, 'file relancée');
  });

  it('resume-all during a binding cut overrides (drops) the cut; a pending cut survives', async () => {
    const { c } = await testContainer();
    cRef = c;
    c.scheduler.start();
    appRef = await createApp(c);
    // Binding cut (no window, target within 5h) → paused.
    await appRef.inject({ method: 'POST', url: '/api/control/cut', payload: { targetAt: Date.now() + 3_600_000, reservePct: 100 } });
    expect(c.repos.settings.getGlobalPaused()).toBe(true);
    await appRef.inject({ method: 'POST', url: '/api/control/resume-all' });
    expect(c.scheduler.getQuotaDto().scheduledCut).toBeNull();
    await new Promise((r) => setTimeout(r, 200)); // a few ticks: must NOT re-pause
    expect(c.repos.settings.getGlobalPaused()).toBe(false);

    // Pending (non-binding) cut: resume-all keeps it.
    await appRef.inject({
      method: 'POST',
      url: '/api/control/cut',
      payload: { targetAt: Date.now() + WINDOW_MS + 3_600_000, reservePct: 100 },
    });
    expect(c.repos.settings.getGlobalPaused()).toBe(false);
    await appRef.inject({ method: 'POST', url: '/api/control/resume-all' });
    expect(c.scheduler.getQuotaDto().scheduledCut).not.toBeNull();
  });

  it('rejects invalid cut payloads', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const past = await appRef.inject({ method: 'POST', url: '/api/control/cut', payload: { targetAt: Date.now() - 1000, reservePct: 100 } });
    expect(past.statusCode).toBe(400);
    for (const reservePct of [0, 101]) {
      const bad = await appRef.inject({ method: 'POST', url: '/api/control/cut', payload: { targetAt: Date.now() + 60_000, reservePct } });
      expect(bad.statusCode).toBe(400);
    }
    expect(c.scheduler.getQuotaDto().scheduledCut).toBeNull();
  });
});
