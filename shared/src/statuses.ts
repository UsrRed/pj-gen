export const PROJECT_STATUSES = [
  'draft',
  'spec_ready',
  'queued',
  'building',
  'paused_limit',
  'paused_user',
  'interrupted',
  'failed',
  'awaiting_deploy_approval',
  'deploying',
  'deploy_failed',
  'deployed',
  'canceled',
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const TERMINAL_STATUSES: ProjectStatus[] = ['deployed', 'canceled'];

/**
 * Allowed transitions, enforced with compare-and-swap updates.
 * `→ draft` from settled states = "reopen": a new improvement iteration on the same workspace.
 */
export const PROJECT_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  draft: ['spec_ready', 'canceled'],
  spec_ready: ['spec_ready', 'queued', 'draft', 'canceled'],
  queued: ['building', 'paused_user', 'canceled'],
  building: ['paused_limit', 'paused_user', 'failed', 'awaiting_deploy_approval', 'deployed', 'canceled', 'queued', 'interrupted'],
  paused_limit: ['building', 'paused_user', 'canceled'],
  paused_user: ['queued', 'canceled'],
  interrupted: ['queued', 'canceled'],
  failed: ['queued', 'canceled', 'draft'],
  awaiting_deploy_approval: ['deploying', 'canceled', 'draft', 'queued'],
  deploying: ['deployed', 'deploy_failed', 'canceled'],
  deploy_failed: ['deploying', 'awaiting_deploy_approval', 'deployed', 'canceled'],
  deployed: ['draft', 'queued'],
  canceled: ['draft'],
};

/** Statuses from which a project can be reopened for an improvement iteration. */
export const REOPENABLE_STATUSES: ProjectStatus[] = ['awaiting_deploy_approval', 'deployed', 'failed', 'canceled'];

export const STEP_KEYS = [
  'design_benchmark',
  'design',
  'architecture',
  'task_breakdown',
  'scaffold',
  'implement_task',
  'polish',
  'test_hardening',
  'review_fix',
  'feature_check',
  'docs',
  'final_verify',
  'deploy',
  'micro',
] as const;
export type StepKey = (typeof STEP_KEYS)[number];

/** Ordered autonomous pipeline (deploy is HITL-triggered, outside the loop; micro is the micro-request generation session). */
export const PIPELINE_ORDER: StepKey[] = [
  'design_benchmark',
  'design',
  'architecture',
  'task_breakdown',
  'scaffold',
  'implement_task',
  'polish',
  'test_hardening',
  'review_fix',
  'feature_check',
  'docs',
  'final_verify',
];

/** Reduced pipeline for live micro-modifications: implement the appended task(s), then verify. */
export const MICRO_PIPELINE_ORDER: StepKey[] = ['implement_task', 'final_verify'];

export type PipelineMode = 'full' | 'micro';

export const STEP_RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed_retryable',
  'failed',
  'paused_limit',
  'canceled',
  'orphaned',
] as const;
export type StepRunStatus = (typeof STEP_RUN_STATUSES)[number];

export const TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * Product maturity stage of a task, in order. A task only becomes ready once EVERY task
 * of an earlier phase is done — that is the "no animations before the game actually
 * plays" rule, without the architect having to enumerate every gameplay task.
 *
 * - foundation: skeleton, data model, plumbing everything else builds on
 * - core: the actual features — the product must be usable at the end of this phase
 * - polish: animations, transitions, sound, micro-interactions, visual refinement
 */
export const TASK_PHASES = ['foundation', 'core', 'polish'] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

export const DEFAULT_TASK_PHASE: TaskPhase = 'core';

/** Rank used to compare phases; unknown values fall back to the default phase. */
export function phaseRank(phase: string | null | undefined): number {
  const i = TASK_PHASES.indexOf((phase ?? DEFAULT_TASK_PHASE) as TaskPhase);
  return i === -1 ? TASK_PHASES.indexOf(DEFAULT_TASK_PHASE) : i;
}

export const MODEL_NAMES = ['opus', 'sonnet', 'haiku'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

/**
 * Project size tier — decided during cadrage, frozen at spec validation.
 * It is not a label: it drives which pipeline steps run, the task budget, the
 * turn/duration caps, the model routing and the scope discipline in the prompts.
 * NULL on a project means "not decided yet" (auto).
 */
export const PROJECT_SIZES = ['small', 'mvp', 'large', 'enterprise'] as const;
export type ProjectSize = (typeof PROJECT_SIZES)[number];

/** Fallback for projects created before sizing existed, and for "auto" never resolved. */
export const DEFAULT_PROJECT_SIZE: ProjectSize = 'mvp';

export type FailureKind =
  | 'usage_limit'
  | 'auth'
  | 'overloaded'
  | 'timeout'
  | 'schema_invalid'
  | 'verify_failed'
  /** `--max-budget-usd` reached: the CLI kills the session on the spot. */
  | 'budget_exceeded'
  | 'crash'
  | 'resume_lost'
  | 'canceled'
  | 'spawn_error'
  | 'unknown';
