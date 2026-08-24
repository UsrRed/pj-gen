## Types partagés clés (`shared/src`)

- `ProjectStatus` (statuses.ts) : `draft | spec_ready | queued | building | paused_limit | paused_user | interrupted | failed | awaiting_deploy_approval | deploying | deploy_failed | deployed | canceled`, avec `PROJECT_TRANSITIONS` (machine à états CAS) et `REOPENABLE_STATUSES`.
- `StepKey` : `design_benchmark | design | architecture | task_breakdown | scaffold | implement_task | polish | test_hardening | review_fix | feature_check | docs | final_verify | deploy | micro`. `PIPELINE_ORDER` (12 étapes autonomes) vs `MICRO_PIPELINE_ORDER` (`implement_task, final_verify`).
- `TaskDto` : `{ taskKey, position, title, description, filesHint[], writes[], acceptance[], dependsOn[], after[], phase: TaskPhase, status, commitSha, worktreeDir? }`. `TaskPhase = foundation | core | polish`.
- `ProjectSize = small | mvp | large | enterprise` (figé à la validation du SPEC).
- `TokenUsage = { input, output, cacheCreation, cacheRead, total }`.
- `AccessDto` (access.ts) : `{ id, projectId, key, kind: AccessKind, label, required, why, fields: Record<string,string>, secretEnvVars: string[], status: needed|provided|skipped, source: cadrage|user, lastTestAt, lastTestOk, lastTestDetail }`. `ACCESS_KINDS = ssh|domain|database|api_key|smtp|object_storage|other`, champs par type dans `ACCESS_FIELD_SPECS`.
- `EventPayloads` (events.ts) : 16 types d'événements SSE, dont `project.updated`, `step.started/log/finished`, `task.updated`, `chat.message`, `quota.updated`, `access.updated`, `app.status/log`, `issue.updated`, `micro.updated`, `boot.notice`.

## API HTTP (Fastify, préfixe `/api`)

**Projets** (`http/routes/projects.ts`) :
`POST /projects`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id` (designBenchmark, size), `POST /projects/:id/chat`, `POST /projects/:id/generate-spec`, `POST /projects/:id/validate-spec`, `POST /projects/:id/pause|resume|cancel|retry`, `DELETE /projects/:id`, `POST /projects/:id/reopen`, `POST /projects/:id/micro`, `POST /projects/:id/approve-deploy`, `POST /projects/:id/mark-deployed`.

**Contrôle global** (`control.ts`) : `POST /control/pause-all`, `POST /control/resume-all`, `POST/DELETE /control/cut` (coupe de tokens programmée, `{targetAt, reservePct}`).

**Divers** (`misc.ts`) : `GET /steps/:runId/logs`, `GET /projects/:id/artifacts[/file]`, `POST /projects/:id/open-folder`, `GET/POST /projects/:id/app[/start|/stop]`, `GET/PATCH /settings`, `GET /lan`, `POST /settings/notify-test`, `GET /quota`, `POST /quota/probe`, `GET /stats`, `GET /health`.

**GitHub** (`github.ts`) : `GET /github/status|repos`, `POST /github/clone`, `POST /projects/:id/github/link|push|generate-ci`, `PATCH /projects/:id/github/auto-mode`, `GET /issues`, `POST /issues/:id/decision`, `GET/POST/DELETE /github/trusted-users[/:login]`.

**Accès** (`access.ts`) : `GET/POST /projects/:id/access`, `PATCH/DELETE /projects/:id/access/:accessId`, `POST /projects/:id/access/:accessId/secrets` (seule route qui manipule des valeurs secrètes — écrit `.env`, ne les stocke ni ne les renvoie jamais), `POST /projects/:id/access/:accessId/test`.

**SSE** (`sse.ts`) : `GET /events` (global), `GET /projects/:id/events` (scopé), support `Last-Event-ID` pour rejeu des événements manqués.

## Contrat interne : exécution d'une session Claude

```ts
// server/src/claude/types.ts
interface SessionSpec {
  cwd: string; prompt: string; sessionId: string; resume: boolean; forkSession?: boolean;
  model: string; fallbackModel?: string;
  tools: 'none' | 'default' | string[];
  jsonSchema?: object; appendSystemPrompt?: string;
  maxBudgetUsd?: number; maxTurns: number; timeoutMs: number;
}
type RunnerFn = (spec: SessionSpec, hooks?: RunHooks) => RunHandle;
interface RunHandle { pid: number|null; result: Promise<RunResult>; cancel(reason): void; }
interface RunResult {
  outcome: 'success'|'failure'; sessionId: string; resultText: string; structured?: unknown;
  numTurns: number; costUsd: number; usage: RunUsage; rateLimitInfo?: RateLimitInfo;
  durationMs: number; failure?: { kind: FailureKind; message: string; resetAt?: number; matchedPattern?: string };
}
```
Implémentations : `claude/runner.ts` (`createRealRunner`, spawn `claude` CLI, stdin=prompt, parse stdout NDJSON) et `claude/fakeRunner.ts` (simulation, `PJGEN_FAKE_CLI=1`). Point d'entrée commun : `executeClaudeRun(deps, ExecOpts)` (`pipeline/stepRunner.ts`) — bookkeeping DB (`step_runs`), logs, notification quota.

## Contrat interne : étape de pipeline

```ts
// server/src/pipeline/steps.ts
interface StepCtx { deps: CoreDeps; projectId: string; workspace: string; signal: AbortSignal; getStack(): StackInfo|null; setStack(s): void; }
type StepFlow = { status: 'ok' } | { status: 'parked' } | { status: 'halted'; mode: 'pause'|'cancel' } | { status: 'failed'; message: string };
```
12 fonctions exportées (une par `StepKey` hors `deploy`/`micro`), enregistrées dans `STEP_FNS` (`pipeline/engine.ts`). Sortie structurée validée par les schémas zod de `prompts/schemas.ts` (ex. `ArchOutputZ`, `BreakdownOutputZ`, `FeatureAuditZ`), prompts construits par `prompts/steps.ts`.

## Schéma SQLite (tables principales)

`projects`, `sessions`, `step_runs`, `tasks` (avec `writes`, `worktree_dir`, `after_keys`, `phase`), `messages`, `events` (append-only, rejoué par SSE), `logs`, `settings`, `quota_state`, `usage_log`, `limit_hits`, `app_runs`, `micro_requests`, `issues`, `trusted_users`, `project_access` (inventaire d'accès, jamais de colonne secrète).

## Client web (`web/src/api/client.ts`)

Objet `api` unique, typé sur les DTOs `@pjgen/shared`, un endpoint par méthode (ex. `api.createProject`, `api.chat`, `api.micro`, `api.putAccessSecrets`). État global piloté par `store/useStore.ts` (zustand), alimenté par `api/sse.ts` (wrapper `EventSource`) qui applique les payloads d'événements aux slices du store.
