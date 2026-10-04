import { randomUUID } from 'node:crypto';
import type { CoreDeps } from '../core/deps.js';
import { toAccessDto, toMessageDto } from '../db/repos/index.js';
import type { MessageRow } from '../db/repos/index.js';
import { CADRAGE_JSON_SCHEMA, CadrageReplyZ, extractStructured } from '../prompts/schemas.js';
import { CADRAGE_SYSTEM, ISSUE_CADRAGE_NOTE, memoryBlock, revisionCadrageContext } from '../prompts/steps.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { recordUsage } from '../core/usageTracker.js';
import { memoryMcp } from '../pipeline/integrations.js';
import type { Failure } from '../claude/types.js';

const QUOTA_MARGIN_MS = 2 * 60 * 1000;

export function fmtResetTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export class ChatService {
  constructor(private deps: CoreDeps) {}

  private emitMessage(row: MessageRow): void {
    this.deps.bus.emit('chat.message', row.project_id, { message: toMessageDto(row) });
  }

  systemMessage(projectId: string, kind: 'cadrage' | 'deploy', content: string): void {
    const row = this.deps.repos.messages.insert(projectId, kind, 'system', content);
    this.emitMessage(row);
  }

  /** Shared quota gate for interactive turns. Returns true when blocked (message already posted). */
  quotaBlocked(projectId: string, kind: 'cadrage' | 'deploy'): boolean {
    const { repos } = this.deps;
    if (!repos.quota.isLimited(QUOTA_MARGIN_MS)) return false;
    const until = repos.quota.get().limited_until!;
    this.systemMessage(projectId, kind, `⏳ Quota Claude épuisé — réessayez après ${fmtResetTime(until)} (ou « Réessayer maintenant » pour sonder).`);
    return true;
  }

  handleInteractiveFailure(projectId: string, kind: 'cadrage' | 'deploy', failure: Failure): void {
    const { repos, bus, sched } = this.deps;
    if (failure.kind === 'usage_limit') {
      const resetAt = failure.resetAt ?? Date.now() + 30 * 60 * 1000;
      sched.notifyQuotaLimit(resetAt, failure.matchedPattern ?? null);
      this.systemMessage(projectId, kind, `⏳ Quota Claude épuisé pendant la réponse — réessayez après ${fmtResetTime(resetAt)}.`);
      return;
    }
    if (failure.kind === 'auth') {
      bus.emit('boot.notice', null, { level: 'error', message: `Authentification claude invalide — exécutez \`claude auth login\` sur la machine.` });
      this.systemMessage(projectId, kind, `🔒 Authentification claude invalide: ${failure.message}`);
      return;
    }
    this.systemMessage(projectId, kind, `⚠️ Échec de la réponse (${failure.kind}): ${failure.message.slice(0, 400)}`);
  }

  /** One cadrage turn = one `claude -p` invocation (resumed session). Serialized per project. */
  async runCadrageTurn(projectId: string, userText: string, opts: { skipUserInsert?: boolean } = {}): Promise<void> {
    const { repos, mutex } = this.deps;
    await mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) return;
      if (project.status !== 'draft' && project.status !== 'spec_ready') return;

      if (!opts.skipUserInsert) {
        const row = repos.messages.insert(projectId, 'cadrage', 'user', userText);
        this.emitMessage(row);
      }
      if (this.quotaBlocked(projectId, 'cadrage')) return;
      await this.executeCadrageTurn(projectId, userText, false);
    });
  }

  private async executeCadrageTurn(projectId: string, userText: string, isRetryAfterLostSession: boolean): Promise<void> {
    const { repos, config, runner } = this.deps;
    const project = repos.projects.byId(projectId)!;

    let session = repos.sessions.latestActive(projectId, 'cadrage');
    let resume = true;
    if (!session) {
      const id = randomUUID();
      repos.sessions.insert(id, projectId, 'cadrage');
      session = repos.sessions.byId(id)!;
      resume = false;
    }

    const { model, fallbackModel } = resolveModel(repos, project, 'cadrage');
    const caps = capsFor(repos, 'cadrage', project);
    const settings = repos.settings.getAll();

    // Improvement iterations: the fresh cadrage session needs the current SPEC as context.
    let revisionContext = '';
    if ((project.iteration ?? 1) > 1 && !resume) {
      const spec = this.deps.ws.readFile(project.workspace_path, 'docs/SPEC.md');
      if (spec) revisionContext = `\n\n${revisionCadrageContext(project.iteration, spec.content)}`;
    }

    // Iteration driven by a GitHub issue: the reply goes to the issue thread, not to the UI.
    // ('fixing' during a cadrage = an issue micro fix the engine just escalated.)
    const issueDriven = repos.issues.byDecision(projectId, ['escalated', 'awaiting_reply', 'fixing']).length > 0;

    // Optional persistent memory (issue #8, T11) — off by default, opt-in + operator key.
    const memory = memoryMcp(this.deps);

    const handle = runner({
      cwd: project.workspace_path,
      prompt: userText,
      sessionId: session.id,
      resume,
      model,
      fallbackModel,
      tools: memory?.tools ?? 'none',
      mcpConfig: memory?.mcpConfig,
      jsonSchema: CADRAGE_JSON_SCHEMA,
      appendSystemPrompt: `${CADRAGE_SYSTEM}\n\n${commonSystemPrompt()}${revisionContext}${issueDriven ? `\n\n${ISSUE_CADRAGE_NOTE}` : ''}${memory ? memoryBlock : ''}`,
      maxBudgetUsd: settings.maxBudgetUsdPerSession,
      maxTurns: caps.maxTurns,
      timeoutMs: caps.timeoutMs,
    });

    const result = await handle.result;
    if (result.outcome === 'success') {
      repos.sessions.bump(session.id, result.numTurns, result.costUsd, result.usage);
      if (recordUsage(repos, projectId, 'cadrage', result)) this.deps.sched.emitQuota();
      this.deps.sched.poke(); // fresh tokensInWindow → re-evaluate a reserve cut promptly
      if (repos.quota.get().limited_until) this.deps.sched.notifyQuotaCleared();
      const parsed = extractStructured(CadrageReplyZ, result.structured, result.resultText);
      const reply = parsed.ok
        ? parsed.data
        : {
            reply_markdown: result.resultText || '(réponse vide)',
            open_questions: [],
            ready_for_spec: false,
            suggested_size: '' as const,
            size_rationale: '',
            access_requirements: [],
          };
      const row = repos.messages.insert(
        projectId,
        'cadrage',
        'assistant',
        reply.reply_markdown,
        {
          open_questions: reply.open_questions,
          ready_for_spec: reply.ready_for_spec,
          suggested_size: reply.suggested_size || undefined,
          size_rationale: reply.size_rationale || undefined,
        },
        session.id
      );
      this.emitMessage(row);
      // The model restates the full inventory each turn; the repo keeps whatever the
      // operator has already answered.
      if (reply.access_requirements?.length) {
        repos.access.upsertFromCadrage(
          projectId,
          reply.access_requirements.map((a) => ({
            key: a.key,
            kind: a.kind,
            label: a.label,
            required: a.required,
            why: a.why,
            secretEnvVars: a.env_vars,
          }))
        );
        this.deps.bus.emit('access.updated', projectId, { items: repos.access.list(projectId).map(toAccessDto) });
      }

      // The cadrage proposal fills in the tier, but never overrules an explicit operator choice.
      if (reply.suggested_size && project.size_source !== 'user') {
        repos.projects.patch(projectId, { size: reply.suggested_size, size_source: 'cadrage' });
        const updated = repos.projects.byId(projectId);
        if (updated) this.deps.bus.emit('project.updated', projectId, { project: repos.projects.summary(updated) });
      }
      return;
    }

    const failure = result.failure!;
    if (failure.kind === 'resume_lost' && !isRetryAfterLostSession) {
      repos.sessions.setStatus(session.id, 'lost');
      await this.executeCadrageTurn(projectId, userText, true);
      return;
    }
    this.handleInteractiveFailure(projectId, 'cadrage', failure);
    void config;
  }
}
