import { DEFAULT_TASK_PHASE, phaseRank, type StackInfo, type StepKey, type TaskDto } from '@pjgen/shared';
import type { z } from 'zod';
import type { CoreDeps } from '../core/deps.js';
import { executeClaudeRun, newSessionId, type ExecSession } from './stepRunner.js';
import { capsFor, resolveModel } from './models.js';
import { verifyStack, type VerifyKind } from './verify.js';
import {
  extractStructured,
  ArchOutputZ,
  ARCH_JSON_SCHEMA,
  BenchmarkOutputZ,
  BENCHMARK_JSON_SCHEMA,
  BreakdownOutputZ,
  BREAKDOWN_JSON_SCHEMA,
  DesignOutputZ,
  DESIGN_JSON_SCHEMA,
  FeatureAuditZ,
  FEATURE_AUDIT_JSON_SCHEMA,
  type FeatureAudit,
} from '../prompts/schemas.js';
import {
  archPrompt,
  archUpdatePrompt,
  breakdownPrompt,
  breakdownRevisionPrompt,
  scaffoldPrompt,
  implementTaskPrompt,
  resumePrompt,
  wrapUpPrompt,
  testHardeningPrompt,
  reviewFixPrompt,
  docsPrompt,
  fixVerifyPrompt,
  polishPrompt,
  featureAuditPrompt,
  featureFixPrompt,
  designPrompt,
  designBenchmarkPrompt,
  designExcerptBlock,
  DESIGN_NOTE_TOOL,
  WORKTREE_RULES,
} from '../prompts/steps.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { auditCommits } from './attribution.js';
import { profileFor } from './sizing.js';
import { accessBlock } from '../prompts/access.js';
import { blockingEdges, dagWidth, overlappingPairs, pickBatch, readySet } from './taskBatch.js';
import { releaseAll } from '../core/sessionPool.js';
import { toAccessDto, toTaskDto } from '../db/repos/index.js';

export type StepFlow =
  | { status: 'ok' }
  | { status: 'parked' }
  | { status: 'halted'; mode: 'pause' | 'cancel' }
  | { status: 'failed'; message: string };

export interface StepCtx {
  deps: CoreDeps;
  projectId: string;
  workspace: string;
  signal: AbortSignal;
  getStack(): StackInfo | null;
  setStack(s: StackInfo): void;
}

export function haltMode(signal: AbortSignal): 'pause' | 'cancel' {
  return signal.reason === 'pause' ? 'pause' : 'cancel';
}

function baseSpec(ctx: StepCtx, stepKey: string, workRoot?: string) {
  const { repos } = ctx.deps;
  const project = repos.projects.byId(ctx.projectId)!;
  const { model, fallbackModel } = resolveModel(repos, project, stepKey);
  const caps = capsFor(repos, stepKey, project);
  const settings = repos.settings.getAll();
  return {
    cwd: workRoot ?? ctx.workspace,
    model,
    fallbackModel,
    appendSystemPrompt: commonSystemPrompt(),
    maxBudgetUsd: settings.maxBudgetUsdPerSession,
    maxTurns: caps.maxTurns,
    timeoutMs: caps.timeoutMs,
  };
}

// ---------- generation steps (no tools, single turn, orchestrator writes files) ----------

interface GenOpts<T> {
  stepKey: StepKey;
  buildPrompt: (lastError?: string) => string;
  jsonSchema: object;
  zodSchema: z.ZodType<T>;
  semanticCheck?: (data: T) => string | null;
  apply: (data: T) => Promise<void>;
  maxAttempts?: number;
  /** Defaults to 'none'; a named allowlist lets a generation step search the web (design benchmark). */
  tools?: 'none' | string[];
}

async function runGenerationStep<T>(ctx: StepCtx, o: GenOpts<T>): Promise<StepFlow> {
  const maxAttempts = o.maxAttempts ?? 2;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };
    let parsedData: T | null = null;

    const session: ExecSession = { id: newSessionId(), resume: false, kind: 'step' };
    const { result } = await executeClaudeRun(ctx.deps, {
      projectId: ctx.projectId,
      stepKey: o.stepKey,
      taskKey: null,
      attempt,
      isLastAttempt: attempt === maxAttempts,
      session,
      signal: ctx.signal,
      spec: {
        ...baseSpec(ctx, o.stepKey),
        prompt: o.buildPrompt(lastError),
        tools: o.tools ?? 'none',
        jsonSchema: o.jsonSchema,
      },
      validate: async (r) => {
        const parsed = extractStructured(o.zodSchema, r.structured, r.resultText);
        if (!parsed.ok) return { ok: false, kind: 'schema_invalid', message: `sortie structurée invalide: ${parsed.error}` };
        const semantic = o.semanticCheck?.(parsed.data) ?? null;
        if (semantic) return { ok: false, kind: 'schema_invalid', message: semantic };
        parsedData = parsed.data;
        return { ok: true };
      },
    });

    if (result.outcome === 'success' && parsedData !== null) {
      await o.apply(parsedData);
      return { status: 'ok' };
    }
    const f = result.failure!;
    if (f.kind === 'usage_limit') return { status: 'parked' };
    if (f.kind === 'canceled') return { status: 'halted', mode: haltMode(ctx.signal) };
    if (f.kind === 'auth') return { status: 'failed', message: f.message };
    lastError = f.message;
  }
  return { status: 'failed', message: lastError ?? 'échec de génération' };
}

// ---------- tool steps (full autonomy inside the workspace) ----------

/**
 * Landing run after a cap kill (see runToolStep): the timed-out session is resumed
 * with wrapUpPrompt() and this tiny budget — its only job is to commit a clean state.
 */
export const WRAP_UP_CAPS = { maxTurns: 20, timeoutMs: 10 * 60 * 1000 };

interface ToolOpts {
  stepKey: StepKey;
  taskKey?: string | null;
  capKey?: string;
  buildPrompt: (attempt: number, failureTail?: string) => string;
  verifyKinds: VerifyKind[];
  requireNewCommit: boolean;
  maxAttempts: number;
  /** Directory the session works in; defaults to the project workspace. A parallel task
   *  passes its own git worktree so commit detection and verification target that tree. */
  workRoot?: string;
}

