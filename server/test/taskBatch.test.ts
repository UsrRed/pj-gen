import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@pjgen/shared';
import { dagWidth, normalizePath, pathsConflict, pickBatch, overlappingPairs, readySet } from '../src/pipeline/taskBatch.js';
import { checkTaskDag, topoOrder } from '../src/pipeline/steps.js';

let pos = 0;
function task(taskKey: string, opts: Partial<TaskDto> = {}): TaskDto {
  return {
    taskKey,
    position: opts.position ?? pos++,
    title: taskKey,
    description: '',
    filesHint: [],
    writes: [],
    acceptance: ['ok'],
    dependsOn: [],
    after: [],
    phase: 'core',
    status: 'pending',
    commitSha: null,
    ...opts,
  };
}

describe('path helpers', () => {
  it('normalises and compares by directory prefix', () => {
    expect(normalizePath('./Src/App.ts')).toBe('src/app.ts');
    expect(normalizePath('src/api/')).toBe('src/api');
    expect(pathsConflict('src/a.ts', 'src/a.ts')).toBe(true);
    expect(pathsConflict('src/api', 'src/api/routes.ts')).toBe(true);
    expect(pathsConflict('src/api/routes.ts', 'src/api')).toBe(true);
    expect(pathsConflict('src/a.ts', 'src/b.ts')).toBe(false);
    // Prefix must be a directory boundary, not a bare string prefix.
    expect(pathsConflict('src/api', 'src/apiary.ts')).toBe(false);
  });
});

describe('readySet', () => {
  it('only returns tasks whose dependencies are all done', () => {
    const tasks = [
      task('T01', { position: 0, status: 'done' }),
      task('T02', { position: 1, dependsOn: ['T01'] }),
      task('T03', { position: 2, dependsOn: ['T02'] }),
      task('T04', { position: 3 }),
    ];
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T02', 'T04']);
  });
});

describe('task relations (after + phase)', () => {
  it('an `after` relation holds a task back even with no contract dependency', () => {
    const tasks = [
      task('T01', { position: 0, title: 'Gameplay' }),
      // The animation could technically be written now, but doing it on a half-built
      // feature means redoing it — that is exactly what `after` expresses.
      task('T02', { position: 1, title: 'Animation', after: ['T01'] }),
    ];
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T01']);

    tasks[0].status = 'done';
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T02']);
  });

  it('the phase barrier holds polish back until ALL earlier-phase work is done', () => {
    // The stated case: no animations before the game actually plays — without having to
    // list every gameplay task in `after`.
    const tasks = [
      task('T01', { position: 0, phase: 'foundation', status: 'done' }),
      task('T02', { position: 1, phase: 'core', title: 'Déplacement' }),
      task('T03', { position: 2, phase: 'core', title: 'Score' }),
      task('T04', { position: 3, phase: 'polish', title: 'Animations' }),
    ];
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T02', 'T03']);

    tasks[1].status = 'done';
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T03']); // one core task left → polish still waits

    tasks[2].status = 'done';
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T04']);
  });

  it('foundation gates everything, including tasks with no declared dependency', () => {
    const tasks = [
      task('T01', { position: 0, phase: 'foundation', title: 'Boucle de jeu' }),
      task('T02', { position: 1, phase: 'core', title: 'Indépendante' }),
    ];
    expect(readySet(tasks).map((t) => t.taskKey)).toEqual(['T01']);
  });

  it('parallelism survives inside a phase', () => {
    const tasks = [
      task('T01', { position: 0, phase: 'core', writes: ['a.ts'] }),
      task('T02', { position: 1, phase: 'core', writes: ['b.ts'] }),
      task('T03', { position: 2, phase: 'polish', writes: ['c.ts'] }),
    ];
    expect(pickBatch(readySet(tasks), 4).map((t) => t.taskKey)).toEqual(['T01', 'T02']);
    expect(dagWidth(tasks)).toBe(2);
  });

  it('does not flag overlapping writes across phases or across an `after`', () => {
    const tasks = [
      task('T01', { position: 0, phase: 'core', writes: ['src/game.ts'] }),
      task('T02', { position: 1, phase: 'polish', writes: ['src/game.ts'] }),
      task('T03', { position: 2, phase: 'core', writes: ['src/hud.ts'] }),
      task('T04', { position: 3, phase: 'core', writes: ['src/hud.ts'], after: ['T03'] }),
    ];
    expect(overlappingPairs(tasks)).toEqual([]);
  });

  it('topoOrder places polish last whatever the positions say', () => {
    const tasks = [
      task('T01', { position: 0, phase: 'polish', title: 'Animations' }),
      task('T02', { position: 1, phase: 'core' }),
      task('T03', { position: 2, phase: 'foundation' }),
    ];
    expect(topoOrder(tasks).map((t) => t.taskKey)).toEqual(['T03', 'T02', 'T01']);
  });
});

