import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { CoreDeps } from '../core/deps.js';
import { ProjectStateMachine } from '../core/stateMachine.js';
import { DEFAULT_PROJECT_SIZE, REOPENABLE_STATUSES } from '@pjgen/shared';
import { profileFor } from '../pipeline/sizing.js';
import { SPEC_JSON_SCHEMA, SpecOutputZ, extractStructured } from '../prompts/schemas.js';
import { specPrompt, specRevisionPrompt, DESIGN_NOTE_SPEC } from '../prompts/steps.js';
import { accessMarkdown } from '../prompts/access.js';
import { toAccessDto, toMessageDto } from '../db/repos/index.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { recordUsage } from '../core/usageTracker.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { badRequest, conflict } from '../core/httpError.js';
import type { ChatService } from './chatService.js';

const TRANSCRIPT_MAX_MESSAGES = 80;
const TRANSCRIPT_MAX_CHARS = 60_000;

export class SpecService {
  private sm: ProjectStateMachine;
  /** Projects with a SPEC generation running or queued — one at a time, extra clicks are no-ops. */
  private inFlight = new Set<string>();

  constructor(
    private deps: CoreDeps,
    private chat: ChatService
  ) {
    this.sm = new ProjectStateMachine(deps.repos.projects);
  }

  isGenerating(projectId: string): boolean {
    return this.inFlight.has(projectId);
  }

  private buildTranscript(projectId: string, sinceMs: number | null = null): string {
    const rows = this.deps.repos.messages
      .listByKind(projectId, 'cadrage', TRANSCRIPT_MAX_MESSAGES)
      .filter((m) => m.role !== 'system')
      .filter((m) => sinceMs === null || m.created_at >= sinceMs);
    const parts: string[] = [];
    let total = 0;
    for (const m of rows.reverse()) {
      const line = `${m.role === 'user' ? 'UTILISATEUR' : 'ASSISTANT'}: ${m.content}`;
      total += line.length;
      if (total > TRANSCRIPT_MAX_CHARS) break;
      parts.push(line);
    }
    return parts.reverse().join('\n\n');
  }