async function runToolStep(ctx: StepCtx, o: ToolOpts): Promise<StepFlow> {
  const { deps } = ctx;
  const { repos, ws, config } = deps;
  const taskKey = o.taskKey ?? null;
  const workRoot = o.workRoot ?? ctx.workspace;

  // Resume a session interrupted by the usage limit (or a crash) when one exists.
  const paused = repos.stepRuns.latestPaused(ctx.projectId, o.stepKey, taskKey);
  const orphaned = repos.stepRuns.latestOrphaned(ctx.projectId, o.stepKey, taskKey);
  const resumable = [paused, orphaned].filter(Boolean).sort((a, b) => b!.id - a!.id)[0];
  let resumeSessionId = resumable?.session_id ?? null;
  let attempt = resumable?.attempt ?? 1;
  let failureTail: string | undefined;
  let lastSessionId: string | null = null;
  let lastMessage = 'échec';
  // Session killed at the turn/duration cap: the next attempt resumes it with a small
  // "land now, commit what you have" budget instead of restarting the exploration from scratch.
  let wrapUpSessionId: string | null = null;

  while (attempt <= o.maxAttempts) {
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    const headBefore = await ws.headSha(workRoot);
    let session: ExecSession;
    let prompt: string;
    const isWrapUp = wrapUpSessionId !== null;
    if (isWrapUp) {
      session = { id: wrapUpSessionId!, resume: true, kind: 'step' };
      prompt = wrapUpPrompt(ctx.getStack()?.test_cmd);
      wrapUpSessionId = null;
    } else if (resumeSessionId) {
      session = { id: resumeSessionId, resume: true, kind: 'step' };
      prompt = resumePrompt();
    } else if (attempt >= 3 && lastSessionId) {
      session = { id: lastSessionId, resume: true, fork: true, kind: 'step' };
      prompt = o.buildPrompt(attempt, failureTail);
    } else {
      session = { id: newSessionId(), resume: false, kind: 'step' };
      prompt = o.buildPrompt(attempt, failureTail);
    }

    const capKey = o.capKey ?? o.stepKey;
    const caps = isWrapUp ? WRAP_UP_CAPS : capsFor(repos, capKey, repos.projects.byId(ctx.projectId));
    const { result } = await executeClaudeRun(deps, {
      projectId: ctx.projectId,
      stepKey: o.stepKey,
      taskKey,
      attempt,
      isLastAttempt: attempt === o.maxAttempts,
      session,
      signal: ctx.signal,
      spec: {
        ...baseSpec(ctx, capKey, workRoot),
        maxTurns: caps.maxTurns,
        timeoutMs: caps.timeoutMs,
        // Announce the budget so the session plans its landing instead of dying at the cap.
        appendSystemPrompt: commonSystemPrompt(caps),
        prompt,
        tools: 'default',
      },
      validate: async () => {
        if (o.requireNewCommit && !config.fakeCli) {
          const hasNew = await ws.hasNewCommitSince(workRoot, headBefore);
          if (!hasNew) return { ok: false, kind: 'verify_failed', message: 'aucun nouveau commit créé par la session' };
        }
        const v = await verifyStack(config, workRoot, ctx.getStack(), o.verifyKinds);
        if (!v.ok) return { ok: false, kind: 'verify_failed', message: `${v.label}\n${v.tail}`.slice(-1800) };
        return { ok: true };
      },
    });

    if (result.outcome === 'success') return { status: 'ok' };

    const f = result.failure!;
    if (f.kind === 'usage_limit') return { status: 'parked' };
    if (f.kind === 'canceled') return { status: 'halted', mode: haltMode(ctx.signal) };
    if (f.kind === 'auth') return { status: 'failed', message: f.message };
    if (f.kind === 'resume_lost') {
      // Fresh restart of the step: durable state lives in git; prompts open with `git status`.
      resumeSessionId = null;
      continue;
    }
    lastMessage = f.message;
    failureTail = f.message;
    lastSessionId = session.id;
    resumeSessionId = null;
    // Cap kill on a regular run → the next attempt is a wrap-up resume of the same
    // session (a wrap-up that dies at its own cap falls back to a fresh/fork restart).
    if (f.kind === 'timeout' && !isWrapUp) wrapUpSessionId = session.id;
    attempt += 1;
  }
  return { status: 'failed', message: lastMessage };
}

// ---------- concrete steps ----------

/**
 * Optional web mini-benchmark BEFORE the design step: looks up how existing products of the
 * same domain look, writes docs/design/BENCHMARK.md (injected into the design prompt).
 * NON-BLOCKING: any failure (WebSearch unavailable, timeout, invalid schema) lets the
 * pipeline continue without a benchmark — only usage-limit parking and halts bubble up.
 */
export async function stepDesignBenchmark(ctx: StepCtx): Promise<StepFlow> {
  const { ws, repos, bus } = ctx.deps;
  // A user-provided mockup wins over the whole design phase — no benchmark needed.
  if (ws.hasDesignReference(ctx.workspace)) return { status: 'ok' };
  const project = repos.projects.byId(ctx.projectId)!;
  const enabled = project.design_benchmark === null ? repos.settings.getAll().designBenchmark : project.design_benchmark === 1;
  if (!enabled) return { status: 'ok' };
  const spec = ws.readFile(ctx.workspace, 'docs/SPEC.md');
  if (!spec) return { status: 'failed', message: 'docs/SPEC.md introuvable' };

  const flow = await runGenerationStep(ctx, {
    stepKey: 'design_benchmark',
    maxAttempts: 1,
    tools: ['WebSearch', 'WebFetch'],
    buildPrompt: () => designBenchmarkPrompt(spec.content),
    jsonSchema: BENCHMARK_JSON_SCHEMA,
    zodSchema: BenchmarkOutputZ,
    apply: async (d) => {
      if (!d.applicable || !d.benchmark_markdown.trim()) {
        ws.appendProgress(ctx.workspace, 'design_benchmark: non applicable (pas d’interface visuelle)');
        return;
      }
      ws.writeFile(ctx.workspace, 'docs/design/BENCHMARK.md', d.benchmark_markdown);
      await ws.commitAll(ctx.workspace, 'docs: design benchmark');
      bus.emit('artifact.updated', ctx.projectId, { path: 'docs/design/BENCHMARK.md' });
    },
  });
  if (flow.status === 'failed') {
    ws.appendProgress(ctx.workspace, `design_benchmark ignoré: ${flow.message.slice(0, 300)}`);
    return { status: 'ok' };
  }
  return flow;
}

