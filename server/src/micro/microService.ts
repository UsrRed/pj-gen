import { randomUUID } from 'node:crypto';
import type { CoreDeps } from '../core/deps.js';
import { ProjectStateMachine } from '../core/stateMachine.js';
import { MICRO_JSON_SCHEMA, MicroTaskZ, extractStructured } from '../prompts/schemas.js';
import { microTaskPrompt } from '../prompts/steps.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { recordUsage } from '../core/usageTracker.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { nextTaskNumber, writeTasksJson } from '../pipeline/steps.js';
import { toMicroDto, toTaskDto, type MicroRequestRow } from '../db/repos/index.js';
import { badRequest, conflict } from '../core/httpError.js';

/** Statuses from which a live micro-modification can be requested. */
const MICRO_ALLOWED = ['deployed', 'awaiting_deploy_approval', 'building', 'failed'] as const;

const SPEC_EXCERPT_CHARS = 8_000;
const INTERFACES_EXCERPT_CHARS = 6_000;

export type MicroOutcome =
  | { status: 'appended'; taskKey: string }
  | { status: 'queued'; taskKey: string }
  | { status: 'needs_clarification'; question: string }
  | { status: 'failed'; message: string };

/**
 * Live micro-modifications: a small change request becomes ONE task (cheap
 * generation session), appended to the project and executed by the reduced
 * 'micro' pipeline (implement → verify) — no cadrage/SPEC/architecture cycle.
 */
export class MicroService {
  private sm: ProjectStateMachine;

  constructor(private deps: CoreDeps) {
    this.sm = new ProjectStateMachine(deps.repos.projects);
  }

  quotaBlocked(): boolean {
    const q = this.deps.repos.quota.get();
    return Boolean(q.limited_until && q.limited_until > Date.now()) || this.deps.repos.settings.getGlobalPaused();
  }

