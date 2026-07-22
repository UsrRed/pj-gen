import type { StackInfo, StepKey, TaskDto } from '@pjgen/shared';
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
} from '../prompts/steps.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { auditCommits } from './attribution.js';
import { toTaskDto } from '../db/repos/index.js';

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

function baseSpec(ctx: StepCtx, stepKey: string) {
  const { repos } = ctx.deps;
  const project = repos.projects.byId(ctx.projectId)!;
  const { model, fallbackModel } = resolveModel(repos, project, stepKey);
  const caps = capsFor(repos, stepKey);
  const settings = repos.settings.getAll();
  return {
    cwd: ctx.workspace,
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

interface ToolOpts {
  stepKey: StepKey;
  taskKey?: string | null;
  capKey?: string;
  buildPrompt: (attempt: number, failureTail?: string) => string;
  verifyKinds: VerifyKind[];
  requireNewCommit: boolean;
  maxAttempts: number;
}

async function runToolStep(ctx: StepCtx, o: ToolOpts): Promise<StepFlow> {
  const { deps } = ctx;
  const { repos, ws, config } = deps;
  const taskKey = o.taskKey ?? null;

  // Resume a session interrupted by the usage limit (or a crash) when one exists.
  const paused = repos.stepRuns.latestPaused(ctx.projectId, o.stepKey, taskKey);
  const orphaned = repos.stepRuns.latestOrphaned(ctx.projectId, o.stepKey, taskKey);
  const resumable = [paused, orphaned].filter(Boolean).sort((a, b) => b!.id - a!.id)[0];
  let resumeSessionId = resumable?.session_id ?? null;
  let attempt = resumable?.attempt ?? 1;
  let failureTail: string | undefined;
  let lastSessionId: string | null = null;
  let lastMessage = 'échec';

  while (attempt <= o.maxAttempts) {
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    const headBefore = await ws.headSha(ctx.workspace);
    let session: ExecSession;
    let prompt: string;
    if (resumeSessionId) {
      session = { id: resumeSessionId, resume: true, kind: 'step' };
      prompt = resumePrompt();
    } else if (attempt >= 3 && lastSessionId) {
      session = { id: lastSessionId, resume: true, fork: true, kind: 'step' };
      prompt = o.buildPrompt(attempt, failureTail);
    } else {
      session = { id: newSessionId(), resume: false, kind: 'step' };
      prompt = o.buildPrompt(attempt, failureTail);
    }

    const { result } = await executeClaudeRun(deps, {
      projectId: ctx.projectId,
      stepKey: o.stepKey,
      taskKey,
      attempt,
      isLastAttempt: attempt === o.maxAttempts,
      session,
      signal: ctx.signal,
      spec: {
        ...baseSpec(ctx, o.capKey ?? o.stepKey),
        prompt,
        tools: 'default',
      },
      validate: async () => {
        if (o.requireNewCommit && !config.fakeCli) {
          const hasNew = await ws.hasNewCommitSince(ctx.workspace, headBefore);
          if (!hasNew) return { ok: false, kind: 'verify_failed', message: 'aucun nouveau commit créé par la session' };
        }
        const v = await verifyStack(config, ctx.workspace, ctx.getStack(), o.verifyKinds);
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
  let basePrompt = existingArch
    ? archUpdatePrompt(spec.content, existingArch.content, existingInterfaces?.content)
    : archPrompt(spec.content);
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

function checkTaskDag(tasks: { task_key: string; depends_on: string[] }[]): string | null {
  const keys = new Set(tasks.map((t) => t.task_key));
  if (keys.size !== tasks.length) return 'clés de tâches dupliquées';
  const seen = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!keys.has(dep)) return `dépendance inconnue: ${t.task_key} → ${dep}`;
      if (!seen.has(dep)) return `dépendance non antérieure (ordre invalide): ${t.task_key} → ${dep}`;
    }
    seen.add(t.task_key);
  }
  return null;
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
function checkTaskDagAppend(tasks: { task_key: string; depends_on: string[] }[], existingKeys: Set<string>): string | null {
  const newKeys = new Set(tasks.map((t) => t.task_key));
  if (newKeys.size !== tasks.length) return 'clés de tâches dupliquées';
  const seen = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.depends_on) {
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
    writeTasksJson(ctx.deps, ctx.projectId, ctx.workspace);
    await ws.commitAll(ctx.workspace, isRevision ? 'docs: revision task breakdown' : 'docs: task breakdown');
    bus.emit('artifact.updated', ctx.projectId, { path: 'docs/tasks.json' });
    const row = repos.projects.byId(ctx.projectId)!;
    bus.emit('project.updated', ctx.projectId, { project: repos.projects.summary(row) });
  };

  return runGenerationStep(ctx, {
    stepKey: 'task_breakdown',
    buildPrompt: (lastError) =>
      (isRevision
        ? breakdownRevisionPrompt(spec.content, existingSummary, `T${String(startNum).padStart(2, '0')}`, 15)
        : breakdownPrompt(spec.content, arch.content, 20)) + (lastError ? `\n\nATTENTION, tentative précédente invalide: ${lastError}` : ''),
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
            acceptance: t.acceptance,
            dependsOn: t.depends_on.map((dep) => mapping.get(dep) ?? dep),
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
            acceptance: t.acceptance,
            dependsOn: t.depends_on,
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

/** Topological order (Kahn), stable by position; falls back to position order on cycle. */
export function topoOrder(tasks: TaskDto[]): TaskDto[] {
  const byKey = new Map(tasks.map((t) => [t.taskKey, t]));
  const indegree = new Map<string, number>();
  for (const t of tasks) indegree.set(t.taskKey, t.dependsOn.filter((d) => byKey.has(d)).length);
  const ready = tasks.filter((t) => indegree.get(t.taskKey) === 0).sort((a, b) => a.position - b.position);
  const out: TaskDto[] = [];
  while (ready.length) {
    const t = ready.shift()!;
    out.push(t);
    for (const other of tasks) {
      if (other.dependsOn.includes(t.taskKey)) {
        const d = indegree.get(other.taskKey)! - 1;
        indegree.set(other.taskKey, d);
        if (d === 0) {
          ready.push(other);
          ready.sort((a, b) => a.position - b.position);
        }
      }
    }
  }
  return out.length === tasks.length ? out : [...tasks].sort((a, b) => a.position - b.position);
}

export async function stepImplementTasks(ctx: StepCtx): Promise<StepFlow> {
  const { repos, ws, bus, config } = ctx.deps;
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  if (!repos.tasks.list(ctx.projectId).length) return { status: 'failed', message: 'aucune tâche définie' };
  // Frozen interface contracts, injected instead of letting each task re-read the sources.
  const interfacesExcerpt = ws.readFile(ctx.workspace, 'docs/INTERFACES.md')?.content.slice(0, 8_000);

  // Re-read the list on every iteration: a live micro-modification may append a
  // task while this loop is running — it must be picked up by the current build.
  for (;;) {
    const ordered = topoOrder(repos.tasks.list(ctx.projectId).map(toTaskDto));
    const task = ordered.find((t) => t.status !== 'done');
    if (!task) break;
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    repos.projects.patch(ctx.projectId, { current_task_key: task.taskKey });
    const inProgress = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'in_progress');
    bus.emit('task.updated', ctx.projectId, { task: toTaskDto(inProgress) });
    const row = repos.projects.byId(ctx.projectId)!;
    bus.emit('project.updated', ctx.projectId, { project: repos.projects.summary(row) });

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

    const sha = config.fakeCli ? null : await ws.headSha(ctx.workspace);
    const done = repos.tasks.setStatus(ctx.projectId, task.taskKey, 'done', sha);
    bus.emit('task.updated', ctx.projectId, { task: toTaskDto(done) });
    writeTasksJson(ctx.deps, ctx.projectId, ctx.workspace);
    ws.appendProgress(ctx.workspace, `${task.taskKey} terminé (${task.title})`);
    await ws.commitAll(ctx.workspace, `chore: track ${task.taskKey.toLowerCase()} done`);
    const row2 = repos.projects.byId(ctx.projectId)!;
    bus.emit('project.updated', ctx.projectId, { project: repos.projects.summary(row2) });
  }
  repos.projects.patch(ctx.projectId, { current_task_key: null });
  return { status: 'ok' };
}

export async function stepPolish(ctx: StepCtx): Promise<StepFlow> {
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };
  const designNote = ctx.deps.ws.hasDesignReference(ctx.workspace) ? `\n\n${DESIGN_NOTE_TOOL}` : '';
  return runToolStep(ctx, {
    stepKey: 'polish',
    buildPrompt: (attempt, tail) => polishPrompt(stack) + designNote + (tail ? `\n\nATTENTION — échec précédent:\n\`\`\`\n${tail}\n\`\`\`` : ''),
    verifyKinds: ['test', 'build'],
    requireNewCommit: false,
    maxAttempts: 2,
  });
}

const FEATURE_FIX_ROUNDS = 2;

/**
 * Conformity gate: audit the REAL product against the SPEC's features (end-to-end wiring,
 * actual rendering), then run bounded fix sessions on gaps and re-audit.
 */
export async function stepFeatureCheck(ctx: StepCtx): Promise<StepFlow> {
  const { ws, bus } = ctx.deps;
  const stack = ctx.getStack();
  if (!stack) return { status: 'failed', message: 'stack inconnue' };

  for (let round = 0; round <= FEATURE_FIX_ROUNDS; round++) {
    if (ctx.signal.aborted) return { status: 'halted', mode: haltMode(ctx.signal) };

    // --- audit: fresh session with tools (reads the codebase) + structured verdict
    let audit: FeatureAudit | null = null;
    const { result } = await executeClaudeRun(ctx.deps, {
      projectId: ctx.projectId,
      stepKey: 'feature_check',
      taskKey: 'audit',
      attempt: round + 1,
      isLastAttempt: round === FEATURE_FIX_ROUNDS,
      session: { id: newSessionId(), resume: false, kind: 'step' },
      signal: ctx.signal,
      spec: {
        ...baseSpec(ctx, 'feature_check'),
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
      if (round === FEATURE_FIX_ROUNDS) return { status: 'failed', message: `audit des fonctionnalités impossible: ${f.message}` };
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

    if (round === FEATURE_FIX_ROUNDS) {
      const missing = gaps.filter((g) => g.status === 'missing');
      if (missing.length) {
        return {
          status: 'failed',
          message: `fonctionnalités toujours absentes après ${FEATURE_FIX_ROUNDS} corrections: ${missing.map((m) => m.key).join(', ')} (voir docs/FEATURE_AUDIT.md)`,
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
    buildPrompt: (attempt, tail) => docsPrompt(stack) + (tail ? `\n\nATTENTION — échec précédent: ${tail}` : ''),
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

  const check = async (): Promise<string | null> => {
    const v = await verifyStack(config, ctx.workspace, stack, ['install', 'build', 'test']);
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
    problem = await check();
  }
  if (problem) return { status: 'failed', message: `vérification finale: ${problem}` };
  ws.appendProgress(ctx.workspace, 'vérification finale OK — prêt à déployer');
  await ws.commitAll(ctx.workspace, 'chore: final verification passed');
  return { status: 'ok' };
}