/**
 * Autonomous design step: generates the reference mockup (self-contained HTML + design system)
 * from the SPEC — no HITL. Skipped when a mockup already exists (user-provided override wins).
 */
export async function stepDesign(ctx: StepCtx): Promise<StepFlow> {
  const { ws, bus } = ctx.deps;
  if (ws.hasDesignReference(ctx.workspace)) return { status: 'ok' };
  const spec = ws.readFile(ctx.workspace, 'docs/SPEC.md');
  if (!spec) return { status: 'failed', message: 'docs/SPEC.md introuvable' };
  const benchmark = ws.readFile(ctx.workspace, 'docs/design/BENCHMARK.md')?.content.slice(0, 4_000);
  return runGenerationStep(ctx, {
    stepKey: 'design',
    buildPrompt: (lastError) => designPrompt(spec.content, benchmark) + (lastError ? `\n\nATTENTION, tentative précédente invalide: ${lastError}` : ''),
    jsonSchema: DESIGN_JSON_SCHEMA,
    zodSchema: DesignOutputZ,
    semanticCheck: (d) => (d.applicable && d.mockup_html.trim().length < 500 ? 'mockup_html trop court pour une maquette de référence' : null),
    apply: async (d) => {
      if (!d.applicable) {
        ws.appendProgress(ctx.workspace, 'design: projet sans interface visuelle — maquette non applicable');
        return;
      }
      ws.writeDesignReference(ctx.workspace, { content: d.mockup_html, url: 'maquette générée automatiquement par le pipeline (étape design)' });
      if (d.design_notes_markdown.trim()) ws.writeFile(ctx.workspace, 'docs/design/NOTES.md', d.design_notes_markdown);
      await ws.commitAll(ctx.workspace, 'docs: design mockup (auto)');
      bus.emit('artifact.updated', ctx.projectId, { path: 'docs/design/mockup.html' });
    },
  });
}

export async function stepArchitecture(ctx: StepCtx): Promise<StepFlow> {
  const { ws, repos, bus } = ctx.deps;
  const spec = ws.readFile(ctx.workspace, 'docs/SPEC.md');
  if (!spec) return { status: 'failed', message: 'docs/SPEC.md introuvable' };
  // Improvement iteration on an existing architecture → update instead of redesign.
  const project = repos.projects.byId(ctx.projectId)!;
  const existingArch = (project.iteration ?? 1) > 1 ? ws.readFile(ctx.workspace, 'docs/ARCHITECTURE.md') : null;
  const existingInterfaces = existingArch ? ws.readFile(ctx.workspace, 'docs/INTERFACES.md') : null;
  // The tier decides how much machinery the architecture is allowed to introduce.
  const scope = profileFor(repos, project).scopeGuidance;
  // The architecture used to be designed blind and discover the deploy target eleven
  // steps later; knowing "VPS Debian via SSH, /srv/app" changes the stack and the config strategy.
  const access = accessBlock(repos.access.list(ctx.projectId).map(toAccessDto));
  let basePrompt =
    (existingArch
      ? archUpdatePrompt(spec.content, existingArch.content, existingInterfaces?.content, scope)
      : archPrompt(spec.content, scope)) + access;
  // Mockup handed off (e.g. Claude Design): the architecture must plan for it.
  if (ws.hasDesignReference(ctx.workspace)) {
    const mockup = ws.readFile(ctx.workspace, 'docs/design/mockup.html') ?? ws.readFile(ctx.workspace, 'docs/design/Mockup.jsx') ?? ws.readFile(ctx.workspace, 'docs/design/NOTES.md');
    if (mockup) basePrompt += designExcerptBlock(mockup.content.slice(0, 12_000));
  }
  return runGenerationStep(ctx, {
    stepKey: 'architecture',
    buildPrompt: (lastError) => basePrompt + (lastError ? `\n\nATTENTION, tentative précédente invalide: ${lastError}` : ''),
    jsonSchema: ARCH_JSON_SCHEMA,
    zodSchema: ArchOutputZ,
    semanticCheck: (d) => (d.stack.test_cmd.trim() ? null : 'stack.test_cmd est obligatoire'),
    apply: async (d) => {
      ctx.setStack(d.stack);
      repos.projects.patch(ctx.projectId, { stack: JSON.stringify(d.stack) });
      const md = `${d.architecture_markdown}\n\n## Stack\n\`\`\`json\n${JSON.stringify(d.stack, null, 2)}\n\`\`\`\n\n## Risques\n${d.risks.map((r) => `- ${r}`).join('\n')}\n`;
      ws.writeFile(ctx.workspace, 'docs/ARCHITECTURE.md', md);
      const interfacesMd = d.interfaces_markdown ?? '';
      if (interfacesMd.trim()) ws.writeFile(ctx.workspace, 'docs/INTERFACES.md', interfacesMd);
      await ws.commitAll(ctx.workspace, 'docs: architecture');
      bus.emit('artifact.updated', ctx.projectId, { path: 'docs/ARCHITECTURE.md' });
    },
  });
}

/**
 * Rejects duplicates, unknown dependencies and cycles — but NOT a dependency listed later.
 * Requiring "earlier in the list" forced every breakdown to be linearisable in the given
 * order, so the graph could never express parallel branches. Acyclicity is the only
 * ordering property that actually matters.
 */
