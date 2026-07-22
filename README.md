# pj-gen — Générateur de projets autonome (claude -p, abonnement)

pj-gen pilote le CLI **Claude Code** en mode headless (`claude -p`) via ton **abonnement** (OAuth — jamais de clé API) pour générer des projets logiciels complets :

1. **Cadrage interactif** — tu donnes un prompt initial, une session claude pose ses questions dans un chat, puis une **SPEC** est générée et validée par toi.
2. **Construction 100 % autonome** — architecture → découpage en tâches → scaffolding → implémentation tâche par tâche → durcissement des tests → revue/corrections → documentation → vérification finale. Chaque étape est une session `claude -p` **fraîche avec un contexte minimal** (économie de tokens : l'état vit dans des fichiers `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/tasks.json`, pas dans la conversation).
3. **Gate de déploiement HITL** — le pipeline s'arrête à « prêt à déployer » ; tu approuves dans l'UI, fournis les consignes, et une session assistée exécute le déploiement.
4. **Reprise automatique de la limite 5 h** — quand le quota d'abonnement est atteint, le build est parqué avec l'heure de reset exacte (événement `rate_limit_event` du stream, avec fallback sur les motifs texte), puis **reprend tout seul** via `claude -p --resume <session>`.
5. **File d'attente** — cadrage illimité en parallèle ; **2 builds simultanés max** (réglable 1–4), FIFO pour les autres.

Interface web (français) : dashboard (slots actifs, file, quota), page projet (chat de cadrage, pipeline avec logs temps réel, artefacts, déploiement), réglages. La consommation affichée est en **tokens** (total par projet et par run, détail entrée/sortie/cache au survol) — pas en dollars : en abonnement, ce sont les tokens qui comptent pour la limite 5 h. Le garde-fou `--max-budget-usd` des réglages reste un simple cap de sécurité par session.

## Prérequis

- Node.js ≥ 22, npm
- CLI `claude` installé **et connecté à l'abonnement** (`claude auth status` doit être OK) — testé avec 2.1.214
- git

## Installation & démarrage

```bash
cd ~/pj-gen
npm install
npm run build          # build du frontend (web/dist, servi par le serveur)
npm start              # démarre sur http://127.0.0.1:4310
```

Mode **simulation** (aucun appel claude réel, pour tester l'UI et le pipeline) :

```bash
npm run start:fake
```

Développement (serveur watch + vite dev sur :5173) : `npm run dev` (ou `npm run dev:fake`).
Tests : `npm test` (46 tests — parsing NDJSON sur streams réels enregistrés, détection de limite, machine à états, scheduler, recovery, jail de chemins).

## Utilisation

1. **Nouveau projet** → titre + prompt initial (+ modèle : opus par défaut, ou sonnet).
2. Onglet **Cadrage** : réponds aux questions, puis **« Générer le SPEC »** ; relis-le dans **Artefacts**, ajuste par le chat si besoin.
3. **« Valider et lancer la construction »** → le projet entre en file, se construit tout seul (suivi temps réel dans **Pipeline**).
4. À la fin : onglet **Déploiement** → consignes → **« Approuver le déploiement »** → chat avec la session de déploiement → **« Marquer comme déployé »**.

Les projets générés vivent dans `~/pj-workspace/<slug>/` : dépôt git propre, commits atomiques par tâche, `docs/` complet.

### Maquette : automatique par défaut, Claude Design en option

Le pipeline commence par une étape **« Maquette » 100 % autonome** : une session génère la maquette de référence (HTML autonome + système de design dans `docs/design/`) à partir de la SPEC — aucun HITL ; les projets sans interface visuelle (CLI/API) sont détectés et l'étape se saute. Optionnellement, la section « 🎨 Maquette » (création et itérations) permet de coller un **export HTML/React de Claude Design** (claude.ai/design) et/ou son URL : il **remplace** alors la génération automatique. La maquette devient la **référence visuelle contractuelle** du build : stockée dans `docs/design/` du workspace, imposée via le CLAUDE.md du projet, intégrée au prompt d'architecture (extrait inline), à la finition UX, et **vérifiée par l'audit de conformité** (écart visuel majeur = non conforme). Note : la commande CLI `/design` ne sert qu'au consentement de l'intégration Claude Design (`/design consent|revoke`) — le handoff par export est la voie fiable.

### Itérations d'amélioration

Un projet terminé (déployé, prêt à déployer, en échec ou annulé) peut être **rouvert** : bouton « 🔄 Améliorer » → décris les révisions → cadrage du delta (le chat connaît la SPEC actuelle) → SPEC révisée (section « Révision N ») → validation → le projet **rejoint la file autonome**. Le build d'itération est incrémental : architecture mise à jour (pas redessinée), scaffold sauté, seules les **nouvelles tâches** (T18, T19…) sont implémentées — puis finition, revue et audit de conformité repassent sur le produit complet. Tu peux ainsi enfiler le soir une série de builds et d'améliorations qui tourneront toute la nuit à travers les fenêtres de quota (reprise automatique).

### Jauge de la fenêtre 5 h & statistiques

Le stream émet un `rate_limit_event` à **chaque** requête : pj-gen en déduit la fenêtre d'abonnement en cours et affiche en permanence sur le dashboard « Fenêtre 5 h : X tokens · reset HH:MM ». Dès qu'une limite a été rencontrée au moins une fois, un **plafond estimé** (médiane des consommations aux derniers hits) ajoute un pourcentage et une barre de progression colorée. La page **📊 Stats** détaille la consommation par jour (14 jours), par étape du pipeline (repère les étapes gourmandes) et par projet.

### Notifications (webhook / ntfy)

Réglages → Notifications : une URL compatible **ntfy.sh** (ex. `https://ntfy.sh/mon-topic-secret`, app mobile ntfy pour recevoir sur téléphone) ou n'importe quel webhook POST. Trois événements, activables séparément : **prêt à déployer**, **échec définitif**, **reprise de la file après reset du quota**. Bouton « Envoyer un test » intégré. Idéal pour la queue nocturne : tu sais au réveil ce qui t'attend.

### Aperçu — tester le projet généré

Onglet **Aperçu** d'un projet : lance le `run_cmd` du stack dans le workspace (précédé de l'install si `node_modules` manque), streame les logs en direct, détecte l'URL locale (`http://localhost:…`) et la rend cliquable. Arrêt propre (SIGTERM groupe), garde-fou 2 h, et sweep au démarrage des process orphelins d'une session précédente.

## Quota / limite 5 h

- Chaque session émet un `rate_limit_event` avec l'epoch de reset exact ; en cas de limite atteinte : run parqué (`paused_limit`), état global mémorisé, timer armé, reprise automatique de **la même session** au reset (FIFO conservé). Fallback : motifs texte (`usage limit reached|<epoch>`, « 5-hour limit reached ∙ resets 3am »…) puis sonde toutes les 30 min (une tentative sous limite échoue instantanément et ne coûte rien).
- Le chat de cadrage n'est pas limité par les slots ; si le quota est épuisé, un message l'indique avec l'heure de reprise (+ bouton « Réessayer maintenant »).
- Bandeau quota visible sur tout le dashboard.

## Réglages (UI)

Concurrence (1–4), modèle par défaut (opus/sonnet, surchargeable par projet et par étape), reprise auto au démarrage, skip du durcissement de tests, budget garde-fou par session (`--max-budget-usd`), caps tours/durée par étape (la CLI n'a plus `--max-turns` : le superviseur compte les tours du stream et coupe au-delà).

## Garanties d'attribution

Les commits des projets générés sont **authored `UsrRed <redefendeur@gmail.com>`**, sans aucune mention Claude/Anthropic :
git config + env `GIT_AUTHOR/COMMITTER_*`, `--settings '{"includeCoAuthoredBy":false}'`, hook `commit-msg` qui strip les trailers interdits, et audit bloquant en vérification finale.

## Détails techniques

- Monorepo npm workspaces : `shared/` (types), `server/` (Fastify + better-sqlite3 + SSE), `web/` (React + Vite + Tailwind).
- Données : `~/.pj-gen/db.sqlite` (WAL). Événements append-only rejoués via SSE `Last-Event-ID` (l'UI ne rate rien après une coupure).
- Chaque session spawnée : `--output-format stream-json --verbose`, `--session-id`/`--resume`, `--strict-mcp-config` (zéro serveur MCP), `--setting-sources project,local` (tes réglages utilisateur ne fuient pas dans les runs), env épuré (pas d'`ANTHROPIC_API_KEY` → OAuth abonnement), prompt passé par stdin.
- Étapes « génération » (architecture, découpage, SPEC, cadrage) : `--tools ""` + `--json-schema` (sortie structurée validée zod), l'orchestrateur écrit les fichiers lui-même — zéro token d'outillage.
- Étapes « outillées » : `--dangerously-skip-permissions`, cwd = workspace du projet, vérification réelle après chaque étape (install/build/test + présence de commit).
- Crash de pj-gen : lockfile pid, sweep des process orphelins au boot (`/proc/<pid>/cmdline` doit contenir l'UUID de session avant kill), re-mise en file automatique (garde anti crash-loop), reprise de la session interrompue.

## Lancer au démarrage (systemd)

`/etc/systemd/system/pj-gen.service` :

```ini
[Unit]
Description=pj-gen - generateur de projets autonome
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/pj-gen
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
Environment=PJGEN_HOST=127.0.0.1
Environment=PJGEN_PORT=4310

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pj-gen
```

L'UI est bindée sur `127.0.0.1` (pas d'authentification) : pour y accéder à distance, passe par un tunnel SSH (`ssh -L 4310:127.0.0.1:4310 …`) ou mets un reverse proxy avec auth devant.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PJGEN_HOST` / `PJGEN_PORT` | `127.0.0.1` / `4310` | Écoute HTTP |
| `PJGEN_WORKSPACE_ROOT` | `~/pj-workspace` | Racine des projets générés |
| `PJGEN_DATA_DIR` | `~/.pj-gen` | Base SQLite + lockfile |
| `PJGEN_CLAUDE_BIN` | `claude` | Binaire claude |
| `PJGEN_FAKE_CLI` | — | `1` = mode simulation |

## Limitations connues

- Une seule instance à la fois (lockfile) ; l'état de quota est global au compte.
- Le déploiement assisté dépend de ce que la machine peut atteindre (credentials à fournir via `.env` dans le workspace, jamais dans le chat).
- Si Anthropic change le format du stream, les lignes brutes sont conservées en base et une alerte de version s'affiche au boot ; `scripts/record-fixture.ts` ré-enregistre des fixtures réelles (~3 micro-sessions sonnet).
