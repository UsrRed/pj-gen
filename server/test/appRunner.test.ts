import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

async function seedSettledProject(c: Container, title: string, runCmd: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const workspacePath = await c.ws.create(slug, title);
  const id = `${slug}-id`;
  c.repos.projects.insert({ id, slug, title, model: null, workspacePath, initialPrompt: 'x' });
  c.repos.projects.patch(id, {
    stack: JSON.stringify({
      language: 'javascript',
      framework: 'node',
      package_manager: 'npm',
      install_cmd: '',
      build_cmd: '',
      test_cmd: '',
      run_cmd: runCmd,
    }),
  });
  c.repos.projects.casStatus(id, ['draft'], 'canceled'); // settled → runnable
  return id;
}

describe('AppRunner (Aperçu)', () => {
  it('starts the app, detects the local URL, streams logs, and stops the process group', async () => {
    const { c, base } = await testContainer();
    cRef = c;
    const marker = path.join(base, 'app-alive');
    const id = await seedSettledProject(
      c,
      'App Web',
      `echo "démarrage du serveur"; echo "listening on http://localhost:5099"; touch ${marker}; sleep 60`
    );

    const statuses: { running: boolean; url: string | null }[] = [];
    c.bus.subscribe({ projectId: null, fn: (_i, type, _p, payload) => type === 'app.status' && statuses.push(payload as never) });

    c.appRunner.start(id);
    await waitFor(() => c.appRunner.state(id).url !== null, 5000, 'URL détectée');
    await waitFor(() => fs.existsSync(marker), 5000, 'process réellement lancé');

    const st = c.appRunner.state(id);
    expect(st.running).toBe(true);
    expect(st.url).toBe('http://localhost:5099');
    expect(st.lines.join('\n')).toContain('démarrage du serveur');
    expect(() => c.appRunner.start(id)).toThrow(/déjà/);

    const pid = (c.db.prepare('SELECT pid FROM app_runs WHERE project_id = ?').get(id) as { pid: number }).pid;
    await c.appRunner.stop(id);
    expect(c.appRunner.state(id).running).toBe(false);
    await waitFor(() => !fs.existsSync(`/proc/${pid}`), 6000, 'process tué');
    expect(c.db.prepare('SELECT COUNT(*) AS n FROM app_runs').get()).toEqual({ n: 0 });
    expect(statuses.some((s) => s.running && s.url === 'http://localhost:5099')).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ running: false });
  }, 15_000);

  it('refuses to run while the project is building or without run_cmd', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedSettledProject(c, 'App Building', 'sleep 5');
    c.repos.projects.casStatus(id, ['canceled'], 'draft');
    c.repos.projects.casStatus(id, ['draft'], 'spec_ready');
    c.repos.projects.casStatus(id, ['spec_ready'], 'queued');
    c.repos.projects.casStatus(id, ['queued'], 'building');
    expect(() => c.appRunner.start(id)).toThrow(/construction/);

    const id2 = await seedSettledProject(c, 'App NoRun', 'x');
    c.repos.projects.patch(id2, { stack: JSON.stringify({ run_cmd: '' }) });
    expect(() => c.appRunner.start(id2)).toThrow(/run_cmd/);
  });

  it('boot sweep kills orphaned app pids recorded by a previous process', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedSettledProject(c, 'App Orphan', 'sleep 120');
    c.appRunner.start(id);
    const pid = (c.db.prepare('SELECT pid FROM app_runs WHERE project_id = ?').get(id) as { pid: number }).pid;
    await waitFor(() => fs.existsSync(`/proc/${pid}`), 3000, 'process démarré');

    // Simulate a fresh boot on the same DB rows: a new runner sweeps the recorded pid.
    const { AppRunner } = await import('../src/preview/appRunner.js');
    const fresh = new AppRunner({ ...c, repos: c.repos } as never);
    const killed = fresh.sweepOrphans();
    expect(killed).toBe(1);
    await waitFor(() => !fs.existsSync(`/proc/${pid}`), 8000, 'orphelin tué');
    expect(c.db.prepare('SELECT COUNT(*) AS n FROM app_runs').get()).toEqual({ n: 0 });
  }, 15_000);
});
