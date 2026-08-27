import { describe, expect, it, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { seedQueuedProject, testContainer, waitFor, fastScript } from './helpers.js';
import { resolveModel } from '../src/pipeline/models.js';
import { shouldEscalateMicro } from '../src/pipeline/engine.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

describe('resolveModel (stepModels routing)', () => {
  it('routes per step: settings.stepModels beats project.model, project override beats everything', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Routing');
    const row = () => c.repos.projects.byId(id)!;

    // Balanced defaults: docs → haiku (fallback sonnet), architecture → opus (fallback sonnet)
    expect(resolveModel(c.repos, row(), 'docs')).toEqual({ model: 'haiku', fallbackModel: 'sonnet' });
    expect(resolveModel(c.repos, row(), 'architecture')).toEqual({ model: 'opus', fallbackModel: 'sonnet' });
    expect(resolveModel(c.repos, row(), 'implement_task').model).toBe('sonnet');

    // stepModels wins over the project-level model…
    c.repos.projects.patch(id, { model: 'opus' });
    expect(resolveModel(c.repos, row(), 'docs').model).toBe('haiku');
    // …but a per-project step override wins over stepModels.
    c.repos.projects.patch(id, { step_model_overrides: JSON.stringify({ docs: 'opus' }) });
    expect(resolveModel(c.repos, row(), 'docs').model).toBe('opus');
    // Unknown step key: falls through to project.model.
    expect(resolveModel(c.repos, row(), 'nonexistent_step').model).toBe('opus');
  });
});

describe('live micro-modifications', () => {
  it('appends one task and runs the reduced pipeline back to the deploy gate (manual)', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Flow');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');
    const runIdsBefore = new Set(c.repos.stepRuns.listForProject(id).map((r) => r.id));
    expect(c.repos.tasks.list(id)).toHaveLength(3);

    const outcome = await c.micro.create(id, 'Corrige le libellé du bouton principal.');
    expect(outcome).toEqual({ status: 'queued', taskKey: 'T04' });
    const queued = c.repos.projects.byId(id)!;
    // The fast test scheduler may have picked it up already — queued or building both prove the requeue.
    expect(['queued', 'building']).toContain(queued.status);
    expect(queued.pipeline_mode).toBe('micro');

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'micro run');
    const after = c.repos.projects.byId(id)!;
    expect(after.pipeline_mode).toBe('full');

    // Only the reduced pipeline ran: implement_task on T04 — no design/arch/polish/docs re-run
    // (final_verify verifies directly and only spawns a session on failure → no run row here).
    const newRuns = c.repos.stepRuns.listForProject(id).filter((r) => !runIdsBefore.has(r.id));
    expect(newRuns.map((r) => r.step_key)).toEqual(['implement_task']);
    expect(newRuns[0].task_key).toBe('T04');

    // Task done, request settled, SPEC updated.
    expect(c.repos.tasks.get(id, 'T04')!.status).toBe('done');
    expect(c.repos.micro.list(id)[0].status).toBe('done');
    const spec = fs.readFileSync(path.join(after.workspace_path, 'docs', 'SPEC.md'), 'utf8');
    expect(spec).toContain('## Micro-révisions');
    expect(spec).toContain('T04');
  });

  it('issue-sourced fix on an auto-mode project returns straight to deployed', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Auto');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');
    c.repos.projects.casStatus(id, ['awaiting_deploy_approval'], 'deployed');
    c.repos.projects.patch(id, { github_repo: 'usrred/micro-auto', github_private: 1, github_auto_mode: 1 });

    const outcome = await c.micro.create(id, 'Issue: le bouton export est cassé.', 'issue', 42);
    expect(outcome.status).toBe('queued');
    await waitFor(() => c.repos.projects.byId(id)!.status === 'deployed', 20_000, 'retour direct deployed');
    expect(c.repos.micro.list(id)[0].status).toBe('done');
  });

  it('appends the task into a running build (no requeue)', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Live');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'building', 10_000, 'build démarré');

    const outcome = await c.micro.create(id, 'Ajoute un raccourci clavier R.');
    expect(outcome.status).toBe('appended');

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 25_000, 'build complet');
    // The appended task was picked up by the SAME build (4 tasks all done).
    const tasks = c.repos.tasks.list(id);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    expect(c.repos.micro.list(id)[0].status).toBe('done');
  });
});

describe('implement_task prompt for GitHub-auto issue micro-requests (T10)', () => {
  it('issue-sourced fix on an auto-mode project gets the tests/docs instruction', async () => {
    let capturedPrompt: string | undefined;
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Micro-modification simulée')) {
        capturedPrompt = spec.prompt;
      }
      return undefined;
    });
    const { c } = await testContainer({ script });
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Auto Prompt');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');
    c.repos.projects.casStatus(id, ['awaiting_deploy_approval'], 'deployed');
    c.repos.projects.patch(id, { github_repo: 'usrred/micro-auto-prompt', github_private: 1, github_auto_mode: 1 });

    const outcome = await c.micro.create(id, 'Issue: le bouton export est cassé.', 'issue', 43);
    expect(outcome.status).toBe('queued');
    await waitFor(() => c.repos.projects.byId(id)!.status === 'deployed', 20_000, 'retour direct deployed');

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toMatch(/issue GitHub traitée en mode automatique/);
    expect(capturedPrompt).toMatch(/tests et la documentation/);
  });

  it('manual micro request does not get the GitHub-auto tests/docs instruction', async () => {
    let capturedPrompt: string | undefined;
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Micro-modification simulée')) {
        capturedPrompt = spec.prompt;
      }
      return undefined;
    });
    const { c } = await testContainer({ script });
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Manual Prompt');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');

    const outcome = await c.micro.create(id, 'Corrige le libellé du bouton principal.');
    expect(outcome.status).toBe('queued');
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'micro run');

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).not.toMatch(/issue GitHub traitée en mode automatique/);
  });

  it('issue-sourced fix on a project WITHOUT auto mode does not get the instruction', async () => {
    let capturedPrompt: string | undefined;
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Micro-modification simulée')) {
        capturedPrompt = spec.prompt;
      }
      return undefined;
    });
    const { c } = await testContainer({ script });
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Issue No Auto');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');

    const outcome = await c.micro.create(id, 'Issue: le bouton export est cassé.', 'issue', 44);
    expect(outcome.status).toBe('queued');
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'micro run');

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).not.toMatch(/issue GitHub traitée en mode automatique/);
  });
});

