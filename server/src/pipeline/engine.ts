import { MICRO_PIPELINE_ORDER, PIPELINE_ORDER, type StackInfo, type StepKey } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';
import { ProjectStateMachine } from '../core/stateMachine.js';
import { toMicroDto } from '../db/repos/index.js';
import { profileFor } from './sizing.js';
import {
  stepDesignBenchmark,
  stepDesign,
  stepArchitecture,
  stepTaskBreakdown,
  stepScaffold,
  stepImplementTasks,
  stepPolish,
  stepTestHardening,
  stepReviewFix,
  stepFeatureCheck,
  stepDocs,
  stepFinalVerify,
  haltMode,
  type StepCtx,
  type StepFlow,
} from './steps.js';

export type EngineOutcome = 'completed' | 'parked' | 'paused_user' | 'canceled' | 'failed' | 'preempted';

const STEP_FNS: Record<Exclude<StepKey, 'deploy' | 'micro'>, (ctx: StepCtx) => Promise<StepFlow>> = {
  design_benchmark: stepDesignBenchmark,
  design: stepDesign,
  architecture: stepArchitecture,
  task_breakdown: stepTaskBreakdown,
  scaffold: stepScaffold,
  implement_task: stepImplementTasks,
  polish: stepPolish,
  test_hardening: stepTestHardening,
  review_fix: stepReviewFix,
  feature_check: stepFeatureCheck,
  docs: stepDocs,
  final_verify: stepFinalVerify,
};

export class Engine {
  private sm: ProjectStateMachine;

  constructor(private deps: CoreDeps) {
    this.sm = new ProjectStateMachine(deps.repos.projects);
  }

  private emitProject(projectId: string): void {
    const row = this.deps.repos.projects.byId(projectId);
    if (row) this.deps.bus.emit('project.updated', projectId, { project: this.deps.repos.projects.summary(row) });
    this.deps.bus.emit('queue.updated', null, this.deps.repos.projects.queueSnapshot());
  }

  /** Runs the autonomous pipeline for a project already transitioned to `building`. */
  async runProject(projectId: string, signal: AbortSignal): Promise<EngineOutcome> {
    try {
      return await this.runInner(projectId, signal);
    } catch (err) {
      const message = (err as Error).message?.slice(0, 500) ?? 'erreur interne';
      this.sm.tryTransition(projectId, ['building'], 'failed', { error_message: `erreur interne du pipeline: ${message}` });
      this.emitProject(projectId);
      return 'failed';
    }
  }

  private async runInner(projectId: string, signal: AbortSignal): Promise<EngineOutcome> {
    const { repos } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project) return 'failed';
    const workspace = project.workspace_path;

    let stack: StackInfo | null = repos.projects.stackOf(project);
    const ctx: StepCtx = {
      deps: this.deps,
      projectId,
      workspace,
      signal,
      getStack: () => stack,
      setStack: (s) => {
        stack = s;
      },
    };

    const settings = repos.settings.getAll();
    // Live micro-modifications run a reduced pipeline: implement the appended task(s), then verify.
    const isMicro = (project.pipeline_mode ?? 'full') === 'micro';
    // The size tier drops whole steps (a small project needs no design benchmark nor
    // test hardening) — that is the cheapest speedup there is, and it is per project.
    const profile = profileFor(repos, project);
    const skip = new Set<StepKey>(isMicro ? [] : profile.skipSteps);
    if (settings.skipTestHardening) skip.add('test_hardening');
    // An explicit per-project benchmark choice outranks the tier's default.
    if (project.design_benchmark !== null) skip.delete('design_benchmark');

    const order = isMicro ? MICRO_PIPELINE_ORDER : PIPELINE_ORDER;
    const startIdx = project.current_step_key ? Math.max(0, order.indexOf(project.current_step_key)) : 0;

    for (let i = startIdx; i < order.length; i++) {
      const stepKey = order[i] as Exclude<StepKey, 'deploy' | 'micro'>;
      if (skip.has(stepKey)) continue;
      if (signal.aborted) return this.finishHalted(projectId, haltMode(signal));

      // A cancel/pause from outside may already have moved the status away from building.
      if (repos.projects.byId(projectId)?.status !== 'building') return 'preempted';

      repos.projects.patch(projectId, { current_step_key: stepKey });
      this.emitProject(projectId);

      const flow = await STEP_FNS[stepKey](ctx);

      if (flow.status === 'ok') continue;
      if (flow.status === 'parked') {
        this.sm.tryTransition(projectId, ['building'], 'paused_limit');
        this.emitProject(projectId);
        return 'parked';
      }
      if (flow.status === 'halted') return this.finishHalted(projectId, flow.mode);
      this.sm.tryTransition(projectId, ['building'], 'failed', { error_message: `${stepKey}: ${flow.message}` });
      this.settleMicroRequests(projectId);
      this.emitProject(projectId);
      return 'failed';
    }

    // Settle micro requests riding this cycle (their tasks are done or not by now).
    const settled = this.settleMicroRequests(projectId);
    if (isMicro) {
      // Manual micro-mods go back through the deploy gate; issue fixes on an
      // auto-mode project (private repo) return straight to deployed.
      const finalRow = repos.projects.byId(projectId)!;
      const autoIssueOnly = settled.length > 0 && settled.every((r) => r.source === 'issue') && finalRow.github_auto_mode === 1;
      this.sm.tryTransition(projectId, ['building'], autoIssueOnly ? 'deployed' : 'awaiting_deploy_approval', {
        current_step_key: null,
        current_task_key: null,
        error_message: null,
        pipeline_mode: 'full',
      });
      this.emitProject(projectId);
      return 'completed';
    }

    this.sm.tryTransition(projectId, ['building'], 'awaiting_deploy_approval', {
      current_step_key: null,
      current_task_key: null,
      error_message: null,
    });
    this.emitProject(projectId);
    return 'completed';
  }

  /** Mark open micro requests done/failed from their task status and broadcast them. */
  private settleMicroRequests(projectId: string) {
    const settled = this.deps.repos.micro.settleForProject(projectId);
    for (const r of settled) this.deps.bus.emit('micro.updated', projectId, { request: toMicroDto(r) });
    return settled;
  }

  /** On cancel, drop every worktree; on pause, keep them so the resume reattaches. */
  private async sweepWorktrees(projectId: string, mode: 'pause' | 'cancel'): Promise<void> {
    if (mode === 'pause') return;
    const row = this.deps.repos.projects.byId(projectId);
    if (!row) return;
    await this.deps.wt.sweep(row.workspace_path, row.slug, []).catch(() => undefined);
  }

  private finishHalted(projectId: string, mode: 'pause' | 'cancel'): EngineOutcome {
    void this.sweepWorktrees(projectId, mode);
    if (mode === 'pause') {
      this.sm.tryTransition(projectId, ['building'], 'paused_user');
      this.emitProject(projectId);
      return 'paused_user';
    }
    // cancel: the route already set the terminal status; nothing left to transition.
    this.emitProject(projectId);
    return 'canceled';
  }
}
