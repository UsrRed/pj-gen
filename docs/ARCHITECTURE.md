## Vue d'ensemble

Monorepo npm workspaces à 3 paquets : `shared/` (types partagés), `server/` (Fastify + better-sqlite3 + SSE, orchestrateur du pipeline `claude -p`), `web/` (React 19 + Vite + Tailwind 4). Données persistées dans SQLite (WAL) sous `~/.pj-gen/db.sqlite` ; projets générés vivent sous `~/pj-workspace/<slug>/` (dépôts git indépendants).

```
pj-gen/
├── shared/src/          types, statuses/transitions, events SSE, access
├── server/src/
│   ├── index.ts          bootstrap (lock, container, auth, scheduler, HTTP)
│   ├── config.ts          Config depuis env (PJGEN_*)
│   ├── container.ts       DI: assemble repos/bus/runner/engine/scheduler/services
│   ├── core/               bus événements, mutex, state machine, quota tracker, sessionPool, notifier, lanExposure, toolEnv, lockfile
│   ├── db/                 better-sqlite3, migrations versionnées, repos par domaine
│   ├── claude/              invocation du binaire claude (réel + fake), parsing NDJSON, classification d'échec, capacités
│   ├── pipeline/            Engine (boucle d'étapes), Scheduler (FIFO+quota), steps.ts (12 étapes), sizing, taskBatch, worktree, workspace, verify
│   ├── prompts/             construction de prompts (steps.ts) + schémas zod de sortie structurée (schemas.ts)
│   ├── cadrage/             ChatService (dialogue), SpecService (génération/validation SPEC)
│   ├── deploy/              DeployService (gate HITL)
│   ├── micro/               MicroService (micro-modifications)
│   ├── github/               GithubService (gh CLI), IssuePoller, issueAssets
│   ├── access/               envFile (.env sécurisé, par workspace ET global via dataDir), integrationSecrets, accessTest (SSH/DNS)
│   ├── preview/               AppRunner (exécute le projet généré), PreviewProxy (relais d'aperçu)
│   ├── console/               ConsoleService (shell persistant node-pty pour l'onglet Console)
│   └── http/                  app Fastify, routes, SSE
├── server/assets/skills/    bundle de skills (issue #8) copié dans .claude/skills/ de chaque workspace généré (WorkspaceManager.writeBundledSkills)
└── web/src/
    ├── App.tsx               shell + routing (react-router)
    ├── store/useStore.ts      état global zustand (SSE-driven)
    ├── api/client.ts          client REST typé + api/sse.ts (EventSource)
    ├── pages/                  Dashboard, Project, Settings, Stats, Github, Issue, Console (xterm.js)
    └── components/             panels (Chat, Pipeline, Artifacts, Deploy, Access, App, Quota…)
```

## Flux de données principal

1. **Création** (`POST /api/projects`) → `WorkspaceManager.create` (git init + identité UsrRed + hook attribution + `CLAUDE.md`) → insertion DB (`draft`) → `ChatService.runCadrageTurn` (async, hors slot).
2. **Cadrage** → tours de chat successifs (`SessionSpec` avec `tools: 'none'`, sortie structurée `CadrageReplyZ`) jusqu'à `ready_for_spec` → `SpecService.generateSpec` (session avec `SpecOutputZ`) écrit `docs/SPEC.md` → `validateSpec` fige `size`/`spec_sha256`, transition `spec_ready → queued`.
3. **Scheduler.tick** (toutes les `schedulerTickMs`) : admet les projets `queued`/`paused_limit` dans la limite de `maxConcurrentBuilds` ET de `SessionPool.available`, transition CAS `→ building`, lance `Engine.runProject` avec un `AbortController`.
4. **Engine.runProject** parcourt `PIPELINE_ORDER` (ou `MICRO_PIPELINE_ORDER`), saute les étapes du profil de gabarit (`sizing.ts`), appelle la fonction d'étape correspondante (`pipeline/steps.ts`) via `runGenerationStep` (génération JSON, `--tools ""`) ou `runToolStep` (outillé, `--dangerously-skip-permissions`, vérif install/build/test).
5. Chaque exécution passe par `executeClaudeRun` (`pipeline/stepRunner.ts`) : crée une ligne `step_runs`, spawn via `runner` (réel `claude/runner.ts` ou fake `claude/fakeRunner.ts`), bufferise les logs NDJSON vers SQLite + SSE, détecte les limites d'usage (`claude/failure.ts`), notifie le `Scheduler` (parking/reprise).
6. **Parallélisme** : `runBatch`/`runInWorktree` créent des `git worktree` isolés par tâche, fusionnent sous `KeyedMutex`, requeue en série en cas de conflit.
7. **Fin de pipeline** → `awaiting_deploy_approval` → `DeployService.approve`/`runTurn` (session conversationnelle `--resume`) → `markDeployed`.
8. **Événements** : toute mutation d'état émet sur le `Bus` (append-only en DB `events`) → rediffusé via SSE (`/api/events`, `/api/projects/:id/events`) avec rejeu `Last-Event-ID` → le store zustand du front met à jour l'UI en direct.
9. **Quota 5h** : chaque `rate_limit_event` du flux alimente `usageTracker` ; en cas de limite, `Scheduler.notifyQuotaLimit` arme un timer de reprise (avec jitter) qui relance `--resume <session>` à l'heure de reset.

## Dépendances réelles

- **Serveur** : `fastify` (+`@fastify/cors`,`@fastify/static`), `better-sqlite3`, `node-pty` (natif, compilé dans l'étage builder de l'image), `zod`, `@pjgen/shared` (workspace). Dev : `tsx`, `typescript`, `vitest`.
- **Web** : `react`/`react-dom` 19, `react-router-dom` 7, `zustand` 5, `react-markdown`, `@xterm/xterm` (+`addon-fit`, `addon-web-links`). Dev : `vite` 7, `@vitejs/plugin-react`, `tailwindcss` 4 (+`@tailwindcss/vite`), `typescript`, `vitest` (+`jsdom`, `@testing-library/react`, `@testing-library/jest-dom`) pour les tests de composants/logique client (`web/test/*.test.{ts,tsx}`).
- **Racine** : `concurrently` (dev orchestration `dev`/`dev:fake`).
- Binaires externes invoqués via `execFile`/`spawn` : `claude` (CLI Claude Code), `git`, `gh` (GitHub CLI), `xdg-open` (ouverture dossier hôte, best-effort).
- Aucune base de données externe : SQLite fichier unique en WAL, migrations versionnées via `PRAGMA user_version` (`db/migrations.ts`, v1→v14).

## Points d'entrée / scripts

- `npm run dev` / `dev:fake` (racine) : `server` (`tsx watch`) + `web` (`vite`) en parallèle via `concurrently`.
- `npm run build` : build du frontend (`web/dist`), servi statiquement par Fastify en prod (`http/app.ts`).
- `npm start` / `start:fake` : lance uniquement le serveur (`tsx src/index.ts`), qui sert aussi `web/dist` s'il existe.
- `npm test` : `vitest run` dans `server/` (tests d'intégration sur fixtures NDJSON réelles enregistrées, machine à états, scheduler, recovery, jail de chemins — voir `server/test/*.test.ts` et `server/fixtures/ndjson/*`), puis `vitest run` dans `web/` (jsdom, logique client et composants — `web/test/*.test.{ts,tsx}`).
- `npm run typecheck` : `tsc --noEmit` server + web.
- Mode simulation (`PJGEN_FAKE_CLI=1`) : `claude/fakeRunner.ts` remplace tout appel réel — utile pour tester l'UI/pipeline sans consommer de quota.
