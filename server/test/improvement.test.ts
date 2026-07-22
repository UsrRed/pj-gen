import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

describe('improvement iterations (reopen)', () => {
  it('rebuilds only the delta: scaffold skipped, tasks appended and renumbered', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Iter Flow');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');

    const scaffoldRunsAfterBuild = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'scaffold').length;
    expect(c.repos.tasks.list(id)).toHaveLength(3);

    // --- reopen for an improvement iteration
    await c.spec.reopen(id, 'Ajoute un mode sombre et corrige le rendu.');
    const reopened = c.repos.projects.byId(id)!;
    expect(reopened.status).toBe('draft');
    expect(reopened.iteration).toBe(2);
    expect(reopened.enqueued_at).toBeNull();

    // cadrage happens (fake), then the user validates the revised spec
    await waitFor(() => c.repos.messages.list(id).some((m) => m.content.includes('Itération 2')), 5_000, 'message de réouverture');
    c.ws.writeFile(reopened.workspace_path, 'docs/SPEC.md', '# SPEC v2\n\n## Révision 2\nMode sombre + rendu corrigé.\n\nContenu suffisant pour être valide.');
    expect(c.repos.projects.casStatus(id, ['draft'], 'spec_ready')).toBe(true);
    await c.spec.validateSpec(id);

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build itération 2');

    // scaffold was NOT re-run
    const scaffoldRunsAfterIter = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'scaffold').length;
    expect(scaffoldRunsAfterIter).toBe(scaffoldRunsAfterBuild);

    // tasks were appended with renumbered keys (fake breakdown returns T01..T03 again → T04..T06)
    const tasks = c.repos.tasks.list(id);
    expect(tasks).toHaveLength(6);
    expect(tasks.map((t) => t.task_key)).toEqual(['T01', 'T02', 'T03', 'T04', 'T05', 'T06']);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);
    // renumbered dependsOn stayed within the new batch (fake T02 depends on T01 → T05 depends on T04)
    const t05 = tasks.find((t) => t.task_key === 'T05')!;
    expect(JSON.parse(t05.depends_on)).toEqual(['T04']);

    const tasksJson = JSON.parse(fs.readFileSync(path.join(reopened.workspace_path, 'docs', 'tasks.json'), 'utf8'));
    expect(tasksJson.tasks).toHaveLength(6);
  });

  it('rejects reopen while the project is building or in cadrage', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'No Reopen');
    await expect(c.spec.reopen(id, 'trop tôt')).rejects.toThrow(/Réouverture impossible/);
  });
});
