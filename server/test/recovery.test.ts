import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import { recoverOnBoot } from '../src/pipeline/recovery.js';
import { seedQueuedProject, testContainer } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

describe('recoverOnBoot', () => {
  it('orphans running runs and requeues interrupted builds', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Crashed');
    expect(c.repos.projects.casStatus(id, ['queued'], 'building')).toBe(true);
    c.repos.sessions.insert('sess-1', id, 'step');
    const run = c.repos.stepRuns.create(id, 'scaffold', null, 1, 'sess-1', 'opus');
    c.repos.stepRuns.setPid(run.id, 999_999_999); // dead pid

    const r = recoverOnBoot(c);
    expect(r.orphanedRuns).toBe(1);
    expect(r.requeued).toBe(1);
    expect(c.repos.stepRuns.byId(run.id)!.status).toBe('orphaned');
    expect(c.repos.projects.byId(id)!.status).toBe('queued');
    // The orphaned run's session is picked up for resume by the next engine pass.
    expect(c.repos.stepRuns.latestOrphaned(id, 'scaffold', null)!.session_id).toBe('sess-1');
  });

  it('parks as interrupted after repeated orphaning (crash-loop guard)', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Looping');
    c.repos.projects.casStatus(id, ['queued'], 'building');
    c.repos.sessions.insert('sess-2', id, 'step');
    for (let i = 0; i < 4; i++) {
      const run = c.repos.stepRuns.create(id, 'scaffold', null, 1, 'sess-2', 'opus');
      c.repos.stepRuns.finish(run.id, { status: 'orphaned', errorKind: 'crash', errorMessage: 'x' });
    }
    const run = c.repos.stepRuns.create(id, 'scaffold', null, 1, 'sess-2', 'opus');
    void run;

    const r = recoverOnBoot(c);
    expect(r.parked).toBe(1);
    expect(c.repos.projects.byId(id)!.status).toBe('interrupted');
  });
});