describe('shouldEscalateMicro (T06 scope decision)', () => {
  it('final_verify failing always signals scope beyond a micro-modification', () => {
    expect(shouldEscalateMicro('final_verify', 'Corrige la faute de frappe dans le libellé.')).toBe(true);
  });

  it('implement_task failing on an ordinary small request is a plain failure, not scope', () => {
    expect(shouldEscalateMicro('implement_task', 'Corrige la faute de frappe dans le libellé.')).toBe(false);
  });

  it('implement_task failing on a request already carrying full-scope signals escalates too', () => {
    expect(shouldEscalateMicro('implement_task', 'Ajoute une nouvelle fonctionnalité de recherche par tags.')).toBe(true);
  });
});

describe('micro pipeline failure escalates to the full pipeline (T06)', () => {
  it('a scope-exceeding micro request that fails is escalated via reopen instead of staying failed', async () => {
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Micro-modification simulée')) {
        return { result: { outcome: 'failure', failure: { kind: 'crash', message: 'boom (simulation)' } } };
      }
      return undefined;
    });
    const { c } = await testContainer({ script });
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Escalation');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');

    const reopen = vi.spyOn(c.spec, 'reopen').mockResolvedValue(undefined);
    const request = 'Ajoute une nouvelle fonctionnalité de recherche par tags dans tout le catalogue.';
    const outcome = await c.micro.create(id, request);
    expect(outcome.status).toBe('queued');

    await waitFor(() => c.repos.micro.list(id)[0].status === 'escalated', 20_000, 'escalade micro');
    expect(reopen).toHaveBeenCalledTimes(1);
    expect(reopen.mock.calls[0][0]).toBe(id);
    expect(reopen.mock.calls[0][1]).toContain(request);

    const settled = c.repos.micro.list(id)[0];
    expect(settled.error_message).toContain('escaladé vers le pipeline complet');
    // The task itself failed — the project was marked `failed` before the escalation kicked in.
    expect(c.repos.tasks.get(id, settled.task_key!)!.status).toBe('failed');
  });

  it('an ordinary micro-task failure (no scope signal) stays a plain failure — no reopen', async () => {
    const script = fastScript((spec) => {
      if (spec.tools !== 'none' && spec.prompt.includes('Micro-modification simulée')) {
        return { result: { outcome: 'failure', failure: { kind: 'crash', message: 'boom (simulation)' } } };
      }
      return undefined;
    });
    const { c } = await testContainer({ script });
    cRef = c;
    const id = await seedQueuedProject(c, 'Micro Plain Failure');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');

    const reopen = vi.spyOn(c.spec, 'reopen').mockResolvedValue(undefined);
    const outcome = await c.micro.create(id, 'Corrige le libellé du bouton principal.');
    expect(outcome.status).toBe('queued');

    await waitFor(() => c.repos.projects.byId(id)!.status === 'failed', 20_000, 'échec micro');
    expect(c.repos.micro.list(id)[0].status).toBe('failed');
    expect(reopen).not.toHaveBeenCalled();
  });
});

describe('github auto-mode guard', () => {
  it('refuses auto mode on a public repo', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Public Repo');
    c.repos.projects.patch(id, { github_repo: 'usrred/public-repo', github_private: 0 });
    expect(() => c.github.setAutoMode(id, true)).toThrow(/dépôts privés/);
    // …and works on a private one.
    c.repos.projects.patch(id, { github_private: 1 });
    expect(c.github.setAutoMode(id, true).github_auto_mode).toBe(1);
  });
});

describe('issues repo', () => {
  it('upserts idempotently and tracks GitHub-side changes', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Issues Repo');
    const base = { number: 7, title: 'Bug export', body: 'Le CSV est vide', author: 'alice', ghUpdatedAt: '2026-07-22T10:00:00Z' };

    const first = c.repos.issues.upsert(id, base);
    expect(first.changed).toBe(true);
    const again = c.repos.issues.upsert(id, base);
    expect(again.changed).toBe(false);
    expect(again.row.id).toBe(first.row.id);

    const edited = c.repos.issues.upsert(id, { ...base, title: 'Bug export CSV', ghUpdatedAt: '2026-07-22T11:00:00Z' });
    expect(edited.changed).toBe(true);
    expect(edited.row.title).toBe('Bug export CSV');
    expect(c.repos.issues.list(id)).toHaveLength(1);

    // Absent from the next sync → marked closed.
    const closed = c.repos.issues.markClosedExcept(id, []);
    expect(closed).toHaveLength(1);
    expect(closed[0].gh_state).toBe('closed');

    // Trusted users round-trip.
    c.repos.issues.addTrustedUser('alice');
    c.repos.issues.addTrustedUser('alice');
    expect(c.repos.issues.trustedUsers()).toEqual(['alice']);
    expect(c.repos.issues.isTrusted('alice')).toBe(true);
    c.repos.issues.removeTrustedUser('alice');
    expect(c.repos.issues.isTrusted('alice')).toBe(false);
  });
});
