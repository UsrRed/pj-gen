import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { REQUEST_CHECK_FIX_ROUNDS } from '../src/pipeline/steps.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

const GAP = {
  needs: [
    {
      need: 'Les icônes s’affichent sur l’instance déployée',
      status: 'missing',
      evidence: 'mapper modifié mais IMPORTER_VERSION inchangée: les URL déjà stockées restent fausses',
      fix_hint: 'incrémenter IMPORTER_VERSION pour déclencher le réimport',
    },
  ],
  summary: 'Le code est corrigé mais les données existantes ne le seront pas.',
};
const PARTIAL = { ...GAP, needs: [{ ...GAP.needs[0], status: 'partial' }] };
const OK = {
  needs: [{ need: 'Les icônes s’affichent sur l’instance déployée', status: 'ok', evidence: 'réimport déclenché au démarrage', fix_hint: '' }],
  summary: 'Demande satisfaite.',
};

const isCheck = (spec: { jsonSchema?: unknown }) =>
  Object.keys((spec.jsonSchema as { properties?: object } | undefined)?.properties ?? {}).includes('needs');

/** Built project, ready to receive a micro request. */
async function builtProject(c: Container, title: string): Promise<string> {
  const id = await seedQueuedProject(c, title);
  c.scheduler.start();
  await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'build initial');
  return id;
}

