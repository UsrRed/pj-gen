## Objectif

pj-gen pilote le CLI **Claude Code** en mode headless (`claude -p`), via l'**abonnement** de l'utilisateur (OAuth — jamais de clé API), pour générer des projets logiciels complets de bout en bout : cadrage interactif → SPEC validée → construction 100 % autonome (architecture, découpage en tâches, implémentation, durcissement, revue, documentation, vérification) → gate de déploiement supervisé par un humain (HITL). L'outil gère lui-même la reprise après une limite d'abonnement de 5 h, une file d'attente de builds, le parallélisme de tâches indépendantes, et propose une interface web en français pour piloter le tout.

## Fonctionnalités

### F1 — Cadrage interactif et génération de SPEC
- Un nouveau projet se crée avec un titre + un prompt initial (+ modèle opus/sonnet, + gabarit optionnel).
- Une session `claude -p` (`ChatService.runCadrageTurn`) mène un dialogue de cadrage (max 5 questions), identifie l'inventaire des accès nécessaires, propose un gabarit de projet et un score `ready_for_spec`.
- Critère d'acceptation : `POST /api/projects` crée un projet en statut `draft`, lance un premier tour de cadrage ; `POST /api/projects/:id/generate-spec` produit `docs/SPEC.md` (`SpecService.generateSpec`) validé par schéma zod (`SpecOutputZ`) ; `POST /api/projects/:id/validate-spec` fige le SPEC et le gabarit, passe le projet en `spec_ready`.

### F2 — Construction autonome par pipeline d'étapes
- Pipeline ordonné (`PIPELINE_ORDER`) : `design_benchmark → design → architecture → task_breakdown → scaffold → implement_task → polish → test_hardening → review_fix → feature_check → docs → final_verify`.
- Chaque étape est une session `claude -p` **fraîche**, contexte minimal — l'état persiste dans `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/tasks.json` du workspace, pas dans la conversation.
- Étapes « génération » (`architecture`, `task_breakdown`, `design`, etc.) : `--tools ""` + sortie JSON structurée validée par zod (`server/src/prompts/schemas.ts`), l'orchestrateur écrit les fichiers.
- Étapes « outillées » (`scaffold`, `implement_task`, `polish`, `test_hardening`, `review_fix`, `feature_check`, `docs`, `final_verify`) : `--dangerously-skip-permissions`, vérification réelle (install/build/test + présence de commit) après chaque étape.
- Critère d'acceptation : `POST /api/projects/:id/validate-spec` fait passer le projet en `queued`, le `Scheduler` l'admet en `building` dès qu'un slot est libre, `Engine.runProject` exécute les étapes dans l'ordre jusqu'à `awaiting_deploy_approval`.

### F3 — Découpage en tâches en graphe (pas une liste)
- L'architecte produit des tâches `T01..Tn` avec trois relations distinctes : `depends_on` (contrat), `after` (ordre produit), `phase` (`foundation`/`core`/`polish`).
- `checkTaskDag` rejette tout découpage à cycle ou pointant vers une phase postérieure.
- Critère d'acceptation : `docs/tasks.json` contient un graphe validé ; `topoOrder`/`readySet`/`pickBatch` (`pipeline/taskBatch.ts`) calculent les tâches prêtes en respectant dépendances + ordre + barrière de phase.

### F4 — Parallélisme des tâches indépendantes
- Les tâches indépendantes aux `writes` disjoints (hors chemins « chauds » comme `package.json`) s'exécutent simultanément, chacune dans un `git worktree` isolé (`pjgen/<taskKey>`), fusionnées dans `main` au fil de l'eau (`WorktreeManager`).
- Un conflit de fusion ou une régression après fusion ne fait jamais échouer le build : la tâche est requeue seule sur un `main` à jour.
- Critère d'acceptation : réglage `taskParallelism` (1–4, piloté par le gabarit) ; `runBatch`/`runInWorktree` dans `pipeline/steps.ts` orchestrent le tout sous un `KeyedMutex` pour le merge.

### F5 — Gabarit de projet (sizing)
- Quatre tiers (`small`, `mvp`, `large`, `enterprise`) définis dans `pipeline/sizing.ts` : budget de tâches, multiplicateur de caps (tours/durée), parallélisme, étapes sautées, routage de modèles, garde-fous de périmètre injectés dans les prompts.
- Figé à la validation du SPEC ; un cap ou modèle réglé à la main n'est jamais écrasé par le gabarit.
- Critère d'acceptation : `PATCH /api/projects/:id` refuse de changer `size` hors statut `draft`/`spec_ready` (409) ; les profils sont surchargeables via `SettingsDto.sizeProfiles`.

