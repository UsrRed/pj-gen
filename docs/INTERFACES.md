## Types partagés clés (`shared/src`)

- `ProjectStatus` (statuses.ts) : `draft | spec_ready | queued | building | paused_limit | paused_user | interrupted | failed | awaiting_deploy_approval | deploying | deploy_failed | deployed | canceled`, avec `PROJECT_TRANSITIONS` (machine à états CAS) et `REOPENABLE_STATUSES`.
- `StepKey` : `design_benchmark | design | architecture | task_breakdown | scaffold | implement_task | polish | test_hardening | review_fix | feature_check | docs | final_verify | deploy | micro`. `PIPELINE_ORDER` (12 étapes autonomes) vs `MICRO_PIPELINE_ORDER` (`implement_task, final_verify`).
- `TaskDto` : `{ taskKey, position, title, description, filesHint[], writes[], acceptance[], dependsOn[], after[], phase: TaskPhase, status, commitSha, worktreeDir? }`. `TaskPhase = foundation | core | polish`.
- `ProjectSize = small | mvp | large | enterprise` (figé à la validation du SPEC).
- `TokenUsage = { input, output, cacheCreation, cacheRead, total }`.
- `AccessDto` (access.ts) : `{ id, projectId, key, kind: AccessKind, label, required, why, fields: Record<string,string>, secretEnvVars: string[], status: needed|provided|skipped, source: cadrage|user, lastTestAt, lastTestOk, lastTestDetail }`. `ACCESS_KINDS = ssh|domain|database|api_key|smtp|object_storage|other`, champs par type dans `ACCESS_FIELD_SPECS`.
- `IntegrationsSettings` (types.ts, sur `SettingsDto.integrations`) : `{ context7: boolean; exa: boolean; memoryProvider: 'none'|'mem0'|'supermemory' }` — toutes désactivées par défaut (issue #8). Objet complet requis au PATCH (même contrat que `notifyEvents` : `SettingsRepo.set` remplace tout le blob stocké, un payload partiel écraserait silencieusement les champs non envoyés).
- `EventPayloads` (events.ts) : 16 types d'événements SSE, dont `project.updated`, `step.started/log/finished`, `task.updated`, `chat.message`, `quota.updated`, `access.updated`, `app.status/log`, `issue.updated`, `micro.updated`, `boot.notice`.
- `IssueDecision` : `pending | skipped | queued | fixing | ci_running | fixed | failed | needs_clarification | escalated | blocked_security`. `blocked_security` = verdict malveillant du filtre de sécurité isolé (T19, voir plus bas) — l'issue n'est jamais implémentée dans cet état.
- `AssetResult` (`github/issueAssets.ts`) : `{ url, file, ok, error?, textExcerpt? }` — `textExcerpt` (T13, « pdfinspector ») est le texte extrait par `github/pdfInspector.ts` (`extractPdfText`, lib `pdf-parse`, borné à 4000 caractères) pour une pièce jointe PDF ; jamais levé en erreur, `undefined`/`null` si non applicable ou illisible. Injecté par `buildIssueRequest` dans le texte transmis au cadrage/SPEC, explicitement marqué non fiable (même statut que le reste du corps de l'issue).

## API HTTP (Fastify, préfixe `/api`)

**Projets** (`http/routes/projects.ts`) :
`POST /projects`, `GET /projects`, `GET /projects/:id`, `PATCH /projects/:id` (designBenchmark, size), `POST /projects/:id/chat`, `POST /projects/:id/generate-spec`, `POST /projects/:id/validate-spec`, `POST /projects/:id/pause|resume|cancel|retry`, `DELETE /projects/:id`, `POST /projects/:id/reopen`, `POST /projects/:id/micro`, `POST /projects/:id/approve-deploy`, `POST /projects/:id/mark-deployed`.

**Contrôle global** (`control.ts`) : `POST /control/pause-all`, `POST /control/resume-all`, `POST/DELETE /control/cut` (coupe de tokens programmée, `{targetAt, reservePct}`).

**Divers** (`misc.ts`) : `GET /steps/:runId/logs`, `GET /projects/:id/artifacts[/file]`, `POST /projects/:id/open-folder`, `GET/POST /projects/:id/app[/start|/stop]`, `GET /preview` (`{ port: number|null }` — port public du relais d'aperçu, null si désactivé), `GET/PATCH /settings`, `GET /lan`, `POST /settings/notify-test`, `GET /quota`, `POST /quota/probe`, `GET /stats`, `GET /health`.

**GitHub** (`github.ts`) : `GET /github/status|repos`, `POST /github/clone`, `POST /projects/:id/github/link|push|generate-ci`, `PATCH /projects/:id/github/auto-mode`, `GET /issues`, `POST /issues/:id/decision`, `GET/POST/DELETE /github/trusted-users[/:login]`.
`POST /projects/:id/github/generate-ci` répond `{ ok: true, status: 'queued' | 'generated' }` : `queued` si le projet n'est pas encore lié à GitHub — la demande est persistée (`projects.github_ci_pending`, exposé au client via `ProjectSummary.githubCiPending`) et se déclenche automatiquement (sans nouvel appel) au prochain `github/link` ou `github/auto-mode` réussi, via `project.updated`; `generated` si le workflow a été écrit et poussé immédiatement.

**Accès** (`access.ts`) : `GET/POST /projects/:id/access`, `PATCH/DELETE /projects/:id/access/:accessId`, `POST /projects/:id/access/:accessId/secrets` (seule route qui manipule des valeurs secrètes — écrit `.env`, ne les stocke ni ne les renvoie jamais), `POST /projects/:id/access/:accessId/test`.

**Intégrations optionnelles** (`misc.ts`, issue #8) : `GET /api/settings/integrations/secrets` (présence par nom uniquement, jamais la valeur), `POST /api/settings/integrations/secrets` (`{values: Record<string,string>}`, whitelist `CONTEXT7_API_KEY|EXA_API_KEY|MEM0_API_KEY|SUPERMEMORY_API_KEY` définie dans `access/integrationSecrets.ts`) — écrit dans `<dataDir>/.env` (global, 0600, réutilise `access/envFile.ts`) au lieu du `.env` d'un workspace. Activation/désactivation via `PATCH /api/settings {integrations}`.

**Console** (`console.ts`, service `console/consoleService.ts`) : un seul shell persistant (`$SHELL` interactif via `node-pty` — pas de shell de connexion : `/etc/profile` écraserait le `PATH` de l'image —, même uid/HOME que pj-gen, `toolEnv` sans `CI` + helper git `gh auth git-credential`) pour se réauthentifier (`gh auth login`, `claude auth login`) depuis l'UI. `GET /console` → `ConsoleStatusDto`, `POST /console/start` (`{cols, rows}`, idempotent : un shell déjà lancé est seulement redimensionné), `POST /console/input` (`{data}`, ≤ 64 Kio), `POST /console/resize` (`{cols, rows}`), `POST /console/kill` (SIGHUP), `POST /console/recheck-auth` (relance `claude auth status` → `Scheduler.setAuth`, renvoie l'`AuthStatus`; refait aussi automatiquement à la sortie du shell), `GET /console/stream` (SSE : `snapshot` `{data, status}` à chaque (re)connexion — 256 Kio de scrollback —, puis `output` (chaîne), `started`/`exit` (`ConsoleStatusDto`)). SSE + POST plutôt que WebSocket : le flux principal traverse déjà `tailscale serve` (HTTP/2) ainsi. Garde sur toutes ces routes : 403 si `Sec-Fetch-Site` n'est ni `same-origin` ni `none`, si `Origin` ne correspond pas à `Host`/`X-Forwarded-Host` (ou vaut `null`) — la politique CORS globale reflète n'importe quelle origine, et le relais d'aperçu sert des applis arbitraires sur le même hôte — et tant que l'exposition LAN est active (pj-gen n'a pas d'authentification propre). `node-pty` est chargé paresseusement : s'il manque, `available: false` + `reason`, le reste du serveur tourne.

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

**Filtre de sécurité des issues (T19)** : avant tout routage auto d'une issue GitHub (micro ou reopen), `IssuePoller.checkIssueSecurity` (`github/issuePoller.ts`) lance une session isolée dédiée (`tools: 'none'`, contexte = UNIQUEMENT titre + corps de l'issue, aucun historique projet) via `issueSecurityPrompt` (`prompts/steps.ts`) et le schéma `IssueSecurityVerdictZ` / `ISSUE_SECURITY_JSON_SCHEMA` (`prompts/schemas.ts`) → `{ malicious: boolean, reason: string }`. Verdict malveillant : l'issue passe en décision `blocked_security` (jamais implémentée), un commentaire explicatif est posté ; sinon le flux existant (T05/T06/T09) est inchangé. Fail-open (verdict bénin) si la session échoue ou si la sortie est invalide.

**Push non-fast-forward avec auto-résolution (T15/T21, réécrit)** : `GithubService.pushWithRetry(projectId, cwd, opts?: { autoResolve?: boolean })` (`github/githubService.ts`), utilisé par `push()` et donc par `generateCi()`, gère le rejet `[rejected] (non-fast-forward|fetch first)` en deux temps — 1) `git fetch` + `git merge --no-edit origin/<branche>` ; si ça suffit, retente `git push origin HEAD` une seule fois (comportement inchangé pour le bouton « push » manuel, `autoResolve` absent). 2) Si le merge est en conflit ET `opts.autoResolve` est actif — passé par `IssuePoller.finalizeFixing` (flux auto-issue, projet privé + auto-mode) ET par `GithubService.runCiGeneration` (T17 : `generateCi()` pousse toujours avec `autoResolve: true`, bouton manuel « push » exclu, `autoResolve` absent), `attemptAutoMergeResolution` prend le relais : le travail local est d'abord sauvegardé sur une branche jetable `auto/<branche>-conflict-<ts>` poussée sur GitHub (aucune perte, quoi qu'il arrive ensuite), une session Claude dédiée (`tools: 'default'`, cwd = workspace, mid-merge, `SessionKind`/`UsageKind` `'merge_resolve'`) tente de résoudre les marqueurs et de committer (`git add -A && git commit --no-edit`), puis `verifyStack` (install+build+test, `pipeline/verify.ts`) valide le résultat AVANT tout fast-forward de `<branche>` — seul un merge qui compile et passe les tests atteint `main`. Si une étape échoue (session non aboutie, ou vérification rouge), `<branche>` locale reste intacte et l'erreur HTTP 409 nomme la branche de secours pour revue manuelle (le commentaire GitHub posté par `finalizeFixing` la reprend telle quelle). Aucun changement de contrat HTTP : `POST /projects/:id/github/generate-ci` renvoie toujours `{ ok: true, status: 'queued' | 'generated' }`.

`claude/sessionArgs.ts` `buildArgs(spec, caps): { argv: string[]; mcpConfigPath: string | null }` — `--strict-mcp-config` est TOUJOURS émis ; si `spec.mcpConfig` est fourni, un fichier JSON temporaire (`os.tmpdir()`, `0600`) listant uniquement ces serveurs est écrit et passé via `--mcp-config <path>` (allowlist explicite, jamais un config projet/utilisateur). `runner.ts` supprime ce fichier à la fermeture du process (best-effort).

`pipeline/integrations.ts` (T09/T10/T11, issue #8) : `context7Mcp(deps)`, `exaMcp(deps)`, `memoryMcp(deps)` → `{ mcpConfig, tools: ['mcp__<serveur>__*'] } | null`. `null` tant que `SettingsDto.integrations` n'active pas l'intégration OU que la clé correspondante est absente de `<dataDir>/.env` (lue via `access/envFile.ts` `readEnvValues`, jamais exposée par HTTP). Branché uniquement sur `architecture`/`task_breakdown` (context7), `design_benchmark` (EXA), cadrage (mémoire — un seul provider actif à la fois, jamais mem0 ET supermemory ensemble).

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

## Relais d'aperçu (`preview/previewProxy.ts`)

Second écouteur HTTP, actif seulement si `PJGEN_PREVIEW_PORT` est défini (lié sur `PJGEN_HOST`). `PJGEN_PREVIEW_PUBLIC_PORT` = port vu par le navigateur quand un frontal (tailscale serve…) le publie ailleurs (défaut : `PJGEN_PREVIEW_PORT`). Toute l'origine appartient à l'appli prévisualisée (les serveurs de dev émettent des chemins absolus) ; seules les routes `/__pjgen/*` sont à pj-gen :
- `GET /__pjgen/preview/:projectId` → cookie `pjgen_preview=p:<id>` + 302 `/` : relaie vers l'URL détectée de l'appli en cours (`AppRunner.state(id).url`), suivie à chaque requête.
- `GET /__pjgen/port/:n` → cookie `pjgen_preview=port:<n>` + 302 `/` : relaie vers `localhost:<n>` (refusé : le port du relais et celui de pj-gen).
- `GET /__pjgen/` → page d'index (aperçus en cours, saisie d'un port).
Requêtes et upgrades (WebSocket HMR) relayés avec `Host`/`Origin` réécrits en `localhost:<port>` (Vite ≥5.4.12 refuse un Host inconnu), `X-Forwarded-Host` conservé, cookie `pjgen_preview` retiré, `Location` absolue vers le serveur de dev rendue relative. Le cookie ne distingue pas les ports : deux onglets sur deux aperçus différents se le partagent, la dernière sélection gagne.

