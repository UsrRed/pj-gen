import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

describe('Engine (fake runner)', () => {
  it('runs the full pipeline to awaiting_deploy_approval', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Echo Mini');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');

    const row = c.repos.projects.byId(id)!;
    expect(row.current_step_key).toBeNull();
    const tasks = c.repos.tasks.list(id);
    expect(tasks.length).toBe(3);
    expect(tasks.every((t) => t.status === 'done')).toBe(true);

    const runs = c.repos.stepRuns.listForProject(id);
    const stepKeys = new Set(runs.map((r) => r.step_key));
    for (const k of ['design', 'architecture', 'task_breakdown', 'scaffold', 'implement_task', 'polish', 'review_fix', 'feature_check', 'docs']) {
      expect(stepKeys.has(k as never)).toBe(true);
    }
    expect(runs.every((r) => r.status === 'succeeded')).toBe(true);
    // the autonomous design step produced the reference mockup (no HITL)
    expect(fs.existsSync(path.join(row.workspace_path, 'docs', 'design', 'mockup.html'))).toBe(true);
    expect(fs.existsSync(path.join(row.workspace_path, 'docs', 'design', 'NOTES.md'))).toBe(true);

    // token usage is captured per run and aggregated on the project summary
    expect(runs.every((r) => r.input_tokens > 0 && r.output_tokens > 0)).toBe(true);
    const summary = c.repos.projects.summary(row);
    expect(summary.tokens.total).toBeGreaterThan(0);
    expect(summary.tokens.total).toBe(summary.tokens.input + summary.tokens.output + summary.tokens.cacheCreation + summary.tokens.cacheRead);
    expect((summary as unknown as { costUsd?: number }).costUsd).toBeUndefined();

    const workspace = row.workspace_path;
    expect(fs.existsSync(path.join(workspace, 'docs', 'ARCHITECTURE.md'))).toBe(true);
    const tasksJson = JSON.parse(fs.readFileSync(path.join(workspace, 'docs', 'tasks.json'), 'utf8'));
    expect(tasksJson.tasks).toHaveLength(3);
    expect(tasksJson.tasks.every((t: { status: string }) => t.status === 'done')).toBe(true);
  });

  it('marks the project failed when a step exhausts its attempts', async () => {
    const { c } = await testContainer({
      script: fastScript((spec) => {
        const props = Object.keys((spec.jsonSchema as { properties?: object } | undefined)?.properties ?? {});
        if (props.includes('architecture_markdown')) {
          return { delayMs: 10, result: { outcome: 'failure', failure: { kind: 'crash', message: 'boom' } } };
        }
        return undefined; // other steps (incl. design) use the default fake outputs
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Broken');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'failed', 10_000, 'échec projet');
    expect(c.repos.projects.byId(id)!.error_message).toContain('architecture');
  });
});