export function checkTaskDag(tasks: { task_key: string; depends_on: string[]; after?: string[]; phase?: string }[]): string | null {
  const keys = new Set(tasks.map((t) => t.task_key));
  if (keys.size !== tasks.length) return 'clés de tâches dupliquées';

  // Both edge kinds are validated and both count towards acyclicity: an ordering
  // relation that loops back would deadlock the scheduler just as surely as a contract one.
  const edgesOf = (t: (typeof tasks)[number]) => [...new Set([...t.depends_on, ...(t.after ?? [])])];
  const byKey = new Map(tasks.map((t) => [t.task_key, t]));

  for (const t of tasks) {
    for (const dep of edgesOf(t)) {
      if (dep === t.task_key) return `tâche dépendante d'elle-même: ${t.task_key}`;
      if (!keys.has(dep)) return `dépendance inconnue: ${t.task_key} → ${dep}`;
    }
    // An earlier phase may never wait on a later one: the phase barrier would deadlock it.
    for (const dep of edgesOf(t)) {
      if (phaseRank(byKey.get(dep)!.phase) > phaseRank(t.phase)) {
        return `relation contraire aux phases: ${t.task_key} (${t.phase ?? DEFAULT_TASK_PHASE}) dépend de ${dep} (${byKey.get(dep)!.phase})`;
      }
    }
  }

  // Kahn: if anything remains un-emitted, a cycle remains.
  const indegree = new Map(tasks.map((t) => [t.task_key, edgesOf(t).length]));
  const queue = tasks.filter((t) => indegree.get(t.task_key) === 0).map((t) => t.task_key);
  let emitted = 0;
  while (queue.length) {
    const key = queue.shift()!;
    emitted += 1;
    for (const t of tasks) {
      if (!edgesOf(t).includes(key)) continue;
      const d = indegree.get(t.task_key)! - 1;
      indegree.set(t.task_key, d);
      if (d === 0) queue.push(t.task_key);
    }
  }
  return emitted === tasks.length ? null : 'cycle de dépendances entre tâches';
}

export function writeTasksJson(deps: CoreDeps, projectId: string, workspace: string): void {
  const tasks = deps.repos.tasks.list(projectId).map(toTaskDto);
  deps.ws.writeFile(workspace, 'docs/tasks.json', JSON.stringify({ tasks }, null, 2));
}

export function nextTaskNumber(existingKeys: string[]): number {
  let max = 0;
  for (const k of existingKeys) {
    const m = k.match(/^T(\d+)$/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max > 0 ? max + 1 : existingKeys.length + 1;
}

/** Append-mode DAG check: deps may target existing (done) tasks or previous new tasks. */
function checkTaskDagAppend(
  tasks: { task_key: string; depends_on: string[]; after?: string[] }[],
  existingKeys: Set<string>
): string | null {
  const newKeys = new Set(tasks.map((t) => t.task_key));
  if (newKeys.size !== tasks.length) return 'clés de tâches dupliquées';
  const seen = new Set<string>();
  for (const t of tasks) {
    // Ordering relations may target existing (already done) tasks too.
    for (const dep of [...t.depends_on, ...(t.after ?? [])]) {
      if (!existingKeys.has(dep) && !seen.has(dep)) return `dépendance invalide: ${t.task_key} → ${dep}`;
    }
    seen.add(t.task_key);
  }
  return null;
}

export async function stepTaskBreakdown(ctx: StepCtx): Promise<StepFlow> {
  const { ws, repos, bus } = ctx.deps;
  const spec = ws.readFile(ctx.workspace, 'docs/SPEC.md');
  const arch = ws.readFile(ctx.workspace, 'docs/ARCHITECTURE.md');
  if (!spec || !arch) return { status: 'failed', message: 'SPEC.md ou ARCHITECTURE.md introuvable' };

  const existing = repos.tasks.list(ctx.projectId);
  // Revision mode also for imported repos (iteration > 1 without any pj-gen task):
  // the delta from the "## Révision" section must NOT re-decompose the whole product.
  const isRevision = existing.length > 0 || ((repos.projects.byId(ctx.projectId)?.iteration ?? 1) > 1);
  const existingKeys = new Set(existing.map((t) => t.task_key));
  const startNum = nextTaskNumber([...existingKeys]);
  const existingSummary = existing.map((t) => `${t.task_key} [${t.status}] ${t.title}`).join('\n');

  const finish = async () => {
    // Reported, never rejected: pickBatch already protects execution, and a genuinely
    // linear product is legitimate — failing the step over it would be worse.
    const dtos = repos.tasks.list(ctx.projectId).map(toTaskDto);
    const overlaps = overlappingPairs(dtos);
    if (overlaps.length) {
      ws.appendProgress(
        ctx.workspace,
        `découpage: ${overlaps.length} paire(s) parallélisables aux écritures qui se recouvrent (${overlaps
          .slice(0, 5)
          .map(([a, b]) => `${a}/${b}`)
          .join(', ')}) — elles seront sérialisées`
      );
    } else if (dtos.length >= 6 && dagWidth(dtos) === 1) {
      ws.appendProgress(ctx.workspace, 'découpage strictement linéaire — aucune parallélisation possible');
    }
    writeTasksJson(ctx.deps, ctx.projectId, ctx.workspace);
    await ws.commitAll(ctx.workspace, isRevision ? 'docs: revision task breakdown' : 'docs: task breakdown');
    bus.emit('artifact.updated', ctx.projectId, { path: 'docs/tasks.json' });
    const row = repos.projects.byId(ctx.projectId)!;
    bus.emit('project.updated', ctx.projectId, { project: repos.projects.summary(row) });
  };

  // Task budget and scope discipline both come from the size tier: a small project that
  // gets 20 tasks is a small project that takes all night.
  const profile = profileFor(repos, repos.projects.byId(ctx.projectId));

  return runGenerationStep(ctx, {
    stepKey: 'task_breakdown',
    buildPrompt: (lastError) =>
      (isRevision
        ? breakdownRevisionPrompt(spec.content, existingSummary, `T${String(startNum).padStart(2, '0')}`, profile.maxTasksRevision, profile.scopeGuidance)
        : breakdownPrompt(spec.content, arch.content, profile.minTasks, profile.maxTasks, profile.scopeGuidance)) +
      (lastError ? `\n\nATTENTION, tentative précédente invalide: ${lastError}` : ''),
    jsonSchema: BREAKDOWN_JSON_SCHEMA,
    zodSchema: BreakdownOutputZ,
    semanticCheck: (d) => (isRevision ? checkTaskDagAppend(d.tasks, existingKeys) : checkTaskDag(d.tasks)),
    apply: async (d) => {
      if (isRevision) {
        // Deterministic renumbering from T<startNum>: collisions with existing keys become impossible,
        // and depends_on refs pointing at the NEW tasks are remapped alongside.
        const mapping = new Map(d.tasks.map((t, i) => [t.task_key, `T${String(startNum + i).padStart(2, '0')}`]));
        repos.tasks.append(
          ctx.projectId,
          d.tasks.map((t) => ({
            taskKey: mapping.get(t.task_key)!,
            title: t.title,
            description: t.description,
            filesHint: t.files_hint,
            writes: t.writes ?? [],
            acceptance: t.acceptance,
            dependsOn: t.depends_on.map((dep) => mapping.get(dep) ?? dep),
            after: (t.after ?? []).map((dep) => mapping.get(dep) ?? dep),
            phase: t.phase ?? DEFAULT_TASK_PHASE,
          }))
        );
      } else {
        repos.tasks.replaceAll(
          ctx.projectId,
          d.tasks.map((t, i) => ({
            taskKey: t.task_key,
            position: i,
            title: t.title,
            description: t.description,
            filesHint: t.files_hint,
            writes: t.writes ?? [],
            acceptance: t.acceptance,
            dependsOn: t.depends_on,
            after: t.after ?? [],
            phase: t.phase ?? DEFAULT_TASK_PHASE,
          }))
        );
      }
      await finish();
    },
  });
}

export async function stepScaffold(ctx: StepCtx): Promise<StepFlow> {
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue (architecture manquante)' };
  // Improvement iterations: the workspace is already scaffolded — skip.
  if (ctx.deps.repos.stepRuns.hasSucceeded(ctx.projectId, 'scaffold')) return { status: 'ok' };
  return runToolStep(ctx, {
    stepKey: 'scaffold',
    buildPrompt: (attempt, tail) =>
      scaffoldPrompt(stack) + (tail ? `\n\nATTENTION — tentative précédente en échec. Dernières lignes:\n\`\`\`\n${tail}\n\`\`\`` : ''),
    verifyKinds: ['install', 'build', 'test'],
    requireNewCommit: true,
    maxAttempts: 2,
  });
}

/**
 * Topological order (Kahn) over BOTH edge kinds, phase first then position as tie-break;
 * falls back to phase+position order on cycle.
 */
export function topoOrder(tasks: TaskDto[]): TaskDto[] {
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));
  // Phase then position: a polish task never sorts ahead of core work of equal indegree.
  const rank = (a: TaskDto, b: TaskDto) => phaseRank(a.phase) - phaseRank(b.phase) || a.position - b.position;
  const edges = new Map(tasks.map((t) => [t.taskKey, blockingEdges(t).filter((d) => byKey.has(d))]));

  const indegree = new Map<string, number>();
  for (const t of tasks) indegree.set(t.taskKey, edges.get(t.taskKey)!.length);
  const ready = tasks.filter((t) => indegree.get(t.taskKey) === 0).sort(rank);
  const out: TaskDto[] = [];
  while (ready.length) {
    const t = ready.shift()!;
    out.push(t);
    for (const other of tasks) {
      if (edges.get(other.taskKey)!.includes(t.taskKey)) {
        const d = indegree.get(other.taskKey)! - 1;
        indegree.set(other.taskKey, d);
        if (d === 0) {
          ready.push(other);
          ready.sort(rank);
        }
      }
    }
  }
  return out.length === tasks.length ? out : [...tasks].sort(rank);
}

