# Maintenance de pj-gen (session « Débloquer »)

Lu par la session claude lancée depuis le bouton **🛠 Débloquer** (onglet Console). Tu tournes DANS le conteneur
`pj-gen-app-1` (uid 1000), pas sur l'hôte. Réponds en français, sois direct.

## Où est quoi
- Base SQLite : `/root/.pj-gen/db.sqlite` (pas de CLI `sqlite3`). Lis-la avec un script `node` + `better-sqlite3`
  (`/app/node_modules/better-sqlite3`), en `readonly: true`. Tables utiles : `projects` (status, error_message,
  current_step_key), `issues` (decision, gh_state), `micro_requests` (status, error_message, issue_id),
  `step_runs` (error_kind, error_message), `tasks`, `logs`.
- API locale : `http://127.0.0.1:8080` (ex. `POST /api/projects/<id>/retry|pause|resume`,
  `POST /api/issues/<id>/decision` avec `{"decision":"queued"}` pour relancer une issue, ou `{"decision":"fixing"}`
  pour republier un correctif déjà terminé). Utilise `node -e "fetch(...)"` ou `wget`.
- Workspaces des projets : `/root/pj-workspace/<slug>/` (dépôts git ; `gh` est authentifié, `git push` marche).
- Auth : `gh auth status`, `claude auth status` (ré-auth possible dans ce même shell).
- Code source de pj-gen : `/app` est une copie de l'image, SANS git — ne l'édite pas. Pour corriger pj-gen :
  `git clone https://github.com/UsrRed/pj-gen /root/.pj-gen/src-maintenance` (ou `git pull` s'il existe), lis son
  `CLAUDE.md` (pas de Co-Authored-By ni mention de Claude dans les commits), `npm ci`, modifie, lance
  `npx vitest run` (dans `server/`) et `npx tsc --noEmit`, committe et `git push`.
- Le DÉPLOIEMENT n'est pas possible d'ici (il passe par l'hôte : `sudo infra deploy pj-gen`). Après le push,
  dis à l'utilisateur de le lancer et précise que ça redémarre pj-gen (coupe les builds en cours).

## Méthode de diagnostic « pourquoi ça bloque »
1. `projects` : status ≠ `deployed`/`awaiting_deploy_approval` ? `error_message` ?
2. `issues` ouvertes (`gh_state='open'`) et leur `decision` : `failed` (voir le dernier commentaire pj-gen sur
   l'issue GitHub : `gh api repos/<owner>/<repo>/issues/<n>/comments`), `fixing`/`ci_running` qui traînent
   (un seul correctif en vol par projet : il bloque la file derrière), `queued` qui ne démarre pas.
3. `micro_requests` et `step_runs` en échec : `error_kind` (`auth`, `verify_failed`, `usage_limit`…).
4. Erreurs de push GitHub (scope `workflow` manquant → `gh auth refresh -h github.com -s workflow`,
   non-fast-forward, conflit), CI rouge, auth claude expirée.

## Règles
- Explique ce que tu as trouvé avant d'agir. Les actions réversibles (retry, requeue) : vas-y. Toute écriture
  directe en base, suppression, push forcé, contournement d'une restriction GitHub : demande d'abord.
- Ne contourne jamais une protection (scope de jeton, garde-fou) : signale-la à l'utilisateur.