  /**
   * Fresh single-turn generation session; the orchestrator writes docs/SPEC.md itself (zero tool tokens).
   * Guarded: a second call while one is running/queued is a silent no-op (spam-proof).
   */
  async generateSpec(projectId: string): Promise<void> {
    if (this.inFlight.has(projectId)) return;
    this.inFlight.add(projectId);
    try {
      this.deps.bus.emit('spec.status', projectId, { phase: 'started' });
      await this.generateSpecInner(projectId);
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  private async generateSpecInner(projectId: string): Promise<void> {
    const { repos, mutex, runner, ws, bus } = this.deps;
    let phase: 'done' | 'failed' = 'failed';
    await mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) return;
      if (project.status !== 'draft' && project.status !== 'spec_ready') return;
      if (this.chat.quotaBlocked(projectId, 'cadrage')) return;
      this.chat.systemMessage(projectId, 'cadrage', '⏳ Génération de la SPEC en cours (30–90 s selon le modèle)…');

      const sessionId = randomUUID();
      repos.sessions.insert(sessionId, projectId, 'cadrage');
      const { model, fallbackModel } = resolveModel(repos, project, 'spec');
      const caps = capsFor(repos, 'spec', project);
      const settings = repos.settings.getAll();
      // A tier already pinned (by the operator or by cadrage) is imposed on the SPEC;
      // otherwise the SPEC session decides it and we record what it chose.
      const profile = profileFor(repos, project);

      // Improvement iteration: revise the existing SPEC from the post-reopen conversation only.
      const isRevision = (project.iteration ?? 1) > 1;
      const currentSpec = isRevision ? ws.readFile(project.workspace_path, 'docs/SPEC.md') : null;
      let prompt =
        isRevision && currentSpec
          ? specRevisionPrompt(currentSpec.content, this.buildTranscript(projectId, project.reopened_at), project.iteration)
          : specPrompt(project.initial_prompt, this.buildTranscript(projectId), project.size, profile.scopeGuidance);
      if (ws.hasDesignReference(project.workspace_path)) prompt += `\n\n${DESIGN_NOTE_SPEC}`;

      const handle = runner({
        cwd: project.workspace_path,
        prompt,
        sessionId,
        resume: false,
        model,
        fallbackModel,
        tools: 'none',
        jsonSchema: SPEC_JSON_SCHEMA,
        appendSystemPrompt: commonSystemPrompt(),
        maxBudgetUsd: settings.maxBudgetUsdPerSession,
        maxTurns: caps.maxTurns,
        timeoutMs: caps.timeoutMs,
      });

      const result = await handle.result;
      if (result.outcome !== 'success') {
        this.chat.handleInteractiveFailure(projectId, 'cadrage', result.failure!);
        return;
      }
      repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
      if (recordUsage(repos, projectId, 'cadrage', result)) this.deps.sched.emitQuota();
      this.deps.sched.poke(); // fresh tokensInWindow → re-evaluate a reserve cut promptly
      repos.sessions.setStatus(sessionId, 'closed');
      if (repos.quota.get().limited_until) this.deps.sched.notifyQuotaCleared();

      const parsed = extractStructured(SpecOutputZ, result.structured, result.resultText);
      if (!parsed.ok) {
        this.chat.systemMessage(projectId, 'cadrage', `⚠️ Génération du SPEC invalide (${parsed.error}). Réessaie.`);
        return;
      }

      // The SPEC settles the tier unless the operator pinned one by hand.
      if (parsed.data.size && project.size_source !== 'user') {
        repos.projects.patch(projectId, { size: parsed.data.size, size_source: 'cadrage' });
      }

      if (parsed.data.access_requirements?.length) {
        repos.access.upsertFromCadrage(
          projectId,
          parsed.data.access_requirements.map((a) => ({
            key: a.key,
            kind: a.kind,
            label: a.label,
            required: a.required,
            why: a.why,
            secretEnvVars: a.env_vars,
          }))
        );
        bus.emit('access.updated', projectId, { items: repos.access.list(projectId).map(toAccessDto) });
      }

      ws.writeFile(project.workspace_path, 'docs/SPEC.md', parsed.data.spec_markdown);
      // Written by the orchestrator (zero tokens) and committed: keys and reasons only,
      // never a value. The SPEC stays untouched — it is sha256-frozen.
      ws.writeFile(project.workspace_path, 'docs/ACCESS.md', accessMarkdown(repos.access.list(projectId).map(toAccessDto)));
      await ws.commitAll(project.workspace_path, 'docs: project spec');

      if (this.sm.tryTransition(projectId, ['draft', 'spec_ready'], 'spec_ready')) {
        const updated = repos.projects.byId(projectId)!;
        bus.emit('project.updated', projectId, { project: repos.projects.summary(updated) });
        bus.emit('artifact.updated', projectId, { path: 'docs/SPEC.md' });
        this.chat.systemMessage(
          projectId,
          'cadrage',
          `📄 SPEC générée (« ${parsed.data.title} ») — consulte l'onglet Artefacts, ajuste par le chat si besoin, puis clique « Valider et lancer la construction ».`
        );
        phase = 'done';
      }
    });
    bus.emit('spec.status', projectId, { phase });
  }

  /**
   * Reopen a settled project for an improvement iteration: back to cadrage,
   * fresh sessions, cleared queue slot; then the whole normal flow applies.
   */
  async reopen(projectId: string, request: string, design?: { content?: string; url?: string }): Promise<void> {
    const { repos, mutex, bus, ws } = this.deps;
    await mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (!REOPENABLE_STATUSES.includes(project.status)) {
        throw conflict(`Réouverture impossible en statut « ${project.status} »`);
      }
      const newIteration = (project.iteration ?? 1) + 1;
      this.sm.transitionOr409(projectId, [project.status], 'draft', {
        iteration: newIteration,
        reopened_at: Date.now(),
        enqueued_at: null,
        current_step_key: null,
        current_task_key: null,
        error_message: null,
        spec_validated_at: null,
      });
      for (const kind of ['cadrage', 'deploy'] as const) {
        const s = repos.sessions.latestActive(projectId, kind);
        if (s) repos.sessions.setStatus(s.id, 'closed');
      }
      if (design && (design.content?.trim() || design.url?.trim())) {
        ws.writeDesignReference(project.workspace_path, design, newIteration);
        await ws.commitAll(project.workspace_path, `docs: design reference (iteration ${newIteration})`);
        bus.emit('artifact.updated', projectId, { path: 'docs/design/README.md' });
      }
      // Picks up a newer skill bundle on every reopen; idempotent, no-op if unchanged.
      ws.writeBundledSkills(project.workspace_path);
      await ws.commitAll(project.workspace_path, 'chore: refresh bundled skills');
      const sys = repos.messages.insert(projectId, 'cadrage', 'system', `🔄 Itération ${newIteration} ouverte — cadrage des améliorations.`);
      bus.emit('chat.message', projectId, { message: toMessageDto(sys) });
      const updated = repos.projects.byId(projectId)!;
      bus.emit('project.updated', projectId, { project: repos.projects.summary(updated) });
      bus.emit('queue.updated', null, repos.projects.queueSnapshot());
    });
    // The improvement request is the first cadrage message of the new iteration.
    void this.chat.runCadrageTurn(projectId, request);
  }

  /** Next cadrage turn fed from outside the UI (answers posted on a GitHub issue). */
  continueCadrage(projectId: string, text: string, opts: { skipUserInsert?: boolean } = {}): Promise<void> {
    return this.chat.runCadrageTurn(projectId, text, opts);
  }

  /** Freeze the spec (sha256) and enqueue the project for autonomous build. */
  async validateSpec(projectId: string): Promise<void> {
    if (this.inFlight.has(projectId)) {
      throw conflict('Génération de la SPEC en cours — attends la fin (message dans le chat) puis valide.');
    }
    const { repos, ws, bus, sched } = this.deps;
    await this.deps.mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (project.status !== 'spec_ready') throw conflict(`Le SPEC doit d'abord être généré (statut actuel: ${project.status})`);
      const spec = ws.readFile(project.workspace_path, 'docs/SPEC.md');
      if (!spec) throw badRequest('docs/SPEC.md introuvable — génère le SPEC avant de valider');

      const sha = createHash('sha256').update(spec.content).digest('hex');
      // Freeze the tier alongside the spec: from `queued` on, budgets and pipeline
      // shape must not move under a running build.
      this.sm.transitionOr409(projectId, ['spec_ready'], 'queued', {
        spec_sha256: sha,
        spec_validated_at: Date.now(),
        enqueued_at: project.enqueued_at ?? Date.now(),
        size: project.size ?? DEFAULT_PROJECT_SIZE,
        size_source: project.size_source ?? 'default',
        error_message: null,
      });
      // Warn, don't block: most accesses are only needed at DEPLOY time, and blocking an
      // unattended overnight build over a domain that isn't bought yet would defeat the
      // whole queue-it-tonight workflow. approveDeploy is the hard gate.
      const missing = repos.access.missing(projectId);
      if (missing.length) {
        this.chat.systemMessage(
          projectId,
          'cadrage',
          `⚠️ Accès requis non fournis : ${missing.map((m) => m.label).join(', ')}. La construction peut démarrer ; le déploiement les exigera.`
        );
      }

      const updated = repos.projects.byId(projectId)!;
      bus.emit('project.updated', projectId, { project: repos.projects.summary(updated) });
      bus.emit('queue.updated', null, repos.projects.queueSnapshot());
      sched.poke();
    });
  }
}