/** Outcome of one task inside a parallel batch. `requeued` = must be retried serially. */
type TaskOutcome = StepFlow | { status: 'requeued' };

/**
 * A requeued task is retried at most this many times before the step gives up on it.
 * Without a bound, a task that can never be merged is silently skipped forever while the
 * loop keeps progressing on the others — the build looks healthy and ships without it.
 */
const MAX_REQUEUES = 2;

export async function stepImplementTasks(ctx: StepCtx): Promise<StepFlow> {
  const { repos, ws, bus, config, pool } = ctx.deps;
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  if (!repos.tasks.list(ctx.projectId).length) return { status: 'failed', message: 'aucune tâche définie' };
  // Frozen interface contracts, injected instead of letting each task re-read the sources.
  const interfacesExcerpt = ws.readFile(ctx.workspace, 'docs/INTERFACES.md')?.content.slice(0, 8_000);

  // Tasks whose worktree run failed for a reason a retry in a batch cannot fix (no
  // worktree available, merge refused, post-merge regression). They are re-run in the
  // MAIN workspace, which always works — this is the serial fallback that was only
  // claimed in a log line before, never actually performed.
  const serialOnly = new Set<string>();
  const requeues = new Map<string, number>();

  // Re-read the list on every iteration: a live micro-modification may append a
  // task while this loop is running — it must be picked up by the current build.
  for (;;) {
    const all = repos.tasks.list(ctx.projectId).map(toTaskDto);
    const ordered = topoOrder(all);
    const task = ordered.find((t) => t.status !== 'done');
    if (!task) break;
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    const ready = readySet(ordered);

    // A task the worktree path could not land goes through the main workspace, alone,
    // BEFORE any new batch is formed. Retrying it inside a batch would reproduce the
    // exact same failure indefinitely.
    const forced = ready.find((t) => serialOnly.has(t.taskKey));
    if (forced) {
      serialOnly.delete(forced.taskKey);
      ws.appendProgress(ctx.workspace, `${forced.taskKey} repris en série dans le workspace principal`);
      const outcome = await runOneTask(ctx, forced, stack, interfacesExcerpt);
      if (outcome.status === 'requeued') {
        if (!countRequeue(ctx, requeues, forced)) {
          return { status: 'failed', message: `tâche ${forced.taskKey}: impossible à intégrer après ${MAX_REQUEUES} reprises` };
        }
        continue;
      }
      if (outcome.status !== 'ok') return outcome;
      continue;
    }

    // Width comes from the size tier capped by the global setting, and is then limited
    // by what the session pool can actually lend right now (tryAcquire never blocks).
    const width = parallelWidth(ctx);
    const extras = width > 1 ? pool.tryAcquire(Math.min(width, ready.length) - 1) : [];
    const batch = pickBatch(ready, 1 + extras.length);
    // Hand back the leases the batch did not end up using.
    releaseAll(extras.slice(Math.max(0, batch.length - 1)));

    if (batch.length > 1) {
      const flow = await runBatch(ctx, batch, stack, interfacesExcerpt, serialOnly, requeues);
      releaseAll(extras);
      if (flow.status !== 'ok') return flow;
      continue;
    }
    releaseAll(extras);

    const solo = batch[0] ?? task;
    const outcome = await runOneTask(ctx, solo, stack, interfacesExcerpt);
    if (outcome.status === 'requeued') {
      if (!countRequeue(ctx, requeues, solo)) {
        return { status: 'failed', message: `tâche ${solo.taskKey}: impossible à intégrer après ${MAX_REQUEUES} reprises` };
      }
      continue;
    }
    if (outcome.status !== 'ok') return outcome;
  }
  repos.projects.patch(ctx.projectId, { current_task_key: null });
  return { status: 'ok' };
}