### F6 — Gate de déploiement supervisé (HITL)
- Le pipeline s'arrête à `awaiting_deploy_approval`. L'utilisateur fournit des consignes (`notes`) et approuve (`POST /api/projects/:id/approve-deploy`) → `DeployService` lance une session de déploiement conversationnelle (`--resume` entre tours de chat) → `POST /api/projects/:id/mark-deployed` clôt en `deployed`.
- Critère d'acceptation : `DeployService.approve`/`runTurn`/`markDeployed` gèrent le cycle ; les accès requis doivent être fournis (sauf marqués « non nécessaires »).

### F7 — Reprise automatique de la limite 5 h (quota d'abonnement)
- Chaque session émet un `rate_limit_event` (epoch de reset exact) capté par `claude/ndjson.ts`/`claude/failure.ts` ; en cas de limite : le run est marqué `paused_limit`, le projet aussi, un timer (`Scheduler.armResumeTimer`, avec jitter) reprend automatiquement **la même session** via `--resume` au reset.
- Fallback texte (`usage limit reached|<epoch>`, motifs FR/EN) si l'événement structuré manque.
- Critère d'acceptation : `usageTracker.recordLimitHit`/`quota` repo persistent l'état ; `GET /api/quota` expose `QuotaDto` (fenêtre courante, plafond estimé, coupe programmée) ; `POST /api/quota/probe` force une tentative immédiate.

### F8 — File d'attente et concurrence
- Cadrage illimité en parallèle (pas de slot) ; builds limités par `maxConcurrentBuilds` (1–4, défaut 2) sous un plafond global `maxConcurrentSessions` (1–8, défaut 4) partagé avec les batches parallèles internes (`SessionPool`).
- Critère d'acceptation : `Scheduler.tickInner` n'admet un projet `queued`/`paused_limit` que si un slot **et** une session du pool sont libres ; FIFO par ordre d'`enqueued_at`.

### F9 — Accès & secrets
- Le cadrage identifie les accès nécessaires (SSH, domaine, base, clé API, SMTP, stockage objet) dans un inventaire typé (`AccessDto`, table `project_access`).
- Valeurs **non secrètes** en base, alimentent les prompts d'architecture/déploiement. Valeurs **secrètes** jamais en base/API/chat : écrites directement dans le `.env` du workspace (0600, gitignored) ; le schéma DB et la validation zod rejettent tout champ nommé comme un secret.
- Pour SSH : hôte/utilisateur/port/chemin de clé locale uniquement (jamais la clé elle-même). Bouton « Tester la connexion » (`POST /api/projects/:id/access/:accessId/test`, SSH+DNS via `access/accessTest.ts`).
- Critère d'acceptation : `docs/ACCESS.md` commité avec noms de variables (jamais de valeurs) ; validation du SPEC avertit si accès manquants, approbation du déploiement les exige.