describe('request_check step (micro pipeline)', () => {
  it('re-checks after a fix session and settles the request done once the need is met', async () => {
    let checks = 0;
    let checkTools: unknown = null;
    let fixPrompt: string | null = null;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        if (isCheck(spec)) {
          checks += 1;
          checkTools = spec.tools;
          return { delayMs: 10, result: { outcome: 'success', structured: checks === 1 ? GAP : OK } };
        }
        if (spec.tools === 'default' && spec.prompt.includes('Le contrôle de la demande a trouvé')) {
          fixPrompt = spec.prompt;
          return { delayMs: 10, result: { outcome: 'success', resultText: 'corrigé' } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await builtProject(c, 'Check Fix');

    const outcome = await c.micro.create(id, 'Images invalides: les icônes renvoient access denied.', 'issue', 7);
    expect(outcome.status).toBe('queued');
    await waitFor(() => c.repos.micro.list(id)[0].status === 'done', 20_000, 'requête soldée');

    expect(checks).toBe(2);
    // The checker sees untrusted issue text: it must never get write tools.
    expect(checkTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(fixPrompt).toContain('IMPORTER_VERSION');

    const runs = c.repos.stepRuns.listForProject(id).filter((r) => r.step_key === 'request_check');
    expect(runs.filter((r) => r.task_key === 'check-t04')).toHaveLength(2);
    expect(runs.filter((r) => r.task_key === 'fix-t04-1')).toHaveLength(1);

    const ws = c.repos.projects.byId(id)!.workspace_path;
    expect(fs.readFileSync(path.join(ws, 'docs', 'request-checks', 't04.md'), 'utf8')).toContain('Demande satisfaite.');
  });

  it('residual partial gaps after the fix rounds are accepted: the request is done, not failed', async () => {
    let checks = 0;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        if (isCheck(spec)) {
          checks += 1;
          return { delayMs: 10, result: { outcome: 'success', structured: PARTIAL } };
        }
        if (spec.tools === 'default' && spec.prompt.includes('Le contrôle de la demande a trouvé')) {
          return { delayMs: 10, result: { outcome: 'success', resultText: 'tenté' } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await builtProject(c, 'Check Partial');

    await c.micro.create(id, 'Corrige les icônes.');
    await waitFor(() => c.repos.micro.list(id)[0].status === 'done', 20_000, 'requête terminée');
    expect(checks).toBe(REQUEST_CHECK_FIX_ROUNDS + 1);
  });

  it('gives up after the max fix rounds: request failed with the gaps, never done, project not blocked', async () => {
    let checks = 0;
    let fixes = 0;
    const { c } = await testContainer({
      script: fastScript((spec) => {
        if (isCheck(spec)) {
          checks += 1;
          return { delayMs: 10, result: { outcome: 'success', structured: GAP } };
        }
        if (spec.tools === 'default' && spec.prompt.includes('Le contrôle de la demande a trouvé')) {
          fixes += 1;
          return { delayMs: 10, result: { outcome: 'success', resultText: 'tenté' } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await builtProject(c, 'Check Give Up');

    await c.micro.create(id, 'Corrige les icônes.');
    await waitFor(() => c.repos.micro.list(id)[0].status === 'failed', 20_000, 'requête en échec');

    expect(checks).toBe(REQUEST_CHECK_FIX_ROUNDS + 1);
    expect(fixes).toBe(REQUEST_CHECK_FIX_ROUNDS);
    const mr = c.repos.micro.list(id)[0];
    expect(mr.error_message).toContain('request_check');
    expect(mr.error_message).toContain('IMPORTER_VERSION');
    // The task itself is done — that alone must not make the request done.
    expect(c.repos.tasks.get(id, 'T04')!.status).toBe('done');
    // Only the request fails: the cycle finishes (final_verify) and the project stays usable.
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 20_000, 'cycle terminé');
    expect(c.repos.projects.byId(id)!.error_message).toBeNull();
  });

  it('a rejected issue fix on an auto-mode project still returns it to deployed', async () => {
    const { c } = await testContainer({
      script: fastScript((spec) => {
        if (isCheck(spec)) return { delayMs: 10, result: { outcome: 'success', structured: GAP } };
        if (spec.tools === 'default' && spec.prompt.includes('Le contrôle de la demande a trouvé')) {
          return { delayMs: 10, result: { outcome: 'success', resultText: 'tenté' } };
        }
        return undefined;
      }),
    });
    cRef = c;
    const id = await builtProject(c, 'Check Auto');
    c.repos.projects.casStatus(id, ['awaiting_deploy_approval'], 'deployed');
    c.repos.projects.patch(id, { github_repo: 'usrred/check-auto', github_private: 1, github_auto_mode: 1 });

    await c.micro.create(id, 'Corrige les icônes.', 'issue', 9);
    await waitFor(() => c.repos.micro.list(id)[0].status === 'failed', 20_000, 'requête en échec');
    await waitFor(() => c.repos.projects.byId(id)!.status === 'deployed', 20_000, 'retour direct deployed');
  });
});

describe('MicroRepo.settleForProject', () => {
  it('a failed cycle settles open requests as failed even when their task is done', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await builtProject(c, 'Settle Fail');
    const r = c.repos.micro.insert(id, 'issue', 'demande', null);
    c.repos.micro.patch(r.id, { status: 'task_created', task_key: 'T01' });
    expect(c.repos.tasks.get(id, 'T01')!.status).toBe('done');

    const [settled] = c.repos.micro.settleForProject(id, 'final_verify: tests rouges');
    expect(settled.status).toBe('failed');
    expect(settled.error_message).toBe('final_verify: tests rouges');
  });
});

describe('WorkspaceManager.diffForTask', () => {
  it('diffs from the micro request commit to HEAD, bookkeeping excluded', async () => {
    const { c } = await testContainer();
    cRef = c;
    const ws = await c.ws.create('diff-task', 'Diff Task');
    c.ws.writeFile(ws, 'src/before.js', 'old\n');
    await c.ws.commitAll(ws, 'feat(t03): earlier work');
    c.ws.writeFile(ws, 'docs/SPEC.md', '# SPEC\n');
    await c.ws.commitAll(ws, 'docs: micro request t04');
    c.ws.writeFile(ws, 'src/icons.js', 'export const iconUrl = (g) => `/api/icons/${g}`;\n');
    c.ws.writeFile(ws, 'docs/PROGRESS.md', 'T04 terminé\n');
    await c.ws.commitAll(ws, 'feat(t04): icon proxy');

    const diff = await c.ws.diffForTask(ws, 'T04');
    expect(diff).toContain('src/icons.js');
    expect(diff).toContain('/api/icons/');
    expect(diff).not.toContain('src/before.js');
    expect(diff).not.toContain('PROGRESS.md');
    expect(await c.ws.diffForTask(ws, 'T99')).toBeNull();
  });
});
