import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import type { SessionSpec } from '../src/claude/types.js';
import { WRAP_UP_CAPS } from '../src/pipeline/steps.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

const isPolishPrompt = (spec: SessionSpec) => spec.prompt.includes('Passe de finition');
const isWrapUpPrompt = (spec: SessionSpec) => spec.prompt.startsWith('STOP — le superviseur');

describe('Atterrissage après kill au cap (post-mortem Red Cactus)', () => {
  it('reprend la session tuée au cap avec le prompt de clôture et un mini-budget', async () => {
    const captured: SessionSpec[] = [];
    let polishTimeouts = 0;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        captured.push(spec);
        if (isPolishPrompt(spec) && polishTimeouts === 0) {
          polishTimeouts++;
          return {
            delayMs: 10,
            result: {
              outcome: 'failure',
              failure: { kind: 'timeout', message: 'Cap de durée/tours dépassé — session stoppée par le superviseur' },
            },
          };
        }
        return undefined; // everything else uses the default fake outputs
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Wrap Up');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const killedIdx = captured.findIndex(isPolishPrompt);
    expect(killedIdx).toBeGreaterThan(-1);
    const killed = captured[killedIdx];
    const wrapUp = captured[killedIdx + 1];
    // The very next run resumes the SAME session with the landing prompt and reduced caps.
    expect(isWrapUpPrompt(wrapUp)).toBe(true);
    expect(wrapUp.resume).toBe(true);
    expect(wrapUp.sessionId).toBe(killed.sessionId);
    expect(wrapUp.maxTurns).toBe(WRAP_UP_CAPS.maxTurns);
    expect(wrapUp.timeoutMs).toBe(WRAP_UP_CAPS.timeoutMs);

    const polishRuns = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'polish');
    expect(polishRuns.map((r) => r.status)).toEqual(['failed_retryable', 'succeeded']);
  });

  it('annonce le budget (caps) dans le system prompt des sessions outillées, pas des générations', async () => {
    const captured: SessionSpec[] = [];
    const { c } = await testContainer({
      script: fastScript((spec) => {
        captured.push(spec);
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Budget Vis');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const toolSpecs = captured.filter((s) => s.tools === 'default');
    expect(toolSpecs.length).toBeGreaterThan(0);
    for (const s of toolSpecs) expect(s.appendSystemPrompt).toContain('Budget: cette session est plafonnée');
    // Generation steps (single structured turn, no tools) don't get the budget rule.
    const genSpecs = captured.filter((s) => s.tools === 'none');
    expect(genSpecs.length).toBeGreaterThan(0);
    for (const s of genSpecs) expect(s.appendSystemPrompt).not.toContain('Budget: cette session est plafonnée');
  });

  it('polish en échec définitif ne coule plus le build (non bloquant)', async () => {
    const captured: SessionSpec[] = [];
    const { c } = await testContainer({
      script: fastScript((spec) => {
        captured.push(spec);
        if (isPolishPrompt(spec)) {
          return { delayMs: 10, result: { outcome: 'failure', failure: { kind: 'crash', message: 'polish KO simulé' } } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Polish Down');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet malgré polish KO');

    const polishRuns = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'polish');
    expect(polishRuns.map((r) => r.status)).toEqual(['failed_retryable', 'failed_retryable', 'failed']);
    // crash (non-timeout) must NOT trigger the wrap-up landing path
    expect(captured.some(isWrapUpPrompt)).toBe(false);
    const progress = fs.readFileSync(path.join(c.repos.projects.byId(id)!.workspace_path, 'docs', 'PROGRESS.md'), 'utf8');
    expect(progress).toContain('polish incomplet (non bloquant)');
  });

  it('un wrap-up lui-même tué au cap retombe sur un redémarrage classique (pas de boucle)', async () => {
    const captured: SessionSpec[] = [];
    const { c } = await testContainer({
      script: fastScript((spec) => {
        captured.push(spec);
        if (isPolishPrompt(spec) && !spec.forkSession && captured.filter(isPolishPrompt).length === 1) {
          return { delayMs: 10, result: { outcome: 'failure', failure: { kind: 'timeout', message: 'cap' } } };
        }
        if (isWrapUpPrompt(spec)) {
          return { delayMs: 10, result: { outcome: 'failure', failure: { kind: 'timeout', message: 'cap wrap-up' } } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Double Kill');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    // one wrap-up only, then attempt 3 forks the session with the regular prompt and succeeds
    expect(captured.filter(isWrapUpPrompt)).toHaveLength(1);
    const polishRuns = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'polish');
    expect(polishRuns.map((r) => r.status)).toEqual(['failed_retryable', 'failed_retryable', 'succeeded']);
    const forked = captured.find((s) => isPolishPrompt(s) && s.forkSession);
    expect(forked).toBeDefined();
  });
});