### F10 — Maquette (design) automatique ou Claude Design
- Étape `design` 100 % autonome par défaut : génère `docs/design/mockup.html` + `NOTES.md` depuis le SPEC (les projets sans interface CLI/API détectent l'inapplicabilité via `DesignOutputZ.applicable`).
- Optionnellement, un export HTML/React de Claude Design (contenu ou URL, champs `designContent`/`designUrl`) **remplace** la génération auto lors de la création ou d'une réouverture (`WorkspaceManager.writeDesignReference`).
- Devient référence visuelle contractuelle : imposée via `CLAUDE.md`, injectée aux prompts d'architecture/polish, vérifiée par l'audit de conformité (`feature_check`).
- Critère d'acceptation : réglage `designBenchmark` (global + par projet, null = suit le global) contrôle l'étape `design_benchmark` (benchmark web optionnel, non bloquant).

### F11 — Itérations d'amélioration (réouverture)
- Un projet terminé (`awaiting_deploy_approval`, `deployed`, `failed`, `canceled` — `REOPENABLE_STATUSES`) se rouvre via `POST /api/projects/:id/reopen` : cadrage du delta, SPEC révisée (« Révision N »), architecture mise à jour (pas redessinée), scaffold sauté, seules les nouvelles tâches (`T18`, `T19`…) sont implémentées.
- Critère d'acceptation : `iteration` s'incrémente ; `checkTaskDagAppend` valide le delta ; `stepArchitecture` bascule sur `archUpdatePrompt` si `iteration > 1`.

### F12 — Micro-modifications live
- Un changement ponctuel décrit en langage naturel devient une tâche unique via une session structurée (`MicroTaskZ`), exécutée par un pipeline réduit (`MICRO_PIPELINE_ORDER = [implement_task, final_verify]`), sans repasser tout le cycle.
- Source `manual` (bouton UI) ou `issue` (GitHub, via `IssuePoller`), avec statuts `pending/task_created/done/failed/needs_clarification`.
- Critère d'acceptation : `POST /api/projects/:id/micro` crée un `MicroRequestDto` ; `Engine` détecte `pipeline_mode = 'micro'` et raccourcit l'ordonnancement ; les demandes issues d'une issue GitHub sont traitées comme « untrusted » dans le prompt.

### F13 — Intégration GitHub (gh CLI)
- Vue `/github` : dépôts distants × projets locaux, trois catégories (`remote_only`, `local_unpublished`, `linked`), état de synchronisation `ahead/behind`.
- Publier (`link`), pousser (`push`), générer une CI (`generate-ci`), cloner un dépôt distant existant comme nouveau projet (`clone` → `WorkspaceManager.adoptClone`), mode auto (issues → micro-modification → déploiement automatique si dépôt privé).
- Poller d'issues (`IssuePoller`, intervalle réglable) filtré par utilisateurs de confiance (`trusted_users`).
- Critère d'acceptation : authentification déléguée au keyring `gh` (jamais de token en base) ; `GithubService.status/listRemoteRepos/linkProject/push/generateCi/syncState`.

### F14 — Notifications
- Webhook compatible ntfy.sh ou POST générique, trois événements activables séparément : `deployReady`, `buildFailed`, `quotaResumed`.
- Critère d'acceptation : `Notifier` s'abonne au `Bus`, `POST /api/settings/notify-test` envoie un test.

### F15 — Aperçu (exécution du projet généré)
- Lance le `run_cmd` du stack détecté dans le workspace (précédé d'un install si `node_modules` manque), streame les logs, détecte et rend cliquable l'URL locale.
- Arrêt propre (SIGTERM groupe), garde-fou 2 h, sweep des process orphelins au démarrage (`AppRunner.sweepOrphans`).
- Critère d'acceptation : `GET/POST /api/projects/:id/app`, `/app/start`, `/app/stop` ; état persistant en base (`app_runs`).

### F16 — Statistiques et jauge de quota
- Dashboard : bandeau quota en tout temps (« Fenêtre 5 h : X tokens · reset HH:MM », plafond estimé une fois une limite déjà rencontrée).
- Page Stats : consommation par jour (14 j), par étape (repère les étapes gourmandes), par projet, temps par étape (médiane/p90), taux de cache.
- Critère d'acceptation : `GET /api/stats` retourne `StatsDto` calculé par `db/repos/usage.ts`.

### F17 — Réglages opérateur
- Concurrence, plafond de sessions, parallélisme de tâches, modèle par défaut (+ par étape, + par projet), reprise auto au démarrage, skip du durcissement de tests, budget garde-fou `--max-budget-usd`, caps tours/durée par étape, visibilité GitHub par défaut, intervalle de poll d'issues, LAN exposure, profils de gabarit personnalisés.
- Critère d'acceptation : `GET/PATCH /api/settings` (`SettingsDto`, validé par `SettingsPatchZ`).

### F18 — Attribution garantie des commits
- Tous les commits des workspaces générés sont `authored UsrRed <redefendeur@gmail.com>`, sans mention Claude/Anthropic : config git + env `GIT_AUTHOR/COMMITTER_*` sur chaque appel git, `--settings '{"includeCoAuthoredBy":false}'` sur les sessions claude, hook `commit-msg` qui strip les trailers interdits, audit bloquant à `final_verify`.

## Contraintes techniques

- Authentification exclusivement par abonnement OAuth (`claude auth status`) — jamais de clé API (`ANTHROPIC_API_KEY` retirée de l'environnement des sessions spawnées).
- Chaque session : `--output-format stream-json --verbose`, `--session-id`/`--resume`, `--strict-mcp-config` (zéro serveur MCP), `--setting-sources project,local`, prompt passé par stdin, `--dangerously-skip-permissions` pour les étapes outillées uniquement.
- Une seule instance de pj-gen à la fois (lockfile PID) ; état de quota global au compte.
- UI bindée sur `127.0.0.1` par défaut, aucune authentification HTTP — accès distant via tunnel SSH ou reverse proxy externe.
- Le CLI n'a plus `--max-turns` : le superviseur compte les tours du flux NDJSON et coupe lui-même (`maxTurns`/`timeoutMs`).
- Génération / mutation de fichiers workspace strictement confinée sous `workspaceRoot` (`assertInside`, jail anti-traversal testé).
- Caches de dépendances mutualisés entre workspaces (npm/pnpm/yarn/pip/uv/go/cargo), `CI=1` posé systématiquement.

## Hors périmètre

- Pas de multi-tenant / authentification utilisateur de l'UI pj-gen elle-même.
- Pas de clé API Anthropic en fallback — dépendance stricte à l'abonnement CLI.
- Pas de gestion de secrets pour le déploiement au-delà de l'écriture `.env` locale (pas de vault externe).
- Pas d'exécution multi-instance / multi-hôte de l'orchestrateur (lockfile mono-process).

## Micro-révisions
- T15 (2026-08-27): Issue GitHub #14 de @UsrRed — issue security Lors de la prise en compte de l'issue en github auto ajoute un prompt isolé afin de déterminé si l'objectif est de nuire au pj-gen ou au pc de build, introduire une backdoor ou tout autre demande malsaine, mais ne bloque pas des implémentation propre à l'
- T14 (2026-08-27): Issue GitHub #12 de @UsrRed — github auto La liste des element geré par github en auto / traitement des issue peut etre vue en detail mais par défaut n'affiche que les 3 dernier elements avec en priorité ceux en cours puis en file et les corrigé ensuite. Fil de commentaires de l'issue (les réponses 
- T13 (2026-08-27): Issue GitHub #10 de @UsrRed — fix [pj-gen] erreur route POST /api/projects/ee2c18b4-7020-4527-8a93-f6e4c46e94e6/github/generate-ci Error: Command failed: git push origin HEAD To github.com:UsrRed/immo-paper.git ! [rejected] HEAD -> main (non-fast-forward) error: failed to push some refs to 'github.c
- T12 (2026-08-27): Issue GitHub #15 de @UsrRed — design improve Ajoute des animation bouton fluide, des element de decors et autre pour faire site web très moderne. Tu peux revoir l'affichage pour reograniser de manière plus design.
- T11 (2026-08-27): Issue GitHub #14 de @UsrRed — issue security Lors de la prise en compte de l'issue en github auto ajoute un prompt isolé afin de déterminé si l'objectif est de nuire au pj-gen ou au pc de build, introduire une backdoor ou tout autre demande malsaine, mais ne bloque pas des implémentation propre à l'
- T10 (2026-08-27): Issue GitHub #13 de @UsrRed — Ajoute au github auto lors de l'ajout d'une implementation, ajoute quand même une petite partie dans la pipeline permettant d'assurer les test, la doc etc..
- T09 (2026-08-27): Issue GitHub #12 de @UsrRed — github auto La liste des element geré par github en auto / traitement des issue peut etre vue en detail mais par défaut n'affiche que les 3 dernier elements avec en priorité ceux en cours puis en file et les corrigé ensuite. 
- T08 (2026-08-27): Issue GitHub #11 de @UsrRed — generation CI La generation de CI doit fonctionner en ajoutant simplement la task, ainsi même sans token la tasks sera programmé pour plus tard
- T07 (2026-08-25): Issue GitHub #10 de @UsrRed — fix [pj-gen] erreur route POST /api/projects/ee2c18b4-7020-4527-8a93-f6e4c46e94e6/github/generate-ci Error: Command failed: git push origin HEAD To github.com:UsrRed/immo-paper.git ! [rejected] HEAD -> main (non-fast-forward) error: failed to push some refs to 'github.c
- T06 (2026-08-25): Issue GitHub #9 de @UsrRed — Tache git non bloqué Ne bloque pas une requete car elle ne passe pas en micro modification, je veux que ca puisse etre gerer au dela d'une micro modification, au depart tu determine la taille et ensuite tu t'y applique, si ça bloque pour cette raison alors recycle avec u
- T05 (2026-08-24): Issue GitHub #7 de @UsrRed — github auto Le mode auto de github doit pouvoir lancer des modification plsu grosse que juste des micro-modifications Biensur si c'est une plus grosse alors on repasse dans la pipeline pour bien mettre a jour la doc, faire des tests etc.. 
- T04 (2026-08-24): Issue GitHub #6 de @UsrRed — github issue Ajoute lorsque une issue est prise en compte, informe l'utilisateur avec un commentaire sur la page github.
- T03 (2026-08-24): Issue GitHub #4 de @UsrRed — test front ajouter dans le pipeline des tests reel utilisateur, par exemple si un site web avec un front, simuler les vrai clic, l'experience utilisateur etc pour verifier que si les info donne sont mauvaise l'erreur remonte proprement, que l'utilisateur sais ce dont il 
- T02 (2026-08-24): Issue GitHub #2 de @UsrRed — gh inverse inverser la liste des issue prise en compte, prendre le 1 puis le 2 puis le 3 etc...
- T01 (2026-08-24): Issue GitHub #3 de @UsrRed — never trust user entry ne jamais croire l'entree utilisateur ajouter des test en pipeline pour tester si on met les mauvaises information que ca se comporte correctement 