/**
 * Counts a requeue and returns false once the task has burnt its budget — at which point
 * the step must fail loudly rather than skip the task and ship a product missing a feature.
 */
function countRequeue(ctx: StepCtx, requeues: Map<string, number>, task: TaskDto): boolean {
  const n = (requeues.get(task.taskKey) ?? 0) + 1;
  requeues.set(task.taskKey, n);
  if (n <= MAX_REQUEUES) return true;
  const failed = ctx.deps.repos.tasks.setStatus(ctx.projectId, task.taskKey, 'failed');
  ctx.deps.bus.emit('task.updated', ctx.projectId, { task: toTaskDto(failed) });
  ctx.deps.ws.appendProgress(ctx.workspace, `${task.taskKey} abandonnée après ${MAX_REQUEUES} reprises infructueuses`);
  return false;
}

/** Batch width for this project: size tier, capped by the global setting. */
function parallelWidth(ctx: StepCtx): number {
  const { repos } = ctx.deps;
  const settings = repos.settings.getAll();
  const profile = profileFor(repos, repos.projects.byId(ctx.projectId));
  return Math.max(1, Math.min(profile.taskParallelism, settings.taskParallelism));
}

function markInProgress(ctx: StepCtx, task: TaskDto): void {
  const { repos, bus } = ctx.deps;
  const row = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'in_progress');
  bus.emit('task.updated', ctx.projectId, { task: toTaskDto(row) });
}

function emitProject(ctx: StepCtx): void {
  const { repos, bus } = ctx.deps;
  const row = repos.projects.byId(ctx.projectId);
  if (row) bus.emit('project.updated', ctx.projectId, { project: repos.projects.summary(row) });
}

/** Records a finished task and commits the orchestrator's bookkeeping in the MAIN workspace. */
async function settleDone(ctx: StepCtx, task: TaskDto, sha: string | null): Promise<void> {
  const { repos, ws, bus } = ctx.deps;
  const done = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'done', sha);
  repos.tasks.setWorktree(ctx.projectId, task.taskKey, null);
  bus.emit('task.updated', ctx.projectId, { task: toTaskDto(done) });
  writeTasksJson(ctx.deps, ctx.projectId, ctx.workspace);
  ws.appendProgress(ctx.workspace, `${task.taskKey} terminé (${task.title})`);
  await ws.commitAll(ctx.workspace, `chore: track ${task.taskKey.toLowerCase()} done`);
  emitProject(ctx);
}

/** The pre-existing serial path: one task, straight in the main workspace. */
async function runOneTask(ctx: StepCtx, task: TaskDto, stack: StackInfo, interfacesExcerpt?: string): Promise<TaskOutcome> {
  const { repos, ws, bus, config } = ctx.deps;
  repos.projects.patch(ctx.projectId, { current_task_key: task.taskKey });
  markInProgress(ctx, task);
  emitProject(ctx);

  const flow = await runToolStep(ctx, {
    stepKey: 'implement_task',
    taskKey: task.taskKey,
    buildPrompt: (attempt, tail) => implementTaskPrompt(task, stack, tail, interfacesExcerpt),
    verifyKinds: ['test'],
    requireNewCommit: true,
    maxAttempts: 3,
  });

  if (flow.status !== 'ok') {
    if (flow.status === 'failed') {
      const failed = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'failed');
      bus.emit('task.updated', ctx.projectId, { task: toTaskDto(failed) });
      return { status: 'failed', message: `tâche ${task.taskKey}: ${flow.message}` };
    }
    return flow;
  }

  await settleDone(ctx, task, config.fakeCli ? null : await ws.headSha(ctx.workspace));
  return { status: 'ok' };
}

/**
 * Runs a batch of write-disjoint tasks concurrently, each in its own git worktree,
 * merging every success into main as soon as it lands.
 *
 * `allSettled` semantics on purpose: one task hitting the usage limit must not discard
 * the work of its siblings. Nothing is force-aborted — a sibling will park on its own and
 * its `paused_limit` step_run is what the resume path looks for.
 */
async function runBatch(
  ctx: StepCtx,
  batch: TaskDto[],
  stack: StackInfo,
  interfacesExcerpt: string | undefined,
  serialOnly: Set<string>,
  requeues: Map<string, number>
): Promise<StepFlow> {
  const { repos, ws, bus } = ctx.deps;
  const slug = repos.projects.byId(ctx.projectId)!.slug;

  repos.projects.patch(ctx.projectId, { current_task_key: batch[0].taskKey });
  for (const t of batch) markInProgress(ctx, t);
  emitProject(ctx);
  ws.appendProgress(ctx.workspace, `lot parallèle: ${batch.map((t) => t.taskKey).join(', ')}`);
  // COMMIT IT: an uncommitted docs/PROGRESS.md leaves the main workspace dirty, and
  // `git merge` refuses to run on a dirty tree. That is what turned the first integration
  // into a bogus "conflit de fusion" and started the silent-skip chain.
  await ws.commitAll(ctx.workspace, `chore: start batch ${batch.map((t) => t.taskKey.toLowerCase()).join(' ')}`);

  const results = await Promise.all(batch.map((task) => runInWorktree(ctx, task, slug, stack, interfacesExcerpt, serialOnly)));

  // Precedence: a halt beats a park beats a failure — the most restrictive wins.
  const halted = results.find((r) => r.status === 'halted');
  if (halted) return halted as StepFlow;
  const parked = results.find((r) => r.status === 'parked');
  if (parked) return parked as StepFlow;
  const failed = results.find((r) => r.status === 'failed');
  if (failed) {
    const idx = results.indexOf(failed);
    const row = repos.tasks.setStatus(ctx.projectId, batch[idx].taskKey, 'failed');
    bus.emit('task.updated', ctx.projectId, { task: toTaskDto(row) });
    return failed as StepFlow;
  }
  // Requeued tasks are counted here so a task that can never land eventually fails the
  // step instead of being skipped forever.
  for (const [i, r] of results.entries()) {
    if (r.status === 'requeued' && !countRequeue(ctx, requeues, batch[i])) {
      return { status: 'failed', message: `tâche ${batch[i].taskKey}: impossible à intégrer après ${MAX_REQUEUES} reprises` };
    }
  }
  return { status: 'ok' };
}

