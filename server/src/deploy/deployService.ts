import { randomUUID } from 'node:crypto';
import type { CoreDeps } from '../core/deps.js';
import { ProjectStateMachine } from '../core/stateMachine.js';
import { toMessageDto } from '../db/repos/index.js';
import { executeClaudeRun } from '../pipeline/stepRunner.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { deployFirstPrompt, deployNotesSystem } from '../prompts/steps.js';
import type { ChatService } from '../cadrage/chatService.js';

/** HITL deploy: approval gate, then a chat-driven claude session with full tools in the workspace. */
export class DeployService {
  private sm: ProjectStateMachine;

  constructor(
    private deps: CoreDeps,
    private chat: ChatService
  ) {
    this.sm = new ProjectStateMachine(deps.repos.projects);
  }

  private emitProject(projectId: string): void {
    const row = this.deps.repos.projects.byId(projectId);
    if (row) this.deps.bus.emit('project.updated', projectId, { project: this.deps.repos.projects.summary(row) });
  }

  async approve(projectId: string, notes: string): Promise<void> {
    const { repos, mutex, bus } = this.deps;
    await mutex.run(projectId, async () => {
      this.sm.transitionOr409(projectId, ['awaiting_deploy_approval', 'deploy_failed'], 'deploying', {
        deploy_notes: notes,
        error_message: null,
      });
      this.emitProject(projectId);
      bus.emit('queue.updated', null, repos.projects.queueSnapshot());
      const row = repos.messages.insert(projectId, 'deploy', 'system', '🚀 Déploiement approuvé — session de déploiement démarrée.');
      bus.emit('chat.message', projectId, { message: toMessageDto(row) });
    });
    // First turn runs outside the mutex slot used by approve (turn serializes itself).
    void this.runTurn(projectId, null);
  }

  /** One deploy chat turn. userText null → automatic first turn. */
  async runTurn(projectId: string, userText: string | null): Promise<void> {
    const { repos, mutex, bus } = this.deps;
    await mutex.run(projectId, async () => {
      let project = repos.projects.byId(projectId);
      if (!project) return;
      if (project.status === 'deploy_failed' && userText !== null) {
        // A new operator message relaunches the conversation.
        if (this.sm.tryTransition(projectId, ['deploy_failed'], 'deploying')) this.emitProject(projectId);
        project = repos.projects.byId(projectId)!;
      }
      if (project.status !== 'deploying') return;

      if (userText !== null) {
        const row = repos.messages.insert(projectId, 'deploy', 'user', userText);
        bus.emit('chat.message', projectId, { message: toMessageDto(row) });
      }
      if (this.chat.quotaBlocked(projectId, 'deploy')) return;

      let session = repos.sessions.latestActive(projectId, 'deploy');
      let resume = true;
      if (!session) {
        const id = randomUUID();
        repos.sessions.insert(id, projectId, 'deploy');
        session = repos.sessions.byId(id)!;
        resume = false;
      }

      const { model, fallbackModel } = resolveModel(repos, project, 'deploy');
      const caps = capsFor(repos, 'deploy');
      const settings = repos.settings.getAll();
      const notes = project.deploy_notes?.trim() ? deployNotesSystem(project.deploy_notes) : '';

      const { result } = await executeClaudeRun(this.deps, {
        projectId,
        stepKey: 'deploy',
        taskKey: null,
        attempt: 1,
        isLastAttempt: true,
        session: { id: session.id, resume, kind: 'deploy' },
        spec: {
          cwd: project.workspace_path,
          prompt: userText ?? deployFirstPrompt(),
          model,
          fallbackModel,
          tools: 'default',
          appendSystemPrompt: `${commonSystemPrompt()}\n\n${notes}`.trim(),
          maxBudgetUsd: settings.maxBudgetUsdPerSession,
          maxTurns: caps.maxTurns,
          timeoutMs: caps.timeoutMs,
        },
      });

      if (result.outcome === 'success') {
        const row = repos.messages.insert(projectId, 'deploy', 'assistant', result.resultText || '(réponse vide)', null, session.id);
        bus.emit('chat.message', projectId, { message: toMessageDto(row) });
        return;
      }

      const failure = result.failure!;
      if (failure.kind === 'usage_limit') {
        this.chat.handleInteractiveFailure(projectId, 'deploy', failure);
        return; // stays 'deploying'; operator resends after the reset
      }
      if (failure.kind === 'resume_lost') {
        repos.sessions.setStatus(session.id, 'lost');
        this.chat.systemMessage(projectId, 'deploy', '⚠️ Session de déploiement perdue — renvoie ton message, une nouvelle session reprendra avec docs/DEPLOY.md.');
        return;
      }
      this.chat.handleInteractiveFailure(projectId, 'deploy', failure);
      if (this.sm.tryTransition(projectId, ['deploying'], 'deploy_failed', { error_message: failure.message.slice(0, 500) })) {
        this.emitProject(projectId);
      }
    });
  }

  async markDeployed(projectId: string): Promise<void> {
    const { repos, mutex, bus } = this.deps;
    await mutex.run(projectId, async () => {
      this.sm.transitionOr409(projectId, ['deploying', 'deploy_failed'], 'deployed', { current_step_key: null });
      const session = repos.sessions.latestActive(projectId, 'deploy');
      if (session) repos.sessions.setStatus(session.id, 'closed');
      this.emitProject(projectId);
      bus.emit('queue.updated', null, repos.projects.queueSnapshot());
      const row = repos.messages.insert(projectId, 'deploy', 'system', '✅ Projet marqué comme déployé.');
      bus.emit('chat.message', projectId, { message: toMessageDto(row) });
    });
  }
}
