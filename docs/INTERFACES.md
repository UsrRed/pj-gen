## Types partagés clés (`shared/src`)

- `ProjectStatus` (statuses.ts) : `draft | spec_ready | queued | building | paused_limit | paused_user | interrupted | failed | awaiting_deploy_approval | deploying | deploy_failed | deployed | canceled`, avec `PROJECT_TRANSITIONS` (machine à états CAS) et `REOPENABLE_STATUSES`.
- `StepKey` : `design_benchmark | design | architecture | task_breakdown | scaffold | implement_task | polish | test_hardening | review_fix | feature_check | docs | final_verify | deploy | micro`. `PIPELINE_ORDER` (12 étapes autonomes) vs `MICRO_PIPELINE_ORDER` (`implement_task, final_verify`).
- `TaskDto` : `{ taskKey, position, title, description, filesHint[], writes[], acceptance[], dependsOn[], after[], phase: TaskPhase, status, commitSha, worktreeDir? }`. `TaskPhase = foundation | core | polish`.
- `ProjectSize = small | mvp | large | enterprise` (figé à la validation du SPEC).
- `TokenUsage = { input, output, cacheCreation, cacheRead, total }`.
- `AccessDto` (access.ts) : `{ id, projectId, key, kind: AccessKind, label, required, why, fields: Record<string,string>, secretEnvVars: string[], status: needed|provided|skipped, source: cadrage|user, lastTestAt, lastTestOk, lastTestDetail }`. `ACCESS_KINDS = ssh|domain|database|api_key|smtp|object_storage|other`, champs par type dans `ACCESS_FIELD_SPECS`.
- `IntegrationsSettings` (types.ts, sur `SettingsDto.integrations`) : `{ context7: boolean; exa: boolean; memoryProvider: 'none'|'mem0'|'supermemory' }` — toutes désactivées par défaut (issue #8). Objet complet requis au PATCH (même contrat que `notifyEvents` : `SettingsRepo.set` remplace tout le blob stocké, un payload partiel écraserait silencieusement les champs non envoyés).
- `EventPayloads` (events.ts) : 16 types d'événements SSE, dont `project.updated`, `step.started/log/finished`, `task.updated`, `chat.message`, `quota.updated`, `access.updated`, `app.status/log`, `issue.updated`, `micro.updated`, `boot.notice`.
- `AssetResult` (`github/issueAssets.ts`) : `{ url, file, ok, error?, textExcerpt? }` — `textExcerpt` (T13, « pdfinspector ») est le texte extrait par `github/pdfInspector.ts` (`extractPdfText`, lib `pdf-parse`, borné à 4000 caractères) pour une pièce jointe PDF ; jamais levé en erreur, `undefined`/`null` si non applicable ou illisible. Injecté par `buildIssueRequest` dans le texte transmis au cadrage/SPEC, explicitement marqué non fiable (même statut que le reste du corps de l'issue).

## API HTTP (Fastify, préfixe `/api`)

**Projets** (`http/routes/projects.ts`) :
`POST /projects`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id` (designBenchmark, size), `POST /projects/:id/chat`, `POST /projects/:id/generate-spec`, `POST /projects/:id/validate-spec`, `POST /projects/:id/pause|resume|cancel|retry`, `DELETE /projects/:id`, `POST /projects/:id/reopen`, `POST /projects/:id/micro`, `POST /projects/:id/approve-deploy`, `POST /projects/:id/mark-deployed`.

**Contrôle global** (`control.ts`) : `POST /control/pause-all`, `POST /control/resume-all`, `POST/DELETE /control/cut` (coupe de tokens programmée, `{targetAt, reservePct}`).

**Divers** (`misc.ts`) : `GET /steps/:runId/logs`, `GET /projects/:id/artifacts[/file]`, `POST /projects/:id/open-folder`, `GET/POST /projects/:id/app[/start|/stop]`, `GET/PATCH /settings`, `GET /lan`, `POST /settings/notify-test`, `GET /quota`, `POST /quota/probe`, `GET /stats`, `GET /health`.

**GitHub** (`github.ts`) : `GET /github/status|repos`, `POST /github/clone`, `POST /projects/:id/github/link|push|generate-ci`, `PATCH /projects/:id/github/auto-mode`, `GET /issues`, `POST /issues/:id/decision`, `GET/POST/DELETE /github/trusted-users[/:login]`.

**Accès** (`access.ts`) : `GET/POST /projects/:id/access`, `PATCH/DELETE /projects/:id/access/:accessId`, `POST /projects/:id/access/:accessId/secrets` (seule route qui manipule des valeurs secrètes — écrit `.env`, ne les stocke ni ne les renvoie jamais), `POST /projects/:id/access/:accessId/test`.

**Intégrations optionnelles** (`misc.ts`, issue #8) : `GET /api/settings/integrations/secrets` (présence par nom uniquement, jamais la valeur), `POST /api/settings/integrations/secrets` (`{values: Record<string,string>}`, whitelist `CONTEXT7_API_KEY|EXA_API_KEY|MEM0_API_KEY|SUPERMEMORY_API_KEY` définie dans `access/integrationSecrets.ts`) — écrit dans `<dataDir>/.env` (global, 0600, réutilise `access/envFile.ts`) au lieu du `.env` d'un workspace. Activation/désactivation via `PATCH /api/settings {integrations}`.

**SSE** (`sse.ts`) : `GET /events` (global), `GET /projects/:id/events` (scopé), support `Last-Event-ID` pour rejeu des événements manqués.

## Contrat interne : exécution d'une session Claude

```ts
// server/src/claude/types.ts
interface McpServerConfig { name: string; command: string; args?: string[]; env?: Record<string,string>; }
interface SessionSpec {
  cwd: string; prompt: string; sessionId: string; resume: boolean; forkSession?: boolean;
  model: string; fallbackModel?: string;
  tools: 'none' | 'default' | string[];
  jsonSchema?: object; appendSystemPrompt?: string;
  maxBudgetUsd?: number; maxTurns: number; timeoutMs: number;
  /** Optional per-session MCP allowlist (T08+: context7/EXA/mémoire). Absent = zéro serveur (défaut inchangé). */
  mcpConfig?: McpServerConfig[];
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

`claude/sessionArgs.ts` `buildArgs(spec, caps): { argv: string[]; mcpConfigPath: string | null }` — `--strict-mcp-config` est TOUJOURS émis ; si `spec.mcpConfig` est fourni, un fichier JSON temporaire (`os.tmpdir()`, `0600`) listant uniquement ces serveurs est écrit et passé via `--mcp-config <path>` (allowlist explicite, jamais un config projet/utilisateur). `runner.ts` supprime ce fichier à la fermeture du process (best-effort).

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
