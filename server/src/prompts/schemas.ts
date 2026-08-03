import { z } from 'zod';
import { ACCESS_KINDS, DEFAULT_TASK_PHASE, PROJECT_SIZES, TASK_PHASES } from '@pjgen/shared';

/** zod schemas (server-side validation) + plain JSON Schemas (passed to `--json-schema`). */

/** '' = tier not decided yet. Optional with a default so older fake/recorded outputs still parse. */
const SizeFieldZ = z.enum([...PROJECT_SIZES, '']).default('');
const SIZE_ENUM = [...PROJECT_SIZES, ''];

/** Access requirement as declared by cadrage. NAMES of secrets only — never their values. */
export const AccessRequirementZ = z.object({
  key: z.string().min(1).max(64),
  kind: z.enum(ACCESS_KINDS),
  label: z.string().min(1).max(160),
  required: z.boolean().default(true),
  why: z.string().default(''),
  env_vars: z.array(z.string()).default([]),
});

const ACCESS_REQUIREMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'Clé stable en minuscules, ex. ssh_prod, stripe' },
    kind: { type: 'string', enum: [...ACCESS_KINDS] },
    label: { type: 'string', description: 'Libellé lisible, ex. « VPS de production »' },
    required: { type: 'boolean', description: 'false pour un accès optionnel' },
    why: { type: 'string', description: 'Pourquoi le projet en a besoin (une phrase)' },
    env_vars: {
      type: 'array',
      items: { type: 'string' },
      description: 'NOMS des variables d’environnement secrètes (ex. STRIPE_API_KEY) — JAMAIS leurs valeurs',
    },
  },
  required: ['key', 'kind', 'label', 'required', 'why', 'env_vars'],
  additionalProperties: false,
};

export const CadrageReplyZ = z.object({
  reply_markdown: z.string().min(1),
  open_questions: z.array(z.string()),
  ready_for_spec: z.boolean(),
  suggested_size: SizeFieldZ,
  size_rationale: z.string().default(''),
  access_requirements: z.array(AccessRequirementZ).max(12).default([]),
});
export type CadrageReply = z.infer<typeof CadrageReplyZ>;

export const CADRAGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply_markdown: { type: 'string', description: 'Réponse au message utilisateur, en markdown, en français' },
    open_questions: { type: 'array', items: { type: 'string' }, description: 'Questions encore ouvertes (max 5)' },
    ready_for_spec: { type: 'boolean', description: 'true quand tu as assez d’éléments pour rédiger la spécification' },
    suggested_size: {
      type: 'string',
      enum: SIZE_ENUM,
      description: 'Gabarit proposé: small | mvp | large | enterprise ("" tant que ce n’est pas tranché)',
    },
    size_rationale: { type: 'string', description: 'Une phrase justifiant le gabarit proposé' },
    access_requirements: {
      type: 'array',
      items: ACCESS_REQUIREMENT_JSON_SCHEMA,
      description: 'Inventaire COMPLET des accès nécessaires, réénoncé à chaque tour (liste vide si aucun)',
    },
  },
  required: ['reply_markdown', 'open_questions', 'ready_for_spec', 'suggested_size', 'size_rationale', 'access_requirements'],
  additionalProperties: false,
};

export const SpecOutputZ = z.object({
  title: z.string().min(1).max(120),
  spec_markdown: z.string().min(50),
  size: SizeFieldZ,
  access_requirements: z.array(AccessRequirementZ).max(12).default([]),
});
export type SpecOutput = z.infer<typeof SpecOutputZ>;

export const SPEC_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Titre court du projet' },
    spec_markdown: { type: 'string', description: 'Spécification complète en markdown, en français' },
    size: { type: 'string', enum: SIZE_ENUM, description: 'Gabarit du projet: small | mvp | large | enterprise' },
    access_requirements: {
      type: 'array',
      items: ACCESS_REQUIREMENT_JSON_SCHEMA,
      description: 'Inventaire final des accès nécessaires (liste vide si aucun)',
    },
  },
  required: ['title', 'spec_markdown', 'size', 'access_requirements'],
  additionalProperties: false,
};

export const StackZ = z.object({
  language: z.string(),
  framework: z.string(),
  package_manager: z.string(),
  install_cmd: z.string(),
  build_cmd: z.string(),
  test_cmd: z.string().min(1),
  run_cmd: z.string(),
});

export const ArchOutputZ = z.object({
  architecture_markdown: z.string().min(50),
  // No min(): an empty string just skips writing docs/INTERFACES.md (never blocks the pipeline).
  interfaces_markdown: z.string().default(''),
  stack: StackZ,
  risks: z.array(z.string()),
});
export type ArchOutput = z.infer<typeof ArchOutputZ>;

