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

const GAP_AUDIT = {
  features: [
    { key: 'F1', title: 'Logique', status: 'ok', evidence: 'ok', fix_hint: '' },
    { key: 'F6', title: 'Animations', status: 'missing', evidence: 'framer-motion jamais importé', fix_hint: 'câbler le rendu' },
  ],
};
const OK_AUDIT = {
  features: [
    { key: 'F1', title: 'Logique', status: 'ok', evidence: 'ok', fix_hint: '' },
    { key: 'F6', title: 'Animations', status: 'ok', evidence: 'rendu constaté', fix_hint: '' },
  ],
};

describe('stepFeatureCheck (fake runner)', () => {
  it('audits, fixes the gaps, re-audits, then completes the pipeline', async () => {
    let audits = 0;
    let fixPrompt: string | null = null;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        const props = Object.keys((spec.jsonSchema as { properties?: object } | undefined)?.properties ?? {});
        if (props.includes('features')) {
          audits += 1;
          return { delayMs: 15, result: { outcome: 'success', structured: audits === 1 ? GAP_AUDIT : OK_AUDIT } };
        }
        if (spec.tools === 'default' && spec.prompt.includes('audit de conformité a trouvé des écarts')) {
          fixPrompt = spec.prompt;
          return { delayMs: 15, result: { outcome: 'success', resultText: 'corrigé' } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Audit Flow');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'pipeline complet');
    expect(audits).toBe(2);
    expect(fixPrompt).toContain('F6');
    expect(fixPrompt).toContain('framer-motion jamais importé');

    const auditRuns = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'feature_check');
    expect(auditRuns.filter((r) => r.task_key === 'audit')).toHaveLength(2);
    expect(auditRuns.filter((r) => r.task_key === 'fix-1')).toHaveLength(1);

    const workspace = c.repos.projects.byId(id)!.workspace_path;
    const md = fs.readFileSync(path.join(workspace, 'docs', 'FEATURE_AUDIT.md'), 'utf8');
    expect(md).toContain('F6');
  });

  it('fails the project when features stay missing after the fix rounds', async () => {
    const { c } = await testContainer({
      script: fastScript((spec) => {
        const props = Object.keys((spec.jsonSchema as { properties?: object } | undefined)?.properties ?? {});
        if (props.includes('features')) {
          return { delayMs: 15, result: { outcome: 'success', structured: GAP_AUDIT } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await seedQueuedProject(c, 'Audit Fail');
    c.scheduler.start();

    await waitFor(() => c.repos.projects.byId(id)!.status === 'failed', 20_000, 'échec sur audit');
    expect(c.repos.projects.byId(id)!.error_message).toContain('F6');
  });
});
