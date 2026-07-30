import { describe, expect, it, afterEach } from 'vitest';
import type { Container } from '../src/container.js';
import { executeClaudeRun, newSessionId } from '../src/pipeline/stepRunner.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

/**
 * Regression (emeline): a feature_check audit was killed by --max-budget-usd AFTER it had
 * emitted a complete, schema-valid StructuredOutput. `validate` only ran on success, so the
 * finished work was discarded and the whole build failed two steps from the end.
 */
async function runWith(c: Container, over: Record<string, unknown>, opts: { withSchema?: boolean; validateOk?: boolean } = {}) {
  const projectId = 'p1';
  const slug = 'rescue-proj';
  const workspacePath = await c.ws.create(slug, 'Rescue');
  c.repos.projects.insert({ id: projectId, slug, title: 'Rescue', model: null, workspacePath, initialPrompt: 'x' });

  return executeClaudeRun(
    {
      ...c,
      // A runner that reproduces the observed shape: failure + a structured payload.
      runner: () => ({
        pid: null,
        cancel: () => undefined,
        result: Promise.resolve({
          outcome: 'failure' as const,
          sessionId: 's1',
          resultText: 'Budget presque épuisé, je rapporte les constats.',
          numTurns: 15,
          costUsd: 5,
          usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
          durationMs: 1000,
          failure: { kind: 'budget_exceeded' as const, message: 'Garde-fou budget atteint' },
          ...over,
        }),
      }),
    },
    {
      projectId,
      stepKey: 'feature_check',
      taskKey: 'audit',
      attempt: 1,
      isLastAttempt: true,
      session: { id: newSessionId(), resume: false, kind: 'step' },
      spec: {
        cwd: workspacePath,
        prompt: 'x',
        model: 'sonnet',
        tools: 'none',
        maxTurns: 8,
        timeoutMs: 60_000,
        ...(opts.withSchema === false ? {} : { jsonSchema: { type: 'object' } }),
      },
      validate: async () => (opts.validateOk === false ? { ok: false, kind: 'schema_invalid', message: 'invalide' } : { ok: true }),
    }
  );
}

describe('rescuing a structured answer from a killed session', () => {
  it('accepts a valid payload delivered before the kill, and flags it as rescued', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { result, rescued, runId } = await runWith(c, { structured: { features: [] } });

    expect(rescued).toBe(true);
    expect(result.outcome).toBe('success');
    expect(result.failure).toBeUndefined();
    expect(c.repos.stepRuns.byId(runId)!.status).toBe('succeeded');
  });

  it('leaves a failure untouched when nothing structured was delivered', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { result, rescued, runId } = await runWith(c, {});

    expect(rescued).toBe(false);
    expect(result.outcome).toBe('failure');
    expect(c.repos.stepRuns.byId(runId)!.status).toBe('failed');
  });

  it('does not rescue a payload that fails validation', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { result, rescued } = await runWith(c, { structured: { garbage: true } }, { validateOk: false });

    expect(rescued).toBe(false);
    expect(result.outcome).toBe('failure');
    // The ORIGINAL cause must survive, not be replaced by the validation error.
    expect(result.failure!.kind).toBe('budget_exceeded');
  });

  it('never rescues a step that did not ask for a structured answer', async () => {
    const { c } = await testContainer();
    cRef = c;
    // A tool step killed mid-edit has no deliverable to recover; its validate checks commits.
    const { rescued, result } = await runWith(c, { structured: { features: [] } }, { withSchema: false });

    expect(rescued).toBe(false);
    expect(result.outcome).toBe('failure');
  });

  it('never rescues a quota park — it must stay parked so the resume works', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { result, rescued, runId } = await runWith(c, {
      structured: { features: [] },
      failure: { kind: 'usage_limit', message: 'limite', resetAt: Date.now() + 3_600_000 },
    });

    expect(rescued).toBe(false);
    expect(result.outcome).toBe('failure');
    expect(c.repos.stepRuns.byId(runId)!.status).toBe('paused_limit');
  });

  it('never rescues an operator cancel', async () => {
    const { c } = await testContainer();
    cRef = c;
    const { rescued, runId } = await runWith(c, {
      structured: { features: [] },
      failure: { kind: 'canceled', message: 'annulé' },
    });

    expect(rescued).toBe(false);
    expect(c.repos.stepRuns.byId(runId)!.status).toBe('canceled');
  });
});
