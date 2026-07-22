import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { LanExposure, lanAddresses } from '../src/core/lanExposure.js';
import { createApp } from '../src/http/app.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
let backend: http.Server | null = null;
let lanRef: LanExposure | null = null;
afterEach(async () => {
  await lanRef?.disable();
  lanRef = null;
  await appRef?.close();
  appRef = null;
  await new Promise<void>((r) => (backend ? backend.close(() => r()) : r()));
  backend = null;
  cRef?.close();
  cRef = null;
});

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url);
  return { status: res.status, text: await res.text() };
}

describe('LanExposure', () => {
  // 127.0.0.2 is a loopback alias on Linux — stands in for a LAN interface without needing one.
  it('pipes HTTP through the proxy while enabled, refuses after disable', async () => {
    backend = http.createServer((_req, res) => res.end('pong'));
    await new Promise<void>((r) => backend!.listen(0, '127.0.0.1', () => r()));
    const port = (backend.address() as AddressInfo).port;

    const lan = new LanExposure(port, '127.0.0.1');
    lanRef = lan;
    const status = await lan.apply(true, ['127.0.0.2']);
    expect(status.enabled).toBe(true);
    expect(status.urls).toEqual([`http://127.0.0.2:${port}`]);
    expect(status.errors).toEqual([]);

    const viaProxy = await fetchText(`http://127.0.0.2:${port}/`);
    expect(viaProxy).toEqual({ status: 200, text: 'pong' });

    const off = await lan.apply(false);
    expect(off.enabled).toBe(false);
    await expect(fetch(`http://127.0.0.2:${port}/`)).rejects.toThrow();
  });

  it('reports per-interface bind errors without failing the others', async () => {
    backend = http.createServer((_req, res) => res.end('pong'));
    await new Promise<void>((r) => backend!.listen(0, '127.0.0.1', () => r()));
    const port = (backend.address() as AddressInfo).port;
    // 127.0.0.1 is taken by the backend itself → EADDRINUSE; 127.0.0.2 must still bind.
    const lan = new LanExposure(port, '127.0.0.1');
    lanRef = lan;
    const status = await lan.apply(true, ['127.0.0.1', '127.0.0.2']);
    expect(status.urls).toEqual([`http://127.0.0.2:${port}`]);
    expect(status.errors.some((e) => e.includes('127.0.0.1'))).toBe(true);
    expect((await fetchText(`http://127.0.0.2:${port}/`)).status).toBe(200);
  });

  it('a non-loopback server host means already exposed: toggle is a no-op', async () => {
    const lan = new LanExposure(4310, '0.0.0.0');
    lanRef = lan;
    const status = await lan.apply(true, ['127.0.0.2']);
    expect(status.alreadyExposed).toBe(true);
    expect(status.enabled).toBe(true);
    // No proxy actually bound (would conflict with the wildcard bind).
    await expect(fetch('http://127.0.0.2:4310/')).rejects.toThrow();
  });

  it('lanAddresses only returns external IPv4s', () => {
    for (const a of lanAddresses()) {
      expect(a).not.toMatch(/^127\./);
      expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    }
  });

  it('PATCH /api/settings {exposeLan} applies the proxy and GET /api/lan reports it', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    // The container's LanExposure targets config.port; the test app isn't listening there,
    // so we only assert the toggle/status plumbing (enable state + persisted setting).
    const on = await appRef.inject({ method: 'PATCH', url: '/api/settings', payload: { exposeLan: true } });
    expect(on.statusCode).toBe(200);
    expect(on.json().exposeLan).toBe(true);
    expect(c.repos.settings.getAll().exposeLan).toBe(true);
    const status = await appRef.inject({ method: 'GET', url: '/api/lan' });
    expect(status.json().enabled).toBe(true);

    const off = await appRef.inject({ method: 'PATCH', url: '/api/settings', payload: { exposeLan: false } });
    expect(off.json().exposeLan).toBe(false);
    expect((await appRef.inject({ method: 'GET', url: '/api/lan' })).json().enabled).toBe(false);
  });
});
