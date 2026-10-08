import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { UPDATE_ARM_TTL_S } from '../src/http/routes/update.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

describe('barrière de mise à jour', () => {
  it('fermée par défaut, s’arme au clic, se désarme, expire', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const get = async () => (await appRef!.inject({ method: 'GET', url: '/api/update' })).json();
    expect((await get()).armed).toBe(false);

    const armed = (await appRef.inject({ method: 'POST', url: '/api/update/arm', payload: {} })).json();
    expect(armed.armed).toBe(true);
    expect(fs.existsSync(path.join(c.config.dataDir, 'update-armed'))).toBe(true);

    // Consumed by the host (file removed) → closed again.
    fs.rmSync(path.join(c.config.dataDir, 'update-armed'));
    expect((await get()).armed).toBe(false);

    // Stale arming (older than the TTL) is closed too.
    fs.writeFileSync(path.join(c.config.dataDir, 'update-armed'), `${Math.floor(Date.now() / 1000) - UPDATE_ARM_TTL_S - 5}\n`);
    expect((await get()).armed).toBe(false);

    await appRef.inject({ method: 'POST', url: '/api/update/arm', payload: {} });
    expect((await appRef.inject({ method: 'POST', url: '/api/update/disarm', payload: {} })).json().armed).toBe(false);
  });
});