/**
 * One task of a batch: implement in an isolated worktree, then merge into main under the
 * project mutex (merges must be strictly serialised — they all write the same HEAD).
 */
async function runInWorktree(
  ctx: StepCtx,
  task: TaskDto,
  slug: string,
  stack: StackInfo,
  interfacesExcerpt: string | undefined,
  serialOnly: Set<string>
): Promise<TaskOutcome> {
  const { repos, ws, bus, config, mutex, wt } = ctx.deps;

  /** Hands the task back to the main workspace — the only path guaranteed to work. */
  const requeueSerially = (reason: string): TaskOutcome => {
    ws.appendProgress(ctx.workspace, `${task.taskKey}: ${reason}`);
    serialOnly.add(task.taskKey);
    repos.tasks.setWorktree(ctx.projectId, task.taskKey, null);
    const row = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'pending');
    bus.emit('task.updated', ctx.projectId, { task: toTaskDto(row) });
    return { status: 'requeued' };
  };

  let dir: string;
  try {
    dir = await wt.ensure(ctx.workspace, slug, task.taskKey);
  } catch (err) {
    // Worktree creation is infrastructure, not the model's fault.
    return requeueSerially(`arbre de travail indisponible (${(err as Error).message.slice(0, 200)}) — reprise en série`);
  }
  repos.tasks.setWorktree(ctx.projectId, task.taskKey, dir);

  const flow = await runToolStep(ctx, {
    stepKey: 'implement_task',
    taskKey: task.taskKey,
    workRoot: dir,
    buildPrompt: (attempt, tail) => implementTaskPrompt(task, stack, tail, interfacesExcerpt) + WORKTREE_RULES,
    verifyKinds: ['test'],
    requireNewCommit: true,
    maxAttempts: 3,
  });

  // Park/halt: keep the worktree AND the branch so the resume reattaches to the same tree.
  if (flow.status === 'parked' || flow.status === 'halted') return flow;
  if (flow.status === 'failed') return { status: 'failed', message: `tâche ${task.taskKey}: ${flow.message}` };

  return mutex.run(`merge:${ctx.projectId}`, async () => {
    const before = await ws.headSha(ctx.workspace);
    const merged = await wt.merge(ctx.workspace, task.taskKey, task.title);
    if (merged.outcome === 'conflict' || merged.outcome === 'error') {
      // Distinguished on purpose: a content conflict is expected occasionally, any other
      // git failure means the orchestrator left the workspace in a state it should not have.
      const reason =
        merged.outcome === 'conflict'
          ? `conflit de fusion — reprise en série sur main à jour`
          : `fusion impossible (${merged.detail}) — reprise en série sur main à jour`;
      await wt.remove(ctx.workspace, slug, task.taskKey);
      return requeueSerially(reason);
    }

    // Two branches can merge cleanly and still break together: verify the merged tree.
    const v = await verifyStack(config, ctx.workspace, stack, ['test']);
    if (!v.ok) {
      if (before) await ws.resetHard(ctx.workspace, before);
      await wt.remove(ctx.workspace, slug, task.taskKey);
      return requeueSerially('régression après fusion — retour en arrière et reprise en série');
    }

    await settleDone(ctx, task, config.fakeCli ? null : await ws.headSha(ctx.workspace));
    await wt.remove(ctx.workspace, slug, task.taskKey);
    return { status: 'ok' };
  });
}

export async function stepPolish(ctx: StepCtx): Promise<StepFlow> {
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  const designNote = ctx.deps.ws.hasDesignReference(ctx.workspace) ? `\n\n${DESIGN_NOTE_TOOL}` : '';
  const flow = await runToolStep(ctx, {
    stepKey: 'polish',
    buildPrompt: (attempt, tail) => polishPrompt(stack) + designNote + (tail ? `\n\nATTENTION — échec précédent:\n\`\`\`\n${tail}\n\`\`\`` : ''),
    verifyKinds: ['test', 'build'],
    requireNewCommit: false,
    maxAttempts: 3,
  });
  // Cosmetic pass: NON-BLOCKING. A polish failure must never sink the whole build —
  // feature_check remains the SPEC/UX conformity gate (post-mortem Red Cactus).
  if (flow.status === 'failed') {
    ctx.deps.ws.appendProgress(ctx.workspace, `polish incomplet (non bloquant): ${flow.message.slice(0, 300)}`);
    return { status: 'ok' };
  }
  return flow;
}

/**
 * Conformity gate: audit the REAL product against the SPEC's features (end-to-end wiring,
 * actual rendering), then run bounded fix sessions on gaps and re-audit.
 */