export const ARCH_JSON_SCHEMA = {
  type: 'object',
  properties: {
    architecture_markdown: { type: 'string', description: 'Document d’architecture complet en markdown' },
    interfaces_markdown: {
      type: 'string',
      description:
        'Contrats d’interface clés (signatures publiques, schémas API/WS/événements, types partagés, formats de fichiers) — concis et stable, en markdown',
    },
    stack: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        framework: { type: 'string' },
        package_manager: { type: 'string' },
        install_cmd: { type: 'string', description: 'Commande d’installation des dépendances (ou "")' },
        build_cmd: { type: 'string', description: 'Commande de build (ou "")' },
        test_cmd: { type: 'string', description: 'Commande de test — OBLIGATOIRE et exécutable depuis la racine' },
        run_cmd: { type: 'string', description: 'Commande de lancement (ou "")' },
      },
      required: ['language', 'framework', 'package_manager', 'install_cmd', 'build_cmd', 'test_cmd', 'run_cmd'],
      additionalProperties: false,
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['architecture_markdown', 'interfaces_markdown', 'stack', 'risks'],
  additionalProperties: false,
};

export const BreakdownTaskZ = z.object({
  task_key: z.string().regex(/^T\d{2}$/),
  title: z.string().min(1).max(160),
  description: z.string(),
  files_hint: z.array(z.string()),
  /** Optional with a default: revision/micro breakdowns and recorded fixtures predate it. */
  writes: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).min(1),
  depends_on: z.array(z.string()),
  /** Ordering relations; optional with a default so revision/micro breakdowns still parse. */
  after: z.array(z.string()).default([]),
  phase: z.enum(TASK_PHASES).default(DEFAULT_TASK_PHASE),
});

export const BreakdownOutputZ = z.object({
  // Plafond = espace de clés (T01–T99), pas la discipline de périmètre : celle-ci vient du
  // prompt (profile.minTasks/maxTasks). Un plafond plus bas que le gabarit (ex-40 < enterprise 45)
  // fait rejeter par le validateur une sortie qui obéit au prompt.
  tasks: z.array(BreakdownTaskZ).min(1).max(99),
});
export type BreakdownOutput = z.infer<typeof BreakdownOutputZ>;

export const BREAKDOWN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_key: { type: 'string', pattern: '^T[0-9]{2}$', description: 'T01, T02, …' },
          title: { type: 'string' },
          description: { type: 'string' },
          files_hint: { type: 'array', items: { type: 'string' }, description: 'Fichiers probablement LUS par la tâche' },
          writes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Chemins EXACTS que la tâche va créer ou modifier — deux tâches parallélisables n’en partagent aucun',
          },
          acceptance: { type: 'array', items: { type: 'string' }, description: 'Critères vérifiables par des tests' },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Dépendances de CONTRAT: la tâche ne peut pas être écrite sans ces sorties (export, schéma, fichier)',
          },
          after: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Relations d’ORDRE: la tâche pourrait techniquement démarrer mais ne DOIT pas commencer avant que ces tâches soient terminées (travail qui serait à refaire)',
          },
          phase: {
            type: 'string',
            enum: [...TASK_PHASES],
            description: 'Étape produit: foundation (socle) | core (fonctionnalités) | polish (animations, transitions, finition)',
          },
        },
        required: ['task_key', 'title', 'description', 'files_hint', 'writes', 'acceptance', 'depends_on', 'after', 'phase'],
        additionalProperties: false,
      },
    },
  },
  required: ['tasks'],
  additionalProperties: false,
};

/** Adoption of an existing (cloned) repository: reconstructed docs + stack. */
export const ImportOutputZ = z.object({
  title: z.string().min(1).max(120),
  spec_markdown: z.string().min(50),
  architecture_markdown: z.string().min(50),
  interfaces_markdown: z.string().default(''),
  stack: StackZ,
});
export type ImportOutput = z.infer<typeof ImportOutputZ>;

export const IMPORT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Titre court du projet (déduit du dépôt)' },
    spec_markdown: {
      type: 'string',
      description: 'Spécification RECONSTRUITE depuis le code existant (mêmes sections qu’une SPEC pj-gen: Objectif, Fonctionnalités F1..Fn avec critères, Contraintes, Hors périmètre)',
    },
    architecture_markdown: { type: 'string', description: 'Document d’architecture décrivant le dépôt TEL QU’IL EST (carte des fichiers, modules, flux)' },
    interfaces_markdown: { type: 'string', description: 'Contrats d’interface clés observés (signatures, schémas API, types) — "" si rien de notable' },
    stack: {
      type: 'object',
      properties: {
        language: { type: 'string' },
        framework: { type: 'string' },
        package_manager: { type: 'string' },
        install_cmd: { type: 'string', description: 'Commande d’installation réelle du dépôt (ou "")' },
        build_cmd: { type: 'string', description: 'Commande de build réelle (ou "")' },
        test_cmd: { type: 'string', description: 'Commande de test EXÉCUTABLE depuis la racine — si le dépôt n’a aucun test, une commande inoffensive qui réussit' },
        run_cmd: { type: 'string', description: 'Commande de lancement (ou "")' },
      },
      required: ['language', 'framework', 'package_manager', 'install_cmd', 'build_cmd', 'test_cmd', 'run_cmd'],
      additionalProperties: false,
    },
  },
  required: ['title', 'spec_markdown', 'architecture_markdown', 'interfaces_markdown', 'stack'],
  additionalProperties: false,
};

