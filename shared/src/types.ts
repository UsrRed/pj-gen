import type { FailureKind, ModelName, PipelineMode, ProjectSize, ProjectStatus, StepKey, StepRunStatus, TaskPhase, TaskStatus } from './statuses.js';

/** Token consumption of a run/project — what actually drives the subscription 5h limit. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** input + output + cacheCreation + cacheRead — raw cumulative sum; the UI headline shows the
   *  effective figure (without cacheRead), this raw total feeds the 5h-window gauge and tooltips. */
  total: number;
}

export interface StackInfo {
  language: string;
  framework: string;
  package_manager: string;
  install_cmd: string;
  build_cmd: string;
  test_cmd: string;
  run_cmd: string;
}

export interface ProjectSummary {
  id: string;
  slug: string;
  title: string;
  status: ProjectStatus;
  model: ModelName | null;
  /** Size tier; null = not decided yet (auto). Frozen at spec validation. */
  size: ProjectSize | null;
  /** 'user' (explicit choice, wins over everything), 'cadrage' (proposed), 'default'. */
  sizeSource: 'user' | 'cadrage' | 'default' | null;
  /** Build/improvement cycle number: 1 = initial build, 2+ = reopened iterations. */
  iteration: number;
  workspacePath: string;
  currentStepKey: StepKey | null;
  currentTaskKey: string | null;
  queuePosition: number | null;
  tasksDone: number;
  tasksTotal: number;
  tokens: TokenUsage;
  errorMessage: string | null;
  specValidatedAt: number | null;
  /** 'micro' while a live micro-modification cycle is queued/running. */
  pipelineMode: PipelineMode;
  /** Per-project design benchmark toggle; null = follow the global setting. */
  designBenchmark: boolean | null;
  /** GitHub link state; null when the project is not published. */
  github: { repo: string; private: boolean; autoMode: boolean; lastPushSha: string | null; lastPushAt: number | null } | null;
  /** True while a generate-ci request is queued, waiting for the project to be linked to GitHub. */
  githubCiPending: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TaskDto {
  taskKey: string;
  position: number;
  title: string;
  description: string;
  /** Paths the task will likely READ — a hint, not a commitment. */
  filesHint: string[];
  /** Paths the task COMMITS to writing. Two tasks batch in parallel only if these are disjoint. */
  writes: string[];
  acceptance: string[];
  /** CONTRACT dependencies: the task cannot be written without these outputs existing. */
  dependsOn: string[];
  /** ORDERING dependencies: the task could technically run, but shouldn't run before these
   *  are done (doing polish work on a half-built feature means redoing it). */
  after: string[];
  /** Product maturity stage; every task of an earlier phase must be done first. */
  phase: TaskPhase;
  status: TaskStatus;
  commitSha: string | null;
  /** Set while the task runs in its own git worktree (parallel batch). */
  worktreeDir?: string | null;
}

export interface StepRunDto {
  id: number;
  projectId: string;
  stepKey: StepKey;
  taskKey: string | null;
  attempt: number;
  status: StepRunStatus;
  sessionId: string | null;
  resumeAt: number | null;
  model: string | null;
  numTurns: number;
  tokens: TokenUsage;
  errorKind: FailureKind | null;
  errorMessage: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Wall-clock of the claude session (null on rows predating the timing migration). */
  durationMs: number | null;
  /** Wall-clock of the stack verification that followed the session. */
  verifyMs: number | null;
}

export interface ChatMessageDto {
  id: number;
  projectId: string;
  sessionKind: 'cadrage' | 'deploy';
  role: 'user' | 'assistant' | 'system';
  content: string;
  structured: CadrageStructured | null;
  createdAt: number;
}

export interface CadrageStructured {
  open_questions?: string[];
  ready_for_spec?: boolean;
  /** Size tier the cadrage session proposes, with its one-line justification. */
  suggested_size?: ProjectSize;
  size_rationale?: string;
}

export type MicroRequestStatus = 'pending' | 'task_created' | 'done' | 'failed' | 'needs_clarification' | 'escalated';

/** A live micro-modification: a small change request turned into a single task, no full pipeline. */
export interface MicroRequestDto {
  id: number;
  projectId: string;
  source: 'manual' | 'issue';
  issueId: number | null;
  request: string;
  taskKey: string | null;
  status: MicroRequestStatus;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectDetail extends ProjectSummary {
  initialPrompt: string;
  stack: StackInfo | null;
  stepModelOverrides: Partial<Record<StepKey, ModelName>>;
  tasks: TaskDto[];
  stepRuns: StepRunDto[];
  messages: ChatMessageDto[];
  microRequests: MicroRequestDto[];
  /** True while a SPEC generation session is running/queued for this project. */
  specGenerating: boolean;
}

export interface StepCap {
  turns: number;
  timeoutMin: number;
}

export interface NotifyEvents {
  deployReady: boolean;
  buildFailed: boolean;
  quotaResumed: boolean;
}

/** Names of the optional MCP-backed integrations (issue #8) — off by default, opt-in per operator. */
export const INTEGRATION_KEYS = ['context7', 'exa'] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];
export const MEMORY_PROVIDERS = ['none', 'mem0', 'supermemory'] as const;
export type MemoryProvider = (typeof MEMORY_PROVIDERS)[number];

export interface IntegrationsSettings {
  /** context7 (library/API doc lookup) enabled for architecture/task_breakdown. */
  context7: boolean;
  /** EXA (web search) enabled for design_benchmark. */
  exa: boolean;
  /** At most ONE memory MCP active at a time — mem0 and supermemory overlap in purpose. */
  memoryProvider: MemoryProvider;
}

export interface SettingsDto {
  /** Max projects building at once. */
  maxConcurrentBuilds: number;
  /** Max concurrent build `claude -p` processes overall — the real resource ceiling once
   *  a single project runs several tasks in parallel. Cadrage/deploy sessions are exempt. */
  maxConcurrentSessions: number;
  /** Max tasks implemented in parallel within one project (1 = the serial path). */
  taskParallelism: number;
  defaultModel: ModelName;
  autoResumeOnBoot: boolean;
  skipTestHardening: boolean;
  maxBudgetUsdPerSession: number;
  stepCaps: Record<string, StepCap>;
  /** Default model per step (cadrage/spec included); project stepModelOverrides win over these. */
  stepModels: Record<string, ModelName>;
  /** Global default for the design benchmark step (overridable per project). */
  designBenchmark: boolean;
  /** Default visibility when publishing a project to GitHub. */
  githubDefaultPrivate: boolean;
  /** GitHub issue poll interval in minutes (linked projects only). */
  issuePollMinutes: number;
  /** Webhook (ntfy.sh-compatible) for background-run notifications; empty = disabled. */
  notifyUrl: string;
  notifyEvents: NotifyEvents;
  /** Expose the UI/API on the local network (no auth — trusted LAN only). */
  exposeLan: boolean;
  /** Per-tier overrides of the built-in size profiles (task budget, cap multiplier, parallelism). */
  sizeProfiles: Partial<Record<ProjectSize, SizeProfileOverride>>;
  /** Optional MCP integrations (issue #8): all off by default, gated on an operator-supplied key. */
  integrations: IntegrationsSettings;
}

/** Operator-tunable slice of a size profile; anything omitted keeps the built-in value. */
export interface SizeProfileOverride {
  maxTasks?: number;
  maxTasksRevision?: number;
  capMultiplier?: number;
  taskParallelism?: number;
  skipSteps?: StepKey[];
}

/** Live state of the LAN exposure proxy. */
export interface LanStatusDto {
  enabled: boolean;
  /** URLs reachable from other machines on the LAN while enabled. */
  urls: string[];
  /** Per-interface bind failures (port busy, interface gone…). */
  errors: string[];
  /** The server itself is already bound to a non-loopback host (PJGEN_HOST) — toggle is a no-op. */
  alreadyExposed: boolean;
}

/** State of the web console (one persistent shell in pj-gen's own environment). */
export interface ConsoleStatusDto {
  /** False when the native pty module could not be loaded — `reason` says why. */
  available: boolean;
  reason: string | null;
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  /** Exit code of the last shell, null while running or never started. */
  exitCode: number | null;
}

/** Live view of the current subscription rate-limit window. */
export interface QuotaWindowDto {
  /** Epoch ms when the current window resets (from the stream's rate_limit_event), null if never seen. */
  resetsAt: number | null;
  windowType: string | null;
  tokensInWindow: TokenUsage;
  /** Median tokens consumed at the last limit hits — null until a limit has been hit at least once. */
  estimatedCeiling: number | null;
}

/** Persisted shape of the (single) scheduled token cut. */
export interface ScheduledCut {
  /** Epoch ms at which the user wants their tokens available. */
  targetAt: number;
  /** Share of tokens to preserve at targetAt; 100 = full window required. */
  reservePct: number;
}

export interface ScheduledCutDto extends ScheduledCut {
  /** True once the cut is actively blocking builds. */
  binding: boolean;
  /** reservePct < 100 but the ceiling is unknown — enforced as a full cut. */
  ceilingUnknown: boolean;
}

export interface QuotaDto {
  limitedUntil: number | null;
  lastHitAt: number | null;
  matchedPattern: string | null;
  authOk: boolean;
  authDetail: string;
  window: QuotaWindowDto;
  /** Global pause switch — nothing starts while true (pause-all button or a fired cut). */
  globalPaused: boolean;
  scheduledCut: ScheduledCutDto | null;
}

export interface StatsDto {
  days: { day: string; tokens: TokenUsage }[];
  /** totalTokens/avgTokens are EFFECTIVE tokens (input + output + cacheCreation, cache reads excluded). */
  perStep: { stepKey: string; runs: number; totalTokens: number; avgTokens: number }[];
  /** total is EFFECTIVE tokens (cache reads excluded). */
  perProject: { slug: string; title: string; total: number }[];
  /** All-time prompt-cache hit rate: cacheRead / (input + cacheRead + cacheCreation). Null when no data. */
  cacheRate: number | null;
  /** Wall-clock per step: where the build time actually goes. Rows predating the timing migration are excluded. */
  timePerStep: { stepKey: string; runs: number; medianMs: number; p90Ms: number; totalMs: number; verifyMs: number }[];
  /** Wall-clock summed per project (sessions only — queue waits and quota parks are not counted). */
  timePerProject: { slug: string; title: string; totalMs: number; runs: number }[];
}

/** State of a generated project's app process (Aperçu tab). */
export interface AppStateDto {
  running: boolean;
  url: string | null;
  startedAt: number | null;
  lines: string[];
}

export interface LogLineDto {
  seq: number;
  kind: 'stdout_json' | 'stderr' | 'meta';
  display: string;
  createdAt: number;
}

export interface ArtifactNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: ArtifactNode[];
}

