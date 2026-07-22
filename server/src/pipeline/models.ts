import type { ModelName } from '@pjgen/shared';
import type { Repos } from '../db/repos/index.js';
import type { ProjectRow } from '../db/repos/projects.js';

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

/** Precedence: project step override > settings.stepModels > project model > defaultModel. */
export function resolveModel(repos: Repos, project: ProjectRow, stepKey: string): ModelChoice {
  const settings = repos.settings.getAll();
  const overrides = repos.projects.stepModelOverridesOf(project);
  const model: ModelName =
    (overrides as Record<string, ModelName>)[stepKey] ??
    settings.stepModels[stepKey] ??
    project.model ??
    settings.defaultModel;
  const fallback = FALLBACK[model];
  return { model: MODEL_ARG[model] ?? model, fallbackModel: fallback ? MODEL_ARG[fallback] : undefined };
}

export function capsFor(repos: Repos, stepKey: string): { maxTurns: number; timeoutMs: number } {
  const settings = repos.settings.getAll();
  const cap = settings.stepCaps[stepKey] ?? { turns: 30, timeoutMin: 20 };
  return { maxTurns: cap.turns, timeoutMs: cap.timeoutMin * 60 * 1000 };
}