export const MicroTaskZ = z.object({
  actionable: z.boolean(),
  clarification_question: z.string(),
  title: z.string(),
  description: z.string(),
  files_hint: z.array(z.string()),
  acceptance: z.array(z.string()),
});
export type MicroTask = z.infer<typeof MicroTaskZ>;

export const MICRO_JSON_SCHEMA = {
  type: 'object',
  properties: {
    actionable: { type: 'boolean', description: 'false si la demande est trop floue pour être transformée en tâche précise' },
    clarification_question: { type: 'string', description: 'Question de clarification concise ("" si actionable)' },
    title: { type: 'string', description: 'Titre court de la tâche ("" si non actionable)' },
    description: {
      type: 'string',
      description: 'Description précise: entrées consommées, sorties produites, fichiers concernés ("" si non actionable)',
    },
    files_hint: { type: 'array', items: { type: 'string' }, description: 'Chemins des fichiers probablement concernés' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'Critères observables et/ou testables (≥1 si actionable)' },
  },
  required: ['actionable', 'clarification_question', 'title', 'description', 'files_hint', 'acceptance'],
  additionalProperties: false,
};

export const BenchmarkOutputZ = z.object({
  applicable: z.boolean(),
  benchmark_markdown: z.string(),
});
export type BenchmarkOutput = z.infer<typeof BenchmarkOutputZ>;

export const BENCHMARK_JSON_SCHEMA = {
  type: 'object',
  properties: {
    applicable: { type: 'boolean', description: 'false si la SPEC ne décrit aucune interface visuelle (CLI pur, API, librairie)' },
    benchmark_markdown: {
      type: 'string',
      description:
        'Synthèse markdown de 3 à 5 produits de référence du même domaine: palette réelle, layout, patterns d’interaction, partis pris typographiques — "" si non applicable',
    },
  },
  required: ['applicable', 'benchmark_markdown'],
  additionalProperties: false,
};

export const DesignOutputZ = z.object({
  applicable: z.boolean(),
  mockup_html: z.string(),
  design_notes_markdown: z.string(),
});
export type DesignOutput = z.infer<typeof DesignOutputZ>;

export const DESIGN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    applicable: { type: 'boolean', description: 'false uniquement si le projet n’a aucune interface visuelle' },
    mockup_html: { type: 'string', description: 'Maquette HTML autonome (CSS inline, zéro dépendance) — "" si non applicable' },
    design_notes_markdown: { type: 'string', description: 'Système de design (palette, typo, espacements, motion) — "" si non applicable' },
  },
  required: ['applicable', 'mockup_html', 'design_notes_markdown'],
  additionalProperties: false,
};

export const FeatureAuditItemZ = z.object({
  key: z.string().min(1),
  title: z.string(),
  status: z.enum(['ok', 'partial', 'missing']),
  evidence: z.string(),
  fix_hint: z.string(),
});
export const FeatureAuditZ = z.object({
  features: z.array(FeatureAuditItemZ).min(1),
});
export type FeatureAudit = z.infer<typeof FeatureAuditZ>;

export const FEATURE_AUDIT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'F1, F2, … (clé de la fonctionnalité dans la SPEC)' },
          title: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'partial', 'missing'], description: 'ok = réellement câblée de bout en bout' },
          evidence: { type: 'string', description: 'Fichiers/éléments précis constatés' },
          fix_hint: { type: 'string', description: 'Quoi faire concrètement ("" si ok)' },
        },
        required: ['key', 'title', 'status', 'evidence', 'fix_hint'],
        additionalProperties: false,
      },
    },
  },
  required: ['features'],
  additionalProperties: false,
};

/** Extract structured output from a run: prefers structured_output, falls back to parsing result text. */
export function extractStructured<T>(schema: z.ZodType<T>, structured: unknown, resultText: string): { ok: true; data: T } | { ok: false; error: string } {
  const candidates: unknown[] = [];
  if (structured !== undefined && structured !== null) candidates.push(structured);
  const text = resultText.trim();
  if (text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    for (const raw of [fenced?.[1], text]) {
      if (!raw) continue;
      try {
        candidates.push(JSON.parse(raw));
      } catch {
        /* not JSON */
      }
    }
  }
  for (const c of candidates) {
    const parsed = schema.safeParse(c);
    if (parsed.success) return { ok: true, data: parsed.data };
  }
  const first = candidates.length ? schema.safeParse(candidates[0]) : null;
  const detail = first && !first.success ? first.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'aucune sortie JSON exploitable';
  return { ok: false, error: detail.slice(0, 600) };
}
