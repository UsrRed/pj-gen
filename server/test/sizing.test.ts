import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import { PIPELINE_ORDER } from '@pjgen/shared';
import { capsFor, resolveModel } from '../src/pipeline/models.js';
import { orderFor, profileFor, SIZE_PROFILES, sizeOf } from '../src/pipeline/sizing.js';
import { seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

/** Minimal project-shaped object: the sizing helpers only ever read `size`. */
const sized = (size: string | null) => ({ size }) as never;

describe('size profiles', () => {
  it('falls back to mvp for a project created before sizing existed', () => {
    expect(sizeOf(null)).toBe('mvp');
    expect(sizeOf(sized(null))).toBe('mvp');
    // mvp must reproduce the pre-sizing behaviour exactly.
    expect(SIZE_PROFILES.mvp.maxTasks).toBe(20);
    expect(SIZE_PROFILES.mvp.maxTasksRevision).toBe(15);
    expect(SIZE_PROFILES.mvp.capMultiplier).toBe(1);
    expect(SIZE_PROFILES.mvp.skipSteps).toEqual([]);
  });

  it('drops whole steps only for the small tier', () => {
    expect(orderFor(PIPELINE_ORDER, SIZE_PROFILES.small)).not.toContain('design_benchmark');
    expect(orderFor(PIPELINE_ORDER, SIZE_PROFILES.small)).not.toContain('test_hardening');
    for (const tier of ['mvp', 'large', 'enterprise'] as const) {
      expect(orderFor(PIPELINE_ORDER, SIZE_PROFILES[tier])).toEqual(PIPELINE_ORDER);
    }
  });

  it('task budgets grow monotonically with the tier', () => {
    const budgets = (['small', 'mvp', 'large', 'enterprise'] as const).map((t) => SIZE_PROFILES[t].maxTasks);
    expect(budgets).toEqual([...budgets].sort((a, b) => a - b));
    expect(new Set(budgets).size).toBe(budgets.length);
  });

  it('merges operator overrides over the built-in profile', async () => {
    const { c } = await testContainer();
    cRef = c;
    c.repos.settings.set({ sizeProfiles: { small: { maxTasks: 9, taskParallelism: 4 } } });
    const p = profileFor(c.repos, sized('small'));
    expect(p.maxTasks).toBe(9);
    expect(p.taskParallelism).toBe(4);
    // Untouched fields keep their built-in value.
    expect(p.skipSteps).toEqual(SIZE_PROFILES.small.skipSteps);
    expect(p.capMultiplier).toBe(SIZE_PROFILES.small.capMultiplier);
  });
});

describe('capsFor', () => {
  it('scales build steps by the tier but never the framing steps', async () => {
    const { c } = await testContainer();
    cRef = c;
    const base = capsFor(c.repos, 'implement_task');
    const small = capsFor(c.repos, 'implement_task', sized('small'));
    const ent = capsFor(c.repos, 'implement_task', sized('enterprise'));
    expect(small.maxTurns).toBeLessThan(base.maxTurns);
    expect(ent.maxTurns).toBeGreaterThan(base.maxTurns);

    // Cadrage is an interview: its length has nothing to do with the project's size.
    const cadrageSmall = capsFor(c.repos, 'cadrage', sized('small'));
    const cadrageEnt = capsFor(c.repos, 'cadrage', sized('enterprise'));
    expect(cadrageSmall).toEqual(cadrageEnt);
    expect(cadrageSmall).toEqual(capsFor(c.repos, 'cadrage'));
  });

  it('never overrides a cap the operator set by hand', async () => {
    const { c } = await testContainer();
    cRef = c;
    c.repos.settings.set({ stepCaps: { implement_task: { turns: 42, timeoutMin: 11 } } });
    for (const tier of ['small', 'mvp', 'large', 'enterprise'] as const) {
      const caps = capsFor(c.repos, 'implement_task', sized(tier));
      expect(caps.maxTurns).toBe(42);
      expect(caps.timeoutMs).toBe(11 * 60_000);
    }
    // An untouched step is still scaled.
    expect(capsFor(c.repos, 'polish', sized('small')).maxTurns).toBeLessThan(capsFor(c.repos, 'polish').maxTurns);
  });

  it('clamps a wild multiplier into sane bounds', async () => {
    const { c } = await testContainer();
    cRef = c;
    c.repos.settings.set({ sizeProfiles: { small: { capMultiplier: 0.001 }, enterprise: { capMultiplier: 99 } } });
    expect(capsFor(c.repos, 'implement_task', sized('small')).maxTurns).toBe(4);
    expect(capsFor(c.repos, 'implement_task', sized('enterprise')).maxTurns).toBe(200);
    expect(capsFor(c.repos, 'implement_task', sized('enterprise')).timeoutMs).toBe(180 * 60_000);
  });
});

describe('resolveModel precedence', () => {
  it('project override > operator setting > size profile > built-in default', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Routing Test');
    const row = () => c.repos.projects.byId(id)!;

    // Built-in default for architecture is opus.
    c.repos.projects.patch(id, { size: 'mvp' });
    expect(resolveModel(c.repos, row(), 'architecture').model).toBe('opus');

    // The small tier routes architecture to sonnet.
    c.repos.projects.patch(id, { size: 'small' });
    expect(resolveModel(c.repos, row(), 'architecture').model).toBe('sonnet');

    // An explicit operator setting outranks the tier.
    c.repos.settings.set({ stepModels: { architecture: 'haiku' } });
    expect(resolveModel(c.repos, row(), 'architecture').model).toBe('haiku');

    // A per-project override outranks everything.
    c.repos.projects.patch(id, { step_model_overrides: JSON.stringify({ architecture: 'opus' }) });
    expect(resolveModel(c.repos, row(), 'architecture').model).toBe('opus');
  });
});

describe('pipeline shape by tier (fake runner)', () => {
  it('a small project skips the benchmark and the test hardening', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Petit Projet');
    c.repos.projects.patch(id, { size: 'small', size_source: 'user' });
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const stepKeys = new Set(c.repos.stepRuns.listForProject(id).map((r) => r.step_key));
    expect(stepKeys.has('design_benchmark')).toBe(false);
    expect(stepKeys.has('test_hardening')).toBe(false);
    // The gates that protect quality are still there. (final_verify spawns no session
    // when its checks pass first time — reaching the deploy gate is its proof.)
    expect(stepKeys.has('feature_check')).toBe(true);
    expect(stepKeys.has('implement_task')).toBe(true);
  });

  it('an explicit per-project benchmark choice beats the tier default', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Petit Mais Benchmark');
    c.repos.projects.patch(id, { size: 'small', size_source: 'user', design_benchmark: 1 });
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const stepKeys = new Set(c.repos.stepRuns.listForProject(id).map((r) => r.step_key));
    expect(stepKeys.has('design_benchmark')).toBe(true);
    expect(stepKeys.has('test_hardening')).toBe(false); // still skipped by the tier
  });
});
