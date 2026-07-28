import { phaseRank, type TaskDto } from '@pjgen/shared';

/**
 * Picking a set of tasks that can safely run at the same time.
 *
 * `topoOrder` already computes a full ready-set but the serial loop only ever used
 * its first element. The constraint that makes a batch safe is not the dependency
 * graph alone — two independent tasks that both edit `src/app.ts` will conflict at
 * merge time — so batching is driven by the `writes` commitment each task declares.
 */

/** Paths that are conflictual by nature: a task writing one of them runs ALONE. */
const HOT_PATHS = new Set([
  // Dependency manifests: a concurrent install on a shared node_modules is a race.
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'uv.lock',
  'go.mod',
  'go.sum',
  'cargo.toml',
  'cargo.lock',
  'gemfile',
  'gemfile.lock',
  // Orchestrator-owned or project-wide contract files.
  'docs/tasks.json',
  'docs/interfaces.md',
  'docs/architecture.md',
  'docs/spec.md',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'jest.config.js',
]);

/** Lower-cased, slash-normalised, leading `./` and trailing `/` removed. */
export function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function isHotPath(p: string): boolean {
  return HOT_PATHS.has(normalizePath(p));
}

/** Two paths conflict when they are equal or one is a directory prefix of the other. */
export function pathsConflict(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  if (!x || !y) return true; // an unparseable claim is treated as claiming everything
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Every edge that gates a task: contract dependencies AND ordering relations. */
export function blockingEdges(task: TaskDto): string[] {
  return [...new Set([...task.dependsOn, ...(task.after ?? [])])];
}

/**
 * Tasks not yet done that nothing is holding back.
 *
 * Three gates, all of which must clear:
 *  1. contract dependencies (`dependsOn`) — the code could not be written otherwise;
 *  2. ordering relations (`after`) — the architect said "not before that one is finished";
 *  3. the phase barrier — no task of a later phase starts while an earlier phase has
 *     work left. This is what keeps animation work from starting on a half-built game
 *     without the architect having to name every gameplay task.
 */
export function readySet(tasks: TaskDto[]): TaskDto[] {
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));
  // Lowest phase that still has unfinished work; anything above it must wait.
  const openPhase = Math.min(...tasks.filter((t) => t.status !== 'done').map((t) => phaseRank(t.phase)), Number.MAX_SAFE_INTEGER);

  return tasks.filter((t) => {
    if (t.status === 'done') return false;
    if (phaseRank(t.phase) > openPhase) return false;
    // An edge pointing at a task that does not exist cannot block (checkTaskDag rejects those).
    return blockingEdges(t).every((d) => !byKey.has(d) || byKey.get(d)!.status === 'done');
  });
}

/** Width of the widest set of mutually independent, write-disjoint ready tasks. */
export function dagWidth(tasks: TaskDto[]): number {
  return pickBatch(readySet(tasks), Number.MAX_SAFE_INTEGER).length;
}

/**
 * Greedy selection in position order. Returns at least one task whenever `ready` is
 * non-empty, so the caller always makes progress — a batch of one is exactly the
 * pre-existing serial path.
 */
export function pickBatch(ready: TaskDto[], width: number): TaskDto[] {
  if (!ready.length) return [];
  const ordered = [...ready].sort((a, b) => a.position - b.position);
  if (width <= 1) return [ordered[0]];

  const batch: TaskDto[] = [];
  const claimed: string[] = [];

  for (const task of ordered) {
    if (batch.length >= width) break;
    const writes = task.writes.map(normalizePath).filter(Boolean);

    // No declared write set → unknown blast radius. Hot path → guaranteed conflict.
    // Either way the task runs alone; only take it if it can head the batch.
    if (!writes.length || writes.some(isHotPath)) {
      if (batch.length === 0) return [task];
      continue;
    }

    if (writes.some((w) => claimed.some((c) => pathsConflict(w, c)))) continue;
    batch.push(task);
    claimed.push(...writes);
  }

  return batch.length ? batch : [ordered[0]];
}

/**
 * Pairs of independent tasks whose write sets overlap. Reported, never rejected:
 * pickBatch already protects execution, and a genuinely linear product is legitimate.
 */
export function overlappingPairs(tasks: TaskDto[]): [string, string][] {
  const out: [string, string][] = [];
  const dependsTransitively = buildReachability(tasks);
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (dependsTransitively(a.taskKey, b.taskKey) || dependsTransitively(b.taskKey, a.taskKey)) continue;
      // Different phases never overlap either.
      if (phaseRank(a.phase) !== phaseRank(b.phase)) continue;
      if (a.writes.some((w) => b.writes.some((v) => pathsConflict(w, v)))) out.push([a.taskKey, b.taskKey]);
    }
  }
  return out;
}

function buildReachability(tasks: TaskDto[]): (from: string, to: string) => boolean {
  // Ordering edges count too: two tasks separated by an `after` never run together,
  // so an overlapping write set between them is not a problem worth reporting.
  const deps = new Map(tasks.map((t) => [t.taskKey, blockingEdges(t)]));
  const memo = new Map<string, Set<string>>();
  const reach = (key: string, seen = new Set<string>()): Set<string> => {
    const cached = memo.get(key);
    if (cached) return cached;
    if (seen.has(key)) return new Set(); // cycle guard; checkTaskDag rejects these anyway
    seen.add(key);
    const out = new Set<string>();
    for (const d of deps.get(key) ?? []) {
      out.add(d);
      for (const t of reach(d, seen)) out.add(t);
    }
    memo.set(key, out);
    return out;
  };
  return (from, to) => reach(from).has(to);
}
