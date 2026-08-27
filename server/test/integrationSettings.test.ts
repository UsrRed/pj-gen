import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../src/container.js';
import { createApp } from '../src/http/app.js';
import { testContainer } from './helpers.js';

let cRef: Container | null = null;
let appRef: FastifyInstance | null = null;
afterEach(async () => {
  await appRef?.close();
  appRef = null;
  cRef?.close();
  cRef = null;
});

describe('Intégrations optionnelles (T08)', () => {
  it('désactivées par défaut, aucun secret présent', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const settings = await appRef.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.json().integrations).toEqual({ context7: false, exa: false, memoryProvider: 'none' });
    const secrets = await appRef.inject({ method: 'GET', url: '/api/settings/integrations/secrets' });
    expect(secrets.json().secretsPresent).toEqual([]);
  });

  it('PATCH active une intégration ; la clé écrite dans le .env global ne revient jamais en lecture', async () => {
    const { c, base } = await testContainer();
    cRef = c;
    appRef = await createApp(c);

    const patch = await appRef.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { integrations: { context7: true, exa: false, memoryProvider: 'none' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().integrations.context7).toBe(true);

    const key = await appRef.inject({
      method: 'POST',
      url: '/api/settings/integrations/secrets',
      payload: { values: { CONTEXT7_API_KEY: 'sk-test-secret' } },
    });
    expect(key.statusCode).toBe(200);
    expect(key.json().written).toEqual(['CONTEXT7_API_KEY']);
    expect(JSON.stringify(key.json())).not.toContain('sk-test-secret');

    const presence = await appRef.inject({ method: 'GET', url: '/api/settings/integrations/secrets' });
    expect(presence.json().secretsPresent).toEqual(['CONTEXT7_API_KEY']);

    const envFile = path.join(base, 'data', '.env');
    expect(fs.existsSync(envFile)).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toContain('CONTEXT7_API_KEY=sk-test-secret');
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it('rejette une variable non allowlistée', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    const res = await appRef.inject({
      method: 'POST',
      url: '/api/settings/integrations/secrets',
      payload: { values: { ANTHROPIC_API_KEY: 'nope' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('un patch integrations partiel ne réinitialise pas les champs non envoyés (contrat objet complet, comme notifyEvents)', async () => {
    const { c } = await testContainer();
    cRef = c;
    appRef = await createApp(c);
    await appRef.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { integrations: { context7: true, exa: true, memoryProvider: 'mem0' } },
    });
    const res = await appRef.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().integrations).toEqual({ context7: true, exa: true, memoryProvider: 'mem0' });
  });
});