  async create(
    projectId: string,
    request: string,
    source: 'manual' | 'issue' = 'manual',
    issueId: number | null = null,
    attachmentPaths: string[] = []
  ): Promise<MicroOutcome> {
    const { repos, mutex, bus } = this.deps;
    if (this.quotaBlocked()) throw conflict('Quota épuisé ou pause globale — réessaie après la reprise.');

    return mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (!(MICRO_ALLOWED as readonly string[]).includes(project.status)) {
        throw conflict(`Micro-modification impossible en statut « ${project.status} »`);
      }

      const row = repos.micro.insert(projectId, source, request, issueId);
      const emitMicro = (r: MicroRequestRow) => bus.emit('micro.updated', projectId, { request: toMicroDto(r) });
      emitMicro(row);

      const gen = await this.generateTask(project.workspace_path, projectId, request, source === 'issue');
      if (!gen.ok) {
        emitMicro(repos.micro.patch(row.id, { status: 'failed', error_message: gen.message }));
        return { status: 'failed', message: gen.message } satisfies MicroOutcome;
      }
      if (!gen.data.actionable) {
        const question = gen.data.clarification_question || 'Demande trop imprécise — reformule avec le comportement attendu.';
        emitMicro(repos.micro.patch(row.id, { status: 'needs_clarification', error_message: question }));
        return { status: 'needs_clarification', question } satisfies MicroOutcome;
      }

      // Append the task (T<max+1>) + a Micro-révisions line in the SPEC (orchestrator edit, no session).
      const existingKeys = repos.tasks.list(projectId).map((t) => t.task_key);
      const taskKey = `T${String(nextTaskNumber(existingKeys)).padStart(2, '0')}`;
      // Mechanical note (not via the qualifier's output): local files are orchestrator-controlled paths.
      const attachNote = attachmentPaths.length
        ? `\n\nPièces jointes de l'issue GitHub (captures d'écran/maquettes du problème) — consulte-les avec l'outil Read avant d'implémenter :\n${attachmentPaths.map((f) => `- ${f}`).join('\n')}`
        : '';
      repos.tasks.append(projectId, [
        {
          taskKey,
          title: gen.data.title || request.slice(0, 120),
          description: gen.data.description + attachNote,
          filesHint: gen.data.files_hint,
          acceptance: gen.data.acceptance.length ? gen.data.acceptance : [request.slice(0, 300)],
          dependsOn: [],
        },
      ]);
      this.appendSpecRevision(project.workspace_path, taskKey, request);
      const task = repos.tasks.get(projectId, taskKey);
      if (task) bus.emit('task.updated', projectId, { task: toTaskDto(task) });
      emitMicro(repos.micro.patch(row.id, { status: 'task_created', task_key: taskKey }));

      const fresh = repos.projects.byId(projectId)!;
      if (fresh.status === 'building') {
        // The running implement loop re-reads the task list — no commit here (a
        // commitAll would sweep the in-flight session's WIP into an orchestrator commit).
        bus.emit('project.updated', projectId, { project: repos.projects.summary(fresh) });
        return { status: 'appended', taskKey } satisfies MicroOutcome;
      }

      writeTasksJson(this.deps, projectId, project.workspace_path);
      await this.deps.ws.commitAll(project.workspace_path, `docs: micro request ${taskKey.toLowerCase()}`);
      this.sm.transitionOr409(projectId, [...MICRO_ALLOWED], 'queued', {
        pipeline_mode: 'micro',
        enqueued_at: Date.now(),
        error_message: null,
      });
      const updated = repos.projects.byId(projectId)!;
      bus.emit('project.updated', projectId, { project: repos.projects.summary(updated) });
      bus.emit('queue.updated', null, repos.projects.queueSnapshot());
      this.deps.sched.poke();
      return { status: 'queued', taskKey } satisfies MicroOutcome;
    });
  }

  /** Cheap single-turn generation (tools: none) turning the request into one precise task. */
  private async generateTask(
    workspace: string,
    projectId: string,
    request: string,
    untrusted: boolean
  ): Promise<{ ok: true; data: import('../prompts/schemas.js').MicroTask } | { ok: false; message: string }> {
    const { repos, ws, runner } = this.deps;
    const project = repos.projects.byId(projectId)!;
    const spec = ws.readFile(workspace, 'docs/SPEC.md');
    if (!spec) return { ok: false, message: 'docs/SPEC.md introuvable' };
    const interfaces = ws.readFile(workspace, 'docs/INTERFACES.md');
    const tasksSummary = repos.tasks
      .list(projectId)
      .map((t) => `${t.task_key} [${t.status}] ${t.title}`)
      .join('\n');

    const sessionId = randomUUID();
    repos.sessions.insert(sessionId, projectId, 'micro');
    const { model, fallbackModel } = resolveModel(repos, project, 'micro');
    const caps = capsFor(repos, 'micro');
    const settings = repos.settings.getAll();

    const handle = runner({
      cwd: workspace,
      prompt: microTaskPrompt({
        request,
        specExcerpt: spec.content.slice(0, SPEC_EXCERPT_CHARS),
        interfacesExcerpt: interfaces?.content.slice(0, INTERFACES_EXCERPT_CHARS),
        tasksSummary,
        untrusted,
      }),
      sessionId,
      resume: false,
      model,
      fallbackModel,
      tools: 'none',
      jsonSchema: MICRO_JSON_SCHEMA,
      appendSystemPrompt: commonSystemPrompt(),
      maxBudgetUsd: settings.maxBudgetUsdPerSession,
      maxTurns: caps.maxTurns,
      timeoutMs: caps.timeoutMs,
    });

    const result = await handle.result;
    repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
    if (recordUsage(repos, projectId, 'micro', result)) this.deps.sched.emitQuota();
    this.deps.sched.poke();
    repos.sessions.setStatus(sessionId, 'closed');

    if (result.outcome !== 'success') {
      if (result.failure?.kind === 'usage_limit' && result.failure.resetAt) {
        this.deps.sched.notifyQuotaLimit(result.failure.resetAt, result.failure.matchedPattern ?? null);
      }
      return { ok: false, message: result.failure?.message ?? 'échec de la session micro' };
    }
    const parsed = extractStructured(MicroTaskZ, result.structured, result.resultText);
    if (!parsed.ok) return { ok: false, message: `sortie structurée invalide: ${parsed.error}` };
    return { ok: true, data: parsed.data };
  }

  /** Orchestrator edit: log the micro-change under a "## Micro-révisions" SPEC section. */
  private appendSpecRevision(workspace: string, taskKey: string, request: string): void {
    const { ws } = this.deps;
    const spec = ws.readFile(workspace, 'docs/SPEC.md');
    if (!spec) return;
    const line = `- ${taskKey} (${new Date().toISOString().slice(0, 10)}): ${request.replace(/\s+/g, ' ').slice(0, 300)}`;
    const marker = '## Micro-révisions';
    const content = spec.content.includes(marker)
      ? spec.content.replace(marker, `${marker}\n${line}`)
      : `${spec.content.trimEnd()}\n\n${marker}\n${line}\n`;
    ws.writeFile(workspace, 'docs/SPEC.md', content);
  }
}
