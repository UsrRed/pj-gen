import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { ConsoleService, type PtyLike, type PtySpawn } from '../src/console/consoleService.js';
import { testConfig, testContainer, tmpDir, waitFor } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

/** Echoing fake terminal: what is written comes back as output; "exit\r" ends it. */
function fakePty(): { spawn: PtySpawn; spawned: { file: string; env: NodeJS.ProcessEnv; cols: number; rows: number }[]; sizes: string[] } {
  const spawned: { file: string; env: NodeJS.ProcessEnv; cols: number; rows: number }[] = [];
  const sizes: string[] = [];
  const spawn: PtySpawn = (file, _args, opts) => {
    spawned.push({ file, env: opts.env, cols: opts.cols, rows: opts.rows });
    let onData: (d: string) => void = () => undefined;
    let onExit: (e: { exitCode: number }) => void = () => undefined;
    const pty: PtyLike = {
      pid: 4242,
      write: (d) => (d === 'exit\r' ? setTimeout(() => onExit({ exitCode: 0 }), 1) : setTimeout(() => onData(d), 1)),
      resize: (c, r) => sizes.push(`${c}x${r}`),
      kill: () => setTimeout(() => onExit({ exitCode: 129 }), 1),
      onData: (fn) => (onData = fn),
      onExit: (fn) => (onExit = fn),
    };
    setTimeout(() => onData('$ '), 1);
    return pty;
  };
  return { spawn, spawned, sizes };
}

describe('ConsoleService', () => {
  it('keeps one shell, buffers its output for re-attach, and reports the exit', async () => {
    const fake = fakePty();
    let exits = 0;
    const svc = new ConsoleService(testConfig(tmpDir('console')), { spawn: fake.spawn, onExit: () => exits++ });
    const s = await svc.start(80, 24);
    expect(s).toMatchObject({ available: true, running: true, pid: 4242 });
    // Idempotent: a second start (second tab, reload) reuses the shell and only resizes it.
    await svc.start(120, 40);
    expect(fake.spawned).toHaveLength(1);
    expect(fake.sizes).toEqual(['120x40']);
    expect(fake.spawned[0].env.TERM).toBe('xterm-256color');
    expect(fake.spawned[0].env.CI).toBeUndefined();
    expect(fake.spawned[0].env.GIT_CONFIG_COUNT).toBeDefined();

    svc.write('gh auth status\r');
    await waitFor(() => svc.snapshot().includes('gh auth status'), 2_000, 'echo');
    expect(svc.snapshot().startsWith('$ ')).toBe(true);

    svc.write('exit\r');
    await waitFor(() => !svc.status().running, 2_000, 'exit');
    expect(svc.status().exitCode).toBe(0);
    expect(exits).toBe(1);
  });

  it('turns a spawn failure into an explicit error, leaving no half-started shell', async () => {
    const svc = new ConsoleService(testConfig(tmpDir('console')), {
      spawn: () => {
        throw new Error('boom');
      },
    });
    await expect(svc.start(80, 24)).rejects.toThrow(/Console : impossible de lancer .*boom/);
    expect(svc.status().running).toBe(false);
  });
});

// The real native module, as shipped in the image (skipped where node-pty is not built).
const hasNodePty = await import('node-pty').then(
  () => true,
  () => false
);
describe.skipIf(!hasNodePty)('ConsoleService with node-pty', () => {
  it('runs a real shell in a pty, keeping the server PATH', async () => {
    const svc = new ConsoleService(testConfig(tmpDir('console')));
    await svc.start(100, 30);
    svc.write('stty size; echo "tty=$(tty)"; echo "path=$PATH"; exit\r');
    await waitFor(() => !svc.status().running, 10_000, 'shell exit');
    expect(svc.snapshot()).toContain('30 100');
    expect(svc.snapshot()).toMatch(/tty=\/dev\/pts\//);
    expect(svc.snapshot()).toContain(`path=${process.env.PATH}`);
  });
});

describe('console routes', () => {
  async function setup() {
    const fake = fakePty();
    const { c } = await testContainer({ ptySpawn: fake.spawn });
    cRef = c;
    const app = await createApp(c);
    appRef = app;
    return { c, app, fake };
  }

  it('starts, takes input, and refuses cross-origin or cross-site browser requests', async () => {
    const { c, app } = await setup();
    const host = 'pj-gen.example.ts.net';
    const ok = await app.inject({ method: 'POST', url: '/api/console/start', headers: { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' }, payload: { cols: 80, rows: 24 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ running: true });

    // The Aperçu relay: same host, other port → same-site, not same-origin.
    const relay = await app.inject({ method: 'POST', url: '/api/console/input', headers: { host, origin: `https://${host}:9443`, 'sec-fetch-site': 'same-site' }, payload: { data: 'id\r' } });
    expect(relay.statusCode).toBe(403);
    // Old browser without Sec-Fetch-*: Origin alone must still match.
    const evil = await app.inject({ method: 'POST', url: '/api/console/input', headers: { host, origin: 'https://evil.example' }, payload: { data: 'id\r' } });
    expect(evil.statusCode).toBe(403);
    const opaque = await app.inject({ method: 'POST', url: '/api/console/input', headers: { host, origin: 'null' }, payload: { data: 'id\r' } });
    expect(opaque.statusCode).toBe(403);

    const input = await app.inject({ method: 'POST', url: '/api/console/input', payload: { data: 'echo ok\r' } });
    expect(input.statusCode).toBe(200);
    await waitFor(() => c.console.snapshot().includes('echo ok'), 2_000, 'input reached the shell');
    expect(c.console.snapshot()).not.toContain('id\r');
  });

  it('is disabled while pj-gen is exposed on the LAN', async () => {
    const { c, app } = await setup();
    c.lan.status = () => ({ enabled: true, urls: [], errors: [], alreadyExposed: false });
    const res = await app.inject({ method: 'GET', url: '/api/console' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/réseau local/);
  });

  it('validates sizes and input', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/console/start', payload: { cols: 2, rows: 24 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/console/input', payload: { data: '' } })).statusCode).toBe(400);
  });
});
