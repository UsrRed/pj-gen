import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

/** True when two runs were alive at the same moment. */
function overlaps(a: { started_at: number | null; ended_at: number | null }, b: { started_at: number | null; ended_at: number | null }): boolean {
  if (!a.started_at || !a.ended_at || !b.started_at || !b.ended_at) return false;
  return a.started_at < b.ended_at && b.started_at < a.ended_at;
}

describe('parallel task implementation', () => {
  it('stays strictly serial at taskParallelism = 1 (the shipped default)', async () => {
    const { c } = await testContainer();
    cRef = c;
    expect(c.repos.settings.getAll().taskParallelism).toBe(1);

    const id = await seedQueuedProject(c, 'Serie Par Defaut');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const taskRuns = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'implement_task');
    expect(taskRuns.length).toBe(3);
    for (let i = 0; i < taskRuns.length; i++) {
      for (let j = i + 1; j < taskRuns.length; j++) {
        expect(overlaps(taskRuns[i], taskRuns[j]), `${taskRuns[i].task_key}/${taskRuns[j].task_key}`).toBe(false);
      }
    }
    // No worktree is created on the serial path.
    expect(fs.existsSync(path.join(c.config.workspaceRoot, '.wt'))).toBe(false);
  });

  it('runs independent tasks concurrently and completes the build', async () => {
    // Slow sessions so an accidental serialisation is unmistakable in the timings.
    const { c } = await testContainer({ script: fastScript(() => undefined) });
    cRef = c;
    c.repos.settings.set({ taskParallelism: 3, maxConcurrentSessions: 4 });

    const id = await seedQueuedProject(c, 'Lot Parallele');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'pipeline complet');

    const tasks = c.repos.tasks.list(id);
    expect(tasks.length).toBe(3);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);

    // The fake breakdown has T02 and T03 both depending only on T01, with disjoint writes.
    const runs = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'implement_task');
    const t2 = runs.find((r) => r.task_key === 'T02')!;
    const t3 = runs.find((r) => r.task_key === 'T03')!;
    expect(overlaps(t2, t3)).toBe(true);

    // T01 gates both, so it must not overlap either.
    const t1 = runs.find((r) => r.task_key === 'T01')!;
    expect(overlaps(t1, t2)).toBe(false);
    expect(overlaps(t1, t3)).toBe(false);

    // Every worktree is cleaned up once its task lands.
    const wtRoot = path.join(c.config.workspaceRoot, '.wt');
    if (fs.existsSync(wtRoot)) {
      const slugDir = path.join(wtRoot, 'lot-parallele');
      expect(fs.existsSync(slugDir) ? fs.readdirSync(slugDir) : []).toEqual([]);
    }
    expect(c.repos.tasks.list(id).every((t) => t.worktree_dir === null)).toBe(true);
  });

  it('holds a polish task until every core task is finished', async () => {
    // "Don't animate before the game plays": T04 has no dependency at all, only a later phase.
    const breakdown = {
      tasks: [
        { task_key: 'T01', title: 'Boucle de jeu', description: '', files_hint: [], writes: ['src/game.js'], acceptance: ['ok'], depends_on: [], after: [], phase: 'foundation' },
        { task_key: 'T02', title: 'Déplacement', description: '', files_hint: [], writes: ['src/move.js'], acceptance: ['ok'], depends_on: ['T01'], after: [], phase: 'core' },
        { task_key: 'T03', title: 'Score', description: '', files_hint: [], writes: ['src/score.js'], acceptance: ['ok'], depends_on: ['T01'], after: [], phase: 'core' },
        { task_key: 'T04', title: 'Animations', description: '', files_hint: [], writes: ['src/anim.js'], acceptance: ['ok'], depends_on: [], after: [], phase: 'polish' },
      ],
    };
    const { c } = await testContainer({
      script: fastScript((spec) => {
        const props = Object.keys((spec.jsonSchema as { properties?: object })?.properties ?? {});
        if (props.includes('tasks')) return { result: { outcome: 'success', structured: breakdown } };
        return undefined;
      }),
    });
    cRef = c;
    c.repos.settings.set({ taskParallelism: 4, maxConcurrentSessions: 5 });

    const id = await seedQueuedProject(c, 'Phases Jeu');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'pipeline complet');

    const runs = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'implement_task');
    const at = (key: string) => runs.find((r) => r.task_key === key)!;

    // The two core tasks share a phase and disjoint writes → they run together.
    expect(overlaps(at('T02'), at('T03'))).toBe(true);
    // The polish task starts only once BOTH core tasks have finished.
    expect(at('T04').started_at!).toBeGreaterThanOrEqual(at('T02').ended_at!);
    expect(at('T04').started_at!).toBeGreaterThanOrEqual(at('T03').ended_at!);
    // And foundation gated everything, despite T04 declaring no dependency.
    expect(at('T02').started_at!).toBeGreaterThanOrEqual(at('T01').ended_at!);
    expect(at('T04').started_at!).toBeGreaterThanOrEqual(at('T01').ended_at!);

    expect(c.repos.tasks.list(id).every((t) => t.status === 'done')).toBe(true);
  });

  it('never exceeds the session pool ceiling', async () => {
    const { c } = await testContainer({ script: fastScript(() => undefined) });
    cRef = c;
    // Pool of 2: one base lease for the project leaves at most one extra → batches of 2.
    c.repos.settings.set({ taskParallelism: 4, maxConcurrentSessions: 2 });

    const id = await seedQueuedProject(c, 'Pool Borne');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'pipeline complet');

    const runs = c.repos.stepRuns.listForProject(id).filter((r) => r.started_at && r.ended_at);
    let maxConcurrent = 0;
    for (const probe of runs) {
      const alive = runs.filter((r) => overlaps(r, probe) || r.id === probe.id).length;
      maxConcurrent = Math.max(maxConcurrent, alive);
    }
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(c.repos.tasks.list(id).every((t) => t.status === 'done')).toBe(true);
  });
});

/**
 * Regression (emeline/F2): when the worktree path cannot work, the task MUST be
 * implemented in the main workspace. Before the fix the loop logged "reprise en série"
 * and then rebuilt a batch containing the same task, failing identically forever — the
 * feature was silently dropped while the rest of the build completed and shipped.
 */
describe('serial fallback when worktrees are unusable', () => {
  it('still implements every task, through the main workspace', async () => {
    const { c } = await testContainer({ script: fastScript(() => undefined) });
    cRef = c;
    c.repos.settings.set({ taskParallelism: 3, maxConcurrentSessions: 4 });
    const id = await seedQueuedProject(c, 'Repli Serie');

    // Make worktree creation fail deterministically and permanently: `.wt` is a FILE,
    // so mkdir of the per-project root can never succeed.
    fs.writeFileSync(path.join(c.config.workspaceRoot, '.wt'), 'pas un dossier');

    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 25_000, 'pipeline complet');

    const tasks = c.repos.tasks.list(id);
    expect(tasks.length).toBe(3);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(tasks.every((t) => t.worktree_dir === null)).toBe(true);

    const progress = fs.readFileSync(path.join(c.repos.projects.byId(id)!.workspace_path, 'docs/PROGRESS.md'), 'utf8');
    expect(progress).toMatch(/arbre de travail indisponible/);
    expect(progress).toMatch(/repris en série dans le workspace principal/);
  });

});