export async function stepFeatureCheck(ctx: StepCtx): Promise<StepFlow> {
  const { ws, bus } = ctx.deps;
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  const project = ctx.deps.repos.projects.byId(ctx.projectId);
  const rounds = profileFor(ctx.deps.repos, project).featureFixRounds;

  for (let round = 0; round <= rounds; round++) {
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    // --- audit: fresh session with tools (reads the codebase) + structured verdict
    let audit: FeatureAudit | null = null;
    const { result } = await executeClaudeRun(ctx.deps, {
      projectId: ctx.projectId,
      stepKey: 'feature_check',
      taskKey: 'audit',
      attempt: round + 1,
      isLastAttempt: round === rounds,
      session: { id: newSessionId(), resume: false, kind: 'step' },
      signal: ctx.signal,
      spec: {
        ...baseSpec(ctx, 'feature_check'),
        appendSystemPrompt: commonSystemPrompt(capsFor(ctx.deps.repos, 'feature_check', project)),
        prompt: featureAuditPrompt(ws.hasDesignReference(ctx.workspace)),
        tools: 'default',
        jsonSchema: FEATURE_AUDIT_JSON_SCHEMA,
      },
      validate: async (r) => {
        const parsed = extractStructured(FeatureAuditZ, r.structured, r.resultText);
        if (!parsed.ok) return { ok: false, kind: 'schema_invalid', message: `audit invalide: ${parsed.error}` };
        audit = parsed.data;
        return { ok: true };
      },
    });

    if (result.outcome !== 'success' || !audit) {
      const f = result.failure!;
      if (f.kind === 'usage_limit') return { status: 'parked' };
      if (f.kind === 'canceled') return { status: 'halted', mode: haltMode(ctx.signal) };
      if (f.kind === 'auth') return { status: 'failed', message: f.message };
      if (round === rounds) return { status: 'failed', message: `audit des fonctionnalités impossible: ${f.message}` };
      continue; // retry the audit on the next round
    }

    const verdict: FeatureAudit = audit;
    const gaps = verdict.features.filter((f) => f.status !== 'ok');

    const md = [
      `# Audit de conformité — passe ${round + 1}`,
      '',
      '| Fonctionnalité | Statut | Constat |',
      '|---|---|---|',
      ...verdict.features.map((f) => `| ${f.key} — ${f.title} | ${f.status} | ${f.evidence.replace(/\n/g, ' ').slice(0, 200)} |`),
      '',
    ].join('\n');
    ws.writeFile(ctx.workspace, 'docs/FEATURE_AUDIT.md', md);
    await ws.commitAll(ctx.workspace, `docs: feature audit pass ${round + 1}`);
    bus.emit('artifact.updated', ctx.projectId, { path: 'docs/FEATURE_AUDIT.md' });

    if (!gaps.length) return { status: 'ok' };

    if (round === rounds) {
      const missing = gaps.filter((g) => g.status === 'missing');
      if (missing.length) {
        return {
          status: 'failed',
          message: `fonctionnalités toujours absentes après ${rounds} corrections: ${missing.map((m) => m.key).join(', ')} (voir docs/FEATURE_AUDIT.md)`,
        };
      }
      ws.appendProgress(ctx.workspace, `audit: éléments partiels restants (${gaps.map((g) => g.key).join(', ')}) — voir docs/FEATURE_AUDIT.md`);
      return { status: 'ok' };
    }

    // --- bounded fix session on the reported gaps
    const fix = await runToolStep(ctx, {
      stepKey: 'feature_check',
      taskKey: `fix-${round + 1}`,
      buildPrompt: (attempt, tail) => featureFixPrompt(gaps, stack, tail),
      verifyKinds: ['test', 'build'],
      requireNewCommit: false,
      maxAttempts: 1,
    });
    if (fix.status === 'parked' || fix.status === 'halted') return fix;
    // even if the fix session failed, the next audit decides
  }
  return { status: 'failed', message: 'audit des fonctionnalités non conclusif' };
}

export async function stepTestHardening(ctx: StepCtx): Promise<StepFlow> {
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  return runToolStep(ctx, {
    stepKey: 'test_hardening',
    buildPrompt: (attempt, tail) =>
      testHardeningPrompt(stack) + (tail ? `\n\nATTENTION — échec précédent:\n\`\`\`\n${tail}\n\`\`\`` : ''),
    verifyKinds: ['test'],
    requireNewCommit: false,
    maxAttempts: 2,
  });
}

export async function stepReviewFix(ctx: StepCtx): Promise<StepFlow> {
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  return runToolStep(ctx, {
    stepKey: 'review_fix',
    buildPrompt: (attempt, tail) => reviewFixPrompt(stack) + (tail ? `\n\nATTENTION — échec précédent:\n\`\`\`\n${tail}\n\`\`\`` : ''),
    verifyKinds: ['test', 'build'],
    requireNewCommit: false,
    maxAttempts: 2,
  });
}

export async function stepDocs(ctx: StepCtx): Promise<StepFlow> {
  const { ws, config } = ctx.deps;
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  const flow = await runToolStep(ctx, {
    stepKey: 'docs',
    // DEPLOY.md documents the declared inventory instead of inventing its own open questions.
    buildPrompt: (attempt, tail) =>
      docsPrompt(stack) +
      accessBlock(ctx.deps.repos.access.list(ctx.projectId).map(toAccessDto)) +
      (tail ? `\n\nATTENTION — échec précédent: ${tail}` : ''),
    verifyKinds: [],
    requireNewCommit: false,
    maxAttempts: 2,
  });
  if (flow.status !== 'ok' || config.fakeCli) return flow;
  const readme = ws.readFile(ctx.workspace, 'README.md');
  const deploy = ws.readFile(ctx.workspace, 'docs/DEPLOY.md');
  if (!readme || readme.content.length < 200 || !deploy || deploy.content.length < 100) {
    return { status: 'failed', message: 'README.md ou docs/DEPLOY.md manquant/trop court après l’étape docs' };
  }
  ctx.deps.bus.emit('artifact.updated', ctx.projectId, { path: 'README.md' });
  return flow;
}

export async function stepFinalVerify(ctx: StepCtx): Promise<StepFlow> {
  const { config, ws } = ctx.deps;
  const stack = ctx.getStack();

  // A fix session may have edited a manifest: the second pass must not trust the install memo.
  const check = async (forceInstall = false): Promise<string | null> => {
    const v = await verifyStack(config, ctx.workspace, stack, ['install', 'build', 'test'], { forceInstall });
    if (!v.ok) return `${v.label}\n${v.tail}`.slice(-1800);
    if (!config.fakeCli) {
      const audit = await auditCommits(ctx.workspace);
      if (!audit.ok) {
        return `audit d'attribution en échec: ${audit.issues
          .filter((i) => i.level === 'error')
          .map((i) => `${i.sha.slice(0, 8)}: ${i.reason}`)
          .join('; ')}`;
      }
    }
    return null;
  };

  let problem = await check();
  if (problem && stack) {
    const fix = await runToolStep(ctx, {
      stepKey: 'final_verify',
      buildPrompt: () => fixVerifyPrompt(problem!, stack),
      verifyKinds: [],
      requireNewCommit: false,
      maxAttempts: 1,
    });
    if (fix.status === 'parked' || fix.status === 'halted') return fix;
    problem = await check(true);
  }
  if (problem) return { status: 'failed', message: `vérification finale: ${problem}` };
  ws.appendProgress(ctx.workspace, 'vérification finale OK — prêt à déployer');
  await ws.commitAll(ctx.workspace, 'chore: final verification passed');
  return { status: 'ok' };
}
