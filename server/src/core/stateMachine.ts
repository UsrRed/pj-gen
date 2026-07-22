import { PROJECT_TRANSITIONS, type ProjectStatus } from '@pjgen/shared';
import type { ProjectsRepo } from '../db/repos/projects.js';
import { conflict } from './httpError.js';

export function isTransitionAllowed(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from]?.includes(to) ?? false;
}

export class ProjectStateMachine {
  constructor(private projects: ProjectsRepo) {}

  /**
   * Atomically move a project from one of `from` to `to` (CAS on status).
   * Every `from` must be a legal source for `to` per PROJECT_TRANSITIONS.
   * Returns true when the swap happened, false when the project was in another status.
   */
  tryTransition(id: string, from: ProjectStatus[], to: ProjectStatus, patch: Record<string, unknown> = {}): boolean {
    for (const f of from) {
      if (!isTransitionAllowed(f, to)) {
        throw new Error(`transition interdite: ${f} → ${to}`);
      }
    }
    return this.projects.casStatus(id, from, to, patch);
  }

  /** Same as tryTransition but throws HTTP 409 on CAS failure (for user-facing routes). */
  transitionOr409(id: string, from: ProjectStatus[], to: ProjectStatus, patch: Record<string, unknown> = {}): void {
    if (!this.tryTransition(id, from, to, patch)) {
      const row = this.projects.byId(id);
      throw conflict(`Action impossible: le projet est en statut « ${row?.status ?? 'inconnu'} »`);
    }
  }
}