export interface QueueSnapshot {
  activeIds: string[];
  queuedIds: string[];
}

// ---------- GitHub integration (gh CLI) ----------

export interface GithubStatusDto {
  /** gh binary found on the machine. */
  installed: boolean;
  /** gh auth status OK. */
  authOk: boolean;
  /** Authenticated GitHub login (null when not authenticated). */
  login: string | null;
  detail: string;
}

/** One row of the /github view: remote repos crossed with local projects. */
export interface GithubRepoView {
  category: 'remote_only' | 'local_unpublished' | 'linked';
  /** Local project (absent for remote_only). */
  projectId?: string;
  slug?: string;
  title?: string;
  projectStatus?: ProjectStatus;
  /** Remote side (absent for local_unpublished). */
  nameWithOwner?: string;
  visibility?: string;
  updatedAt?: string;
  url?: string;
  /** Sync state for linked repos (best-effort; null when fetch failed). */
  ahead?: number | null;
  behind?: number | null;
  autoMode?: boolean;
}

export type IssueDecision =
  | 'pending'
  | 'skipped'
  | 'queued'
  | 'fixing'
  | 'ci_running'
  | 'fixed'
  | 'failed'
  | 'needs_clarification'
  | 'escalated'
  | 'blocked_security';

export interface IssueDto {
  id: number;
  projectId: string;
  number: number;
  title: string;
  body: string;
  author: string;
  ghState: 'open' | 'closed';
  decision: IssueDecision;
  postedCommentAt: number | null;
  lastSyncedAt: number;
  createdAt: number;
  updatedAt: number;
}
