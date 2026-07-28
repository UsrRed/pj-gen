/**
 * Access inventory: what the project needs to run and to be deployed, identified
 * DURING cadrage instead of being discovered as free text at the deploy gate.
 *
 * Security model, inherited from how the repo already treats credentials
 * (gh keyring for GitHub, API keys stripped from child envs, .env gitignored):
 * NON-SECRET values (host, user, port, key path, domain) live in SQLite and feed the
 * architecture and deploy prompts. SECRET values are never stored, never returned by the
 * API and never put in the chat — they are written straight into the workspace's `.env`.
 */
export const ACCESS_KINDS = ['ssh', 'domain', 'database', 'api_key', 'smtp', 'object_storage', 'other'] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

export const ACCESS_STATUSES = ['needed', 'provided', 'skipped'] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export interface AccessFieldSpec {
  name: string;
  label: string;
  placeholder?: string;
}

/**
 * Non-secret fields expected per kind. Also drives the UI form.
 * For SSH we ask for the PATH of a local key, never the key itself: pj-gen runs on the
 * operator's own machine, so the local ssh agent/key is what actually authenticates.
 */
export const ACCESS_FIELD_SPECS: Record<AccessKind, AccessFieldSpec[]> = {
  ssh: [
    { name: 'host', label: 'Hôte', placeholder: 'deploy.exemple.com' },
    { name: 'user', label: 'Utilisateur', placeholder: 'deploy' },
    { name: 'port', label: 'Port', placeholder: '22' },
    { name: 'key_path', label: 'Clé locale', placeholder: '~/.ssh/id_ed25519' },
    { name: 'target_dir', label: 'Répertoire cible', placeholder: '/srv/app' },
  ],
  domain: [
    { name: 'domain', label: 'Domaine', placeholder: 'app.exemple.com' },
    { name: 'dns_provider', label: 'Registrar / DNS', placeholder: 'OVH, Cloudflare…' },
  ],
  database: [
    { name: 'engine', label: 'Moteur', placeholder: 'postgres, mysql, sqlite…' },
    { name: 'host', label: 'Hôte', placeholder: 'localhost' },
    { name: 'port', label: 'Port', placeholder: '5432' },
    { name: 'database', label: 'Base', placeholder: 'app_prod' },
    { name: 'user', label: 'Utilisateur', placeholder: 'app' },
  ],
  api_key: [
    { name: 'provider', label: 'Fournisseur', placeholder: 'Stripe, OpenWeather…' },
    { name: 'docs_url', label: 'Documentation', placeholder: 'https://…' },
  ],
  smtp: [
    { name: 'host', label: 'Hôte SMTP', placeholder: 'smtp.exemple.com' },
    { name: 'port', label: 'Port', placeholder: '587' },
    { name: 'user', label: 'Utilisateur', placeholder: 'no-reply@exemple.com' },
    { name: 'from', label: 'Expéditeur', placeholder: 'App <no-reply@exemple.com>' },
  ],
  object_storage: [
    { name: 'endpoint', label: 'Endpoint', placeholder: 'https://s3.eu-west-3.amazonaws.com' },
    { name: 'region', label: 'Région', placeholder: 'eu-west-3' },
    { name: 'bucket', label: 'Bucket', placeholder: 'app-uploads' },
    { name: 'access_key_id', label: 'Access key ID', placeholder: 'AKIA…' },
  ],
  other: [{ name: 'note', label: 'Précision' }],
};

export interface AccessDto {
  id: number;
  projectId: string;
  /** Stable key so a cadrage turn can restate the same requirement without duplicating it. */
  key: string;
  kind: AccessKind;
  label: string;
  required: boolean;
  /** Why the project needs it — shown to the operator, injected into the deploy prompt. */
  why: string;
  /** NON-SECRET values only. The repo layer rejects anything that looks like a secret. */
  fields: Record<string, string>;
  /** NAMES of the .env variables this access needs — never their values. */
  secretEnvVars: string[];
  status: AccessStatus;
  /** 'cadrage' rows are replaced on each turn; 'user' rows are never overwritten. */
  source: 'cadrage' | 'user';
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestDetail: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Connectivity test result (SSH / DNS). */
export interface AccessTestResult {
  ok: boolean;
  detail: string;
  at: number;
}
