import { DEFAULT_PROJECT_SIZE, PIPELINE_ORDER, type ModelName, type ProjectSize, type StepKey } from '@pjgen/shared';
import type { Repos } from '../db/repos/index.js';
import type { ProjectRow } from '../db/repos/projects.js';

/**
 * Single source of truth for what a size tier changes. Everything else in the pipeline
 * reads this table rather than hardcoding a number: before it existed, a 50-line script
 * and an enterprise application got the exact same 20-task budget, the same caps and the
 * same twelve steps.
 */
export interface SizeProfile {
  /** Steps dropped from PIPELINE_ORDER for this tier. */
  skipSteps: StepKey[];
  minTasks: number;
  maxTasks: number;
  maxTasksRevision: number;
  /** Multiplies both turns and timeout of the BUILD step caps (framing steps are never scaled). */
  capMultiplier: number;
  /** Max width of a parallel task batch. */
  taskParallelism: number;
  /** Model routing for this tier — below an explicit operator setting, above the built-in defaults. */
  stepModels: Partial<Record<string, ModelName>>;
  featureFixRounds: number;
  /** Scope discipline injected into the spec / architecture / breakdown prompts. */
  scopeGuidance: string;
}

const SMALL_GUIDANCE = `GABARIT « petit projet »: une seule préoccupation, un seul point d'entrée, résultat utilisable immédiatement.
INTERDIT (hors demande explicite de la SPEC): authentification, comptes utilisateurs, base relationnelle avec migrations, file de tâches, conteneurisation, observabilité, multi-tenant, internationalisation, panneau d'administration, système de plugins.
Persistance: fichier local (JSON ou SQLite) uniquement si le projet ne peut pas s'en passer.
Zéro dépendance qui ne soit pas strictement nécessaire. Aucune abstraction spéculative: pas d'interface à une seule implémentation, pas de couche de service qui ne fait que déléguer.`;

const MVP_GUIDANCE = `GABARIT « MVP »: le produit doit être utilisable de bout en bout par un premier utilisateur réel — pas une démo, pas un squelette.
Périmètre serré autour des éléments différenciants. Persistance simple acceptée (SQLite ou fichier).
Authentification UNIQUEMENT si la SPEC l'exige explicitement. Pas de migrations versionnées, pas d'observabilité, pas de CI.`;

const LARGE_GUIDANCE = `GABARIT « gros projet »: produit fini et robuste, pas un MVP.
Modularité réelle (frontières entre modules explicites), gestion d'erreurs complète, états vides / chargement / erreur sur toutes les vues.
Tests unitaires ET tests d'intégration sur les parcours clés. Authentification dès que le produit distingue des utilisateurs.
Configuration par variables d'environnement plutôt que par constantes.`;

const ENTERPRISE_GUIDANCE = `GABARIT « entreprise »: exigences de production.
Authentification ET autorisation (rôles), migrations de schéma versionnées et rejouables, journalisation structurée, configuration intégralement par variables d'environnement, reprise sur erreur et arrêt propre.
Tests unitaires + intégration + au moins un parcours de bout en bout. Pipeline CI. Documentation d'exploitation (démarrage, sauvegarde, restauration, incidents).`;

export const SIZE_PROFILES: Record<ProjectSize, SizeProfile> = {
  small: {
    // A tiny project needs neither a design benchmark nor a test-hardening pass:
    // together they are ~25 min of caps for a build that should take under an hour.
    skipSteps: ['design_benchmark', 'test_hardening'],
    minTasks: 2,
    maxTasks: 6,
    maxTasksRevision: 3,
    capMultiplier: 0.7,
    taskParallelism: 2,
    stepModels: { design: 'sonnet', architecture: 'sonnet' },
    featureFixRounds: 1,
    scopeGuidance: SMALL_GUIDANCE,
  },
  mvp: {
    skipSteps: [],
    minTasks: 3,
    maxTasks: 20,
    maxTasksRevision: 15,
    capMultiplier: 1,
    taskParallelism: 2,
    stepModels: {},
    featureFixRounds: 2,
    scopeGuidance: MVP_GUIDANCE,
  },
  large: {
    skipSteps: [],
    minTasks: 5,
    maxTasks: 30,
    maxTasksRevision: 20,
    capMultiplier: 1.4,
    taskParallelism: 3,
    stepModels: { architecture: 'opus', review_fix: 'opus', feature_check: 'opus' },
    featureFixRounds: 2,
    scopeGuidance: LARGE_GUIDANCE,
  },
  enterprise: {
    skipSteps: [],
    minTasks: 8,
    maxTasks: 45,
    maxTasksRevision: 25,
    capMultiplier: 1.8,
    taskParallelism: 4,
    stepModels: { design: 'opus', architecture: 'opus', review_fix: 'opus', feature_check: 'opus' },
    featureFixRounds: 3,
    scopeGuidance: ENTERPRISE_GUIDANCE,
  },
};

/** Steps whose caps are size-dependent. Framing steps (cadrage, spec) are not: a short
 *  interview is a short interview whatever the project's eventual size. */
const SCALED_STEPS = new Set<string>([...PIPELINE_ORDER, 'deploy']);

export function sizeOf(project: Pick<ProjectRow, 'size'> | null | undefined): ProjectSize {
  return (project?.size as ProjectSize | null) ?? DEFAULT_PROJECT_SIZE;
}

/** Built-in profile merged with the operator's per-tier overrides from settings. */
export function profileFor(repos: Repos, project: Pick<ProjectRow, 'size'> | null | undefined): SizeProfile {
  const size = sizeOf(project);
  const overrides = repos.settings.getAll().sizeProfiles?.[size] ?? {};
  return { ...SIZE_PROFILES[size], ...overrides };
}

export function isScaledStep(stepKey: string): boolean {
  return SCALED_STEPS.has(stepKey);
}

/** Ordered pipeline for a project, with the tier's skipped steps removed. */
export function orderFor(order: StepKey[], profile: SizeProfile): StepKey[] {
  const skip = new Set<StepKey>(profile.skipSteps);
  return order.filter((k) => !skip.has(k));
}