describe('pickBatch', () => {
  it('batches tasks with disjoint write sets', () => {
    const ready = [
      task('T02', { position: 1, writes: ['src/a.ts'] }),
      task('T03', { position: 2, writes: ['src/b.ts'] }),
      task('T04', { position: 3, writes: ['src/c.ts'] }),
    ];
    expect(pickBatch(ready, 3).map((t) => t.taskKey)).toEqual(['T02', 'T03', 'T04']);
    expect(pickBatch(ready, 2).map((t) => t.taskKey)).toEqual(['T02', 'T03']);
  });

  it('serialises tasks whose writes overlap', () => {
    const ready = [
      task('T02', { position: 1, writes: ['src/api/routes.ts'] }),
      task('T03', { position: 2, writes: ['src/api'] }), // directory covering T02's file
      task('T04', { position: 3, writes: ['src/ui.ts'] }),
    ];
    expect(pickBatch(ready, 3).map((t) => t.taskKey)).toEqual(['T02', 'T04']);
  });

  it('runs a manifest-touching task alone', () => {
    const ready = [
      task('T02', { position: 1, writes: ['package.json', 'src/dep.ts'] }),
      task('T03', { position: 2, writes: ['src/b.ts'] }),
    ];
    // Concurrent installs on a shared node_modules are a guaranteed race.
    expect(pickBatch(ready, 3).map((t) => t.taskKey)).toEqual(['T02']);
  });

  it('runs a task with no declared writes alone', () => {
    const ready = [task('T02', { position: 1, writes: [] }), task('T03', { position: 2, writes: ['src/b.ts'] })];
    expect(pickBatch(ready, 3).map((t) => t.taskKey)).toEqual(['T02']);
  });

  it('skips a hot-path task that cannot head the batch, without stalling', () => {
    const ready = [
      task('T02', { position: 1, writes: ['src/a.ts'] }),
      task('T03', { position: 2, writes: ['package.json'] }),
      task('T04', { position: 3, writes: ['src/c.ts'] }),
    ];
    expect(pickBatch(ready, 3).map((t) => t.taskKey)).toEqual(['T02', 'T04']);
  });

  it('always makes progress: width 1 or an empty batch still yields one task', () => {
    const ready = [task('T02', { position: 1, writes: ['src/a.ts'] })];
    expect(pickBatch(ready, 1).map((t) => t.taskKey)).toEqual(['T02']);
    expect(pickBatch([], 4)).toEqual([]);
  });
});

