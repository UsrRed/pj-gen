import type { ModelName } from '@pjgen/shared';
import type { Repos } from '../db/repos/index.js';
import type { ProjectRow } from '../db/repos/projects.js';
import { isScaledStep, profileFor } from './sizing.js';

export interface ModelChoice {
  model: string;
  fallbackModel?: string;
}

/**
 * CLI arg per model name. The 'haiku' alias is undocumented in `claude --help`;
 * if a real run rejects it, swap the value for a full model id here (single
 * point of change), e.g. 'claude-haiku-4-5-20251001'.
 */
export const MODEL_ARG: Record<ModelName, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  haiku: 'haiku',
};

/** Fallbacks favor availability: opus and haiku both degrade to sonnet. */
const FALLBACK: Partial<Record<ModelName, ModelName>> = {
  opus: 'sonnet',
  haiku: 'sonnet',
};

/**
 * Precedence: project step override > explicit operator setting > size profile >
 * built-in default > project model > defaultModel.
 *
 * The size profile sits ABOVE the built-in defaults (it is the more specific statement
 * about this project) but BELOW anything the operator typed: a hand-set routing must
 * never be silently overruled by a tier.
 */
export function resolveModel(repos: Repos, project: ProjectRow, stepKey: string): ModelChoice {
  const settings = repos.settings.getAll();
  const overrides = repos.projects.stepModelOverridesOf(project);
  const profile = profileFor(repos, project);
  const model: ModelName =
    (overrides as Record<string, ModelName>)[stepKey] ??
    repos.settings.rawStepModels()[stepKey] ??
    profile.stepModels[stepKey] ??
    settings.stepModels[stepKey] ??
    project.model ??
    settings.defaultModel;
  const fallback = FALLBACK[model];
  return { model: MODEL_ARG[model] ?? model, fallbackModel: fallback ? MODEL_ARG[fallback] : undefined };
}

/** Hard bounds on the scaled caps: a multiplier must never produce an absurd budget. */
const TURNS_BOUNDS = { min: 4, max: 200 };
const MINUTES_BOUNDS = { min: 2, max: 180 };

/**
 * Turn/duration caps for a step. When `project` is given, the size profile scales the
 * BUILD steps — but only where the operator has not set that cap by hand, and never
 * for framing steps (a cadrage interview does not get longer because the project is big).
 */
export function capsFor(repos: Repos, stepKey: string, project?: Pick<ProjectRow, 'size'> | null): { maxTurns: number; timeoutMs: number } {
  const settings = repos.settings.getAll();
  const cap = settings.stepCaps[stepKey] ?? { turns: 30, timeoutMin: 20 };

  const operatorSet = repos.settings.rawStepCaps()[stepKey] !== undefined;
  const scalable = project !== undefined && project !== null && !operatorSet && isScaledStep(stepKey);
  const mult = scalable ? profileFor(repos, project).capMultiplier : 1;

  const turns = clamp(Math.round(cap.turns * mult), TURNS_BOUNDS.min, TURNS_BOUNDS.max);
  const minutes = clamp(Math.round(cap.timeoutMin * mult), MINUTES_BOUNDS.min, MINUTES_BOUNDS.max);
  return { maxTurns: turns, timeoutMs: minutes * 60 * 1000 };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
