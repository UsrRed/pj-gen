import type { DB } from './db.js';

const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT,
    step_model_overrides TEXT NOT NULL DEFAULT '{}',
    stack TEXT,
    workspace_path TEXT NOT NULL,
    initial_prompt TEXT NOT NULL,
    spec_sha256 TEXT,
    spec_validated_at INTEGER,
    enqueued_at INTEGER,
    current_step_key TEXT,
    current_task_key TEXT,
    deploy_notes TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    num_turns INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE TABLE step_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    step_key TEXT NOT NULL,
    task_key TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    session_id TEXT REFERENCES sessions(id),
    pid INTEGER,
    resume_at INTEGER,
    model TEXT,
    num_turns INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    error_kind TEXT,
    error_message TEXT,
    started_at INTEGER,
    ended_at INTEGER
  );
  CREATE INDEX idx_step_runs_proj ON step_runs(project_id, id);
  CREATE INDEX idx_step_runs_status ON step_runs(status);

  CREATE TABLE tasks (
    project_id TEXT NOT NULL REFERENCES projects(id),
    task_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    files_hint TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending',
    commit_sha TEXT,
    PRIMARY KEY (project_id, task_key)
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    session_kind TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    structured TEXT,
    session_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_proj ON messages(project_id, id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_events_proj ON events(project_id, id);

  CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    step_run_id INTEGER NOT NULL REFERENCES step_runs(id),
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    line TEXT NOT NULL,
    display TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_logs_run ON logs(step_run_id, seq);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE quota_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    limited_until INTEGER,
    last_hit_at INTEGER,
    matched_pattern TEXT
  );
  INSERT INTO quota_state (id, limited_until, last_hit_at, matched_pattern) VALUES (1, NULL, NULL, NULL);
  `,
  // v2 — improvement iterations (reopen a settled project)
  `
  ALTER TABLE projects ADD COLUMN iteration INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE projects ADD COLUMN reopened_at INTEGER;
  `,
  // v3 — token usage (subscription mode: tokens are the real metric, cost_usd stays for forensics)
  `
  ALTER TABLE step_runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE step_runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE step_runs ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE step_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
  `,
  // v4 — 5h-window gauge (timestamped usage log + limit-hit history), generated-app runner tracking
  `
  ALTER TABLE quota_state ADD COLUMN window_resets_at INTEGER;
  ALTER TABLE quota_state ADD COLUMN window_type TEXT;

  CREATE TABLE usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_usage_log_at ON usage_log(at);

  CREATE TABLE limit_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hit_at INTEGER NOT NULL,
    tokens_in_window INTEGER NOT NULL
  );

  CREATE TABLE app_runs (
    project_id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL
  );
  `,
  // v5 — design benchmark toggle (NULL = follow global setting) + live micro-modifications
  `
  ALTER TABLE projects ADD COLUMN design_benchmark INTEGER;
  ALTER TABLE projects ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'full';

  CREATE TABLE micro_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    source TEXT NOT NULL,
    issue_id INTEGER,
    request TEXT NOT NULL,
    task_key TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_micro_proj ON micro_requests(project_id, id);
  `,
  // v6 — GitHub link (gh CLI): remote repo, visibility, auto-issue mode, last push tracking
  `
  ALTER TABLE projects ADD COLUMN github_repo TEXT;
  ALTER TABLE projects ADD COLUMN github_private INTEGER;
  ALTER TABLE projects ADD COLUMN github_auto_mode INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE projects ADD COLUMN github_last_push_sha TEXT;
  ALTER TABLE projects ADD COLUMN github_last_push_at INTEGER;
  `,
  // v7 — auto-issue fixer: synced GitHub issues + trusted users
  `
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL,
    gh_state TEXT NOT NULL DEFAULT 'open',
    gh_updated_at TEXT,
    decision TEXT NOT NULL DEFAULT 'pending',
    posted_comment_at INTEGER,
    last_synced_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, number)
  );

  CREATE TABLE trusted_users (
    login TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
  `,
  // v8 — run timing: wall-clock of the claude session and of the stack verification.
  // Both were computed and thrown away; without them no speedup is measurable.
  `
  ALTER TABLE step_runs ADD COLUMN duration_ms INTEGER;
  ALTER TABLE step_runs ADD COLUMN verify_ms INTEGER;
  `,
  // v9 — gabarit de projet: pilote périmètre, budgets, étapes et routage modèle.
  // NULL = non tranché (auto). Les projets DÉJÀ lancés sont figés sur 'mvp', qui
  // reproduit exactement les budgets et le pipeline d'avant cette migration.
  `
  ALTER TABLE projects ADD COLUMN size TEXT;
  ALTER TABLE projects ADD COLUMN size_source TEXT;
  UPDATE projects SET size = 'mvp', size_source = 'default'
    WHERE size IS NULL AND status NOT IN ('draft', 'spec_ready');
  `,
  // v10 — implémentation parallèle: `writes` est l'ENGAGEMENT d'écriture d'une tâche
  // (distinct de files_hint, qui n'est qu'une indication de lecture) et sert à composer
  // des lots sans conflit; worktree_dir survit à un parcage quota pour que la reprise
  // se rattache au même arbre de travail au lieu d'en recréer un sur un autre HEAD.
  `
  ALTER TABLE tasks ADD COLUMN writes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN worktree_dir TEXT;
  UPDATE tasks SET writes = files_hint WHERE writes = '[]';
  `,
  // v11 — inventaire des accès identifié au cadrage. Aucune colonne ne peut contenir un
  // secret: seules les valeurs NON secrètes (hôte, utilisateur, port, domaine…) sont
  // stockées, et secret_env_vars ne contient que des NOMS de variables. Les valeurs
  // secrètes vont directement dans le .env du workspace.
  `
  CREATE TABLE project_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id),
    key TEXT NOT NULL,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    why TEXT NOT NULL DEFAULT '',
    fields TEXT NOT NULL DEFAULT '{}',
    secret_env_vars TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'needed',
    source TEXT NOT NULL DEFAULT 'cadrage',
    last_test_at INTEGER,
    last_test_ok INTEGER,
    last_test_detail TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (project_id, key)
  );

  CREATE INDEX idx_access_proj ON project_access(project_id, id);
  `,
  // v12 — relations d'ORDRE entre tâches, distinctes des dépendances de contrat:
  // `after` = « ne pas commencer avant que ces tâches soient terminées » (maturité, pas
  // contrat), `phase` = étape produit (les animations attendent un jeu qui tourne).
  // Défauts rétro-compatibles: aucune arête d'ordre, tout en phase 'core' = aucune barrière.
  `
  ALTER TABLE tasks ADD COLUMN after_keys TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'core';
  `,
];

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
