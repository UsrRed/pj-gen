import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import { seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

describe('run timing telemetry', () => {
  it('persists a duration for every finished run and aggregates it per step', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Chrono Test');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const runs = c.repos.stepRuns.listForProject(id);
    expect(runs.length).toBeGreaterThan(0);
    // Every finished run carries a duration: without it no speedup is measurable.
    expect(runs.every((r) => r.duration_ms !== null && r.duration_ms >= 0)).toBe(true);
    // Tool steps go through `validate`, so their verification time is recorded too.
    const toolRuns = runs.filter((r) => r.step_key === 'implement_task');
    expect(toolRuns.length).toBeGreaterThan(0);
    expect(toolRuns.every((r) => r.verify_ms !== null)).toBe(true);

    const perStep = c.repos.usage.timePerStep();
    expect(perStep.length).toBeGreaterThan(0);
    const implement = perStep.find((s) => s.stepKey === 'implement_task')!;
    expect(implement.runs).toBe(toolRuns.length);
    expect(implement.totalMs).toBeGreaterThanOrEqual(implement.medianMs);
    expect(implement.p90Ms).toBeGreaterThanOrEqual(implement.medianMs);

    const perProject = c.repos.usage.timePerProject(10);
    expect(perProject[0].slug).toBe('chrono-test');
    expect(perProject[0].runs).toBe(runs.length);
  });

  it('excludes rows predating the timing migration', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Legacy Rows');
    const run = c.repos.stepRuns.create(id, 'docs', null, 1, null, 'sonnet');
    c.repos.stepRuns.finish(run.id, { status: 'succeeded' }); // no durationMs → NULL, like a pre-v8 row

    expect(c.repos.usage.timePerStep()).toEqual([]);
    expect(c.repos.usage.timePerProject(10)).toEqual([]);
  });
});
