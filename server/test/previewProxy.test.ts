import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import { PreviewProxy } from '../src/preview/previewProxy.js';
import { testContainer, waitFor } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Stand-in dev server: echoes what it received, answers upgrades with a 101 + one frame of text. */
async function upstream(bind = '127.0.0.1'): Promise<number> {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${(server.address() as net.AddressInfo).port}/after?x=1` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, xfh: req.headers['x-forwarded-host'] }));
  });
  server.on('upgrade', (req, socket) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: test\r\nConnection: Upgrade\r\n\r\nhello ${req.url}`);
    socket.end();
  });
  await new Promise<void>((r) => server.listen(0, bind, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return (server.address() as net.AddressInfo).port;
}

async function proxyFor(c: Container): Promise<PreviewProxy> {
  const proxy = new PreviewProxy(c.appRunner, { host: '127.0.0.1', port: 0, deniedPorts: [1] });
  await proxy.start();
  cleanups.push(() => proxy.close());
  return proxy;
}

async function seedRunnable(c: Container, runCmd: string): Promise<string> {
  const workspacePath = await c.ws.create('relay', 'Relay');
  const id = 'relay-id';
  c.repos.projects.insert({ id, slug: 'relay', title: 'Relay', model: null, workspacePath, initialPrompt: 'x' });
  c.repos.projects.patch(id, {
    stack: JSON.stringify({ language: 'js', framework: 'node', package_manager: 'npm', install_cmd: '', build_cmd: '', test_cmd: '', run_cmd: runCmd }),
  });
  c.repos.projects.casStatus(id, ['draft'], 'canceled');
  return id;
}

describe('PreviewProxy (aperçu distant)', () => {
  it('selects a port by cookie, rewrites Host, strips its own cookie and keeps redirects relative', async () => {
    const { c } = await testContainer();
    cleanups.push(() => c.close());
    const up = await upstream();
    const proxy = await proxyFor(c);
    const base = `http://127.0.0.1:${proxy.port}`;

    const none = await fetch(`${base}/`);
    expect(none.status).toBe(503);

    const sel = await fetch(`${base}/__pjgen/port/${up}`, { redirect: 'manual' });
    expect(sel.status).toBe(302);
    const cookie = sel.headers.get('set-cookie')!.split(';')[0];
    expect(cookie).toBe(`pjgen_preview=${encodeURIComponent(`port:${up}`)}`);

    const res = await fetch(`${base}/src/main.tsx?v=1`, { headers: { cookie: `${cookie}; sid=abc` } });
    const body = (await res.json()) as { url: string; host: string; cookie: string; xfh: string };
    expect(body.url).toBe('/src/main.tsx?v=1');
    expect(body.host).toBe(`localhost:${up}`);
    expect(body.cookie).toBe('sid=abc');
    expect(body.xfh).toBe(`127.0.0.1:${proxy.port}`); // fetch forbids overriding Host

    const redir = await fetch(`${base}/redirect`, { headers: { cookie }, redirect: 'manual' });
    expect(redir.headers.get('location')).toBe('/after?x=1');

    expect((await fetch(`${base}/__pjgen/port/${proxy.port}`)).status).toBe(400);
    expect((await fetch(`${base}/__pjgen/port/1`)).status).toBe(400);
  });

  it('follows the running app of a project and relays upgrades (HMR websockets)', async () => {
    const { c } = await testContainer();
    cleanups.push(() => c.close());
    // ::1 only, like Vite 5 binding `localhost` — Node's default lookup would try 127.0.0.1 alone.
    const up = await upstream('::1');
    const id = await seedRunnable(c, `echo "listening on http://localhost:${up}"; sleep 60`);
    const proxy = await proxyFor(c);
    const base = `http://127.0.0.1:${proxy.port}`;
    const cookie = `pjgen_preview=${encodeURIComponent(`p:${id}`)}`;

    expect((await fetch(`${base}/`, { headers: { cookie } })).status).toBe(503);

    c.appRunner.start(id);
    cleanups.push(() => c.appRunner.stop(id));
    await waitFor(() => c.appRunner.state(id).url !== null, 5000, 'URL détectée');

    const index = await (await fetch(`${base}/__pjgen/`)).text();
    expect(index).toContain(`/__pjgen/preview/${id}`);

    const res = await fetch(`${base}/x`, { headers: { cookie } });
    expect(((await res.json()) as { url: string }).url).toBe('/x');

    const raw = await new Promise<string>((resolve, reject) => {
      const s = net.connect(proxy.port, '127.0.0.1', () => {
        s.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\nCookie: ${cookie}\r\n\r\n`);
      });
      let data = '';
      s.on('data', (d) => (data += d.toString()));
      s.on('end', () => resolve(data));
      s.on('error', reject);
    });
    expect(raw).toContain('101 Switching Protocols');
    expect(raw).toContain('hello /hmr');
  });
});
