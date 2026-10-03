import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { buildContainer, type Container } from '../src/container.js';
import type { RunnerFn } from '../src/claude/types.js';
import { defaultFakeScript, createFakeRunner, type FakeScript } from '../src/claude/fakeRunner.js';
import type { SendFn } from '../src/core/notifier.js';
import type { PtySpawn } from '../src/console/consoleService.js';

export function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pjgen-${prefix}-`));
}

export function testConfig(base: string, overrides: Partial<Config> = {}): Config {
  return loadConfig({
    dataDir: path.join(base, 'data'),
    dbPath: ':memory:',
    workspaceRoot: path.join(base, 'ws'),
    fakeCli: true,
    schedulerTickMs: 60,
    logFlushMs: 10,
    resumeJitterMaxMs: 5,
    host: '127.0.0.1',
    port: 0,
    ...overrides,
  });
}

/** defaultFakeScript with near-zero delays, optionally intercepted per call. */
export function fastScript(intercept?: (...args: Parameters<FakeScript>) => ReturnType<FakeScript> | undefined): FakeScript {
  return (spec, i) => {
    const custom = intercept?.(spec, i);
    if (custom) return { ...custom, delayMs: custom.delayMs ?? 20 };
    const o = defaultFakeScript(spec, i);
    return { ...o, delayMs: 20, events: [] };
  };
}

export async function testContainer(
  opts: { script?: FakeScript; config?: Partial<Config>; notifySend?: SendFn; ptySpawn?: PtySpawn } = {}
): Promise<{ c: Container; base: string }> {
  const base = tmpDir('t');
  fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
  const config = testConfig(base, opts.config);
  const runner: RunnerFn = createFakeRunner(opts.script ?? fastScript());
  const c = await buildContainer(config, { runner, notifySend: opts.notifySend, ptySpawn: opts.ptySpawn });
  return { c, base };
}

/** Create a project with a validated spec, ready to be scheduled. */
export async function seedQueuedProject(c: Container, title: string): Promise<string> {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const workspacePath = await c.ws.create(slug, title);
  const id = `${slug}-id`;
  c.repos.projects.insert({ id, slug, title, model: null, workspacePath, initialPrompt: `Projet ${title}` });
  c.ws.writeFile(workspacePath, 'docs/SPEC.md', `# SPEC — ${title}\n\nObjectif de test avec assez de contenu pour être valide.\n`);
  c.repos.projects.casStatus(id, ['draft'], 'spec_ready');
  await c.spec.validateSpec(id);
  return id;
}

export async function waitFor(cond: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout en attendant: ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