describe('dagWidth and overlaps', () => {
  it('reports 1 for a strictly linear breakdown', () => {
    const tasks = [
      task('T01', { position: 0, writes: ['a.ts'] }),
      task('T02', { position: 1, writes: ['b.ts'], dependsOn: ['T01'] }),
      task('T03', { position: 2, writes: ['c.ts'], dependsOn: ['T02'] }),
    ];
    expect(dagWidth(tasks)).toBe(1);
  });

  it('reports the real width of a branching breakdown', () => {
    const tasks = [
      task('T01', { position: 0, writes: ['a.ts'], status: 'done' }),
      task('T02', { position: 1, writes: ['b.ts'], dependsOn: ['T01'] }),
      task('T03', { position: 2, writes: ['c.ts'], dependsOn: ['T01'] }),
      task('T04', { position: 3, writes: ['d.ts'], dependsOn: ['T01'] }),
    ];
    expect(dagWidth(tasks)).toBe(3);
  });

  it('flags independent tasks that write the same file', () => {
    const tasks = [
      task('T01', { position: 0, writes: ['src/index.ts'] }),
      task('T02', { position: 1, writes: ['src/index.ts'] }),
      task('T03', { position: 2, writes: ['src/other.ts'], dependsOn: ['T01'] }),
    ];
    expect(overlappingPairs(tasks)).toEqual([['T01', 'T02']]);
  });

  it('does not flag tasks linked by a transitive dependency', () => {
    const tasks = [
      task('T01', { position: 0, writes: ['src/index.ts'] }),
      task('T02', { position: 1, writes: ['src/mid.ts'], dependsOn: ['T01'] }),
      task('T03', { position: 2, writes: ['src/index.ts'], dependsOn: ['T02'] }),
    ];
    expect(overlappingPairs(tasks)).toEqual([]);
  });
});

describe('checkTaskDag', () => {
  it('accepts a branching DAG whose dependency is listed later', () => {
    // The old rule rejected this outright, which is why no breakdown could ever be wide.
    expect(checkTaskDag([{ task_key: 'T02', depends_on: ['T01'] }, { task_key: 'T01', depends_on: [] }])).toBeNull();
  });

  it('accepts a diamond', () => {
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: [] },
        { task_key: 'T02', depends_on: ['T01'] },
        { task_key: 'T03', depends_on: ['T01'] },
        { task_key: 'T04', depends_on: ['T02', 'T03'] },
      ])
    ).toBeNull();
  });

  it('still rejects duplicates, unknown deps, self-deps and cycles', () => {
    expect(checkTaskDag([{ task_key: 'T01', depends_on: [] }, { task_key: 'T01', depends_on: [] }])).toMatch(/dupliqu/);
    expect(checkTaskDag([{ task_key: 'T01', depends_on: ['T09'] }])).toMatch(/inconnue/);
    expect(checkTaskDag([{ task_key: 'T01', depends_on: ['T01'] }])).toMatch(/elle-même/);
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: ['T02'] },
        { task_key: 'T02', depends_on: ['T01'] },
      ])
    ).toMatch(/cycle/);
  });

  it('treats ordering relations as cycle-forming edges too', () => {
    // An `after` loop would deadlock the scheduler just as surely as a contract loop.
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: [], after: ['T02'] },
        { task_key: 'T02', depends_on: [], after: ['T01'] },
      ])
    ).toMatch(/cycle/);
    expect(checkTaskDag([{ task_key: 'T01', depends_on: [], after: ['T09'] }])).toMatch(/inconnue/);
    // A mixed loop (contract one way, ordering the other) is caught too.
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: ['T02'], after: [] },
        { task_key: 'T02', depends_on: [], after: ['T01'] },
      ])
    ).toMatch(/cycle/);
  });

  it('rejects a relation that points at a LATER phase (it could never unblock)', () => {
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: [], after: ['T02'], phase: 'core' },
        { task_key: 'T02', depends_on: [], after: [], phase: 'polish' },
      ])
    ).toMatch(/contraire aux phases/);
    // The right way round is fine.
    expect(
      checkTaskDag([
        { task_key: 'T01', depends_on: [], after: [], phase: 'core' },
        { task_key: 'T02', depends_on: [], after: ['T01'], phase: 'polish' },
      ])
    ).toBeNull();
  });

  it('topoOrder still linearises a branching DAG', () => {
    const tasks = [
      task('T04', { position: 3, dependsOn: ['T02', 'T03'] }),
      task('T01', { position: 0 }),
      task('T02', { position: 1, dependsOn: ['T01'] }),
      task('T03', { position: 2, dependsOn: ['T01'] }),
    ];
    expect(topoOrder(tasks).map((t) => t.taskKey)).toEqual(['T01', 'T02', 'T03', 'T04']);
  });
});
