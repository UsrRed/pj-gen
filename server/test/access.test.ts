import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { readEnvKeys, writeEnv } from '../src/access/envFile.js';
import { validateSshFields } from '../src/access/accessTest.js';
import { accessMarkdown } from '../src/prompts/access.js';
import { toAccessDto } from '../src/db/repos/index.js';
import { seedQueuedProject, testContainer, tmpDir } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

async function seedProject() {
  const { c } = await testContainer();
  cRef = c;
  const slug = 'acces-test';
  const workspacePath = await c.ws.create(slug, 'Accès Test');
  const id = 'acces-id';
  c.repos.projects.insert({ id, slug, title: 'Accès Test', model: null, workspacePath, initialPrompt: 'test' });
  return { c, id, workspacePath };
}

describe('access repo', () => {
  it('refuses anything that looks like a secret value', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertManual(id, { key: 'ssh_prod', kind: 'ssh', label: 'VPS', secretEnvVars: ['DEPLOY_TOKEN'] });
    const row = c.repos.access.byKey(id, 'ssh_prod')!;

    // Field NAMES that smell of a secret are rejected outright.
    for (const name of ['password', 'api_key', 'private_key', 'accessToken', 'pwd']) {
      expect(() => c.repos.access.patchFields(id, row.id, { [name]: 'x' })).toThrow(/secrets ne sont jamais stockés/);
    }
    // So are PEM blobs and over-long values, whatever the field is called.
    expect(() => c.repos.access.patchFields(id, row.id, { note: '-----BEGIN OPENSSH PRIVATE KEY-----' })).toThrow(/clé privée/);
    expect(() => c.repos.access.patchFields(id, row.id, { note: 'x'.repeat(300) })).toThrow(/trop long/);

    // Ordinary non-secret values go through.
    const ok = c.repos.access.patchFields(id, row.id, { host: 'deploy.exemple.com', user: 'red', port: '22' });
    expect(JSON.parse(ok.fields).host).toBe('deploy.exemple.com');
  });

  it('keeps only the NAMES of secret env vars, upper-cased and validated', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertManual(id, {
      key: 'stripe',
      kind: 'api_key',
      label: 'Stripe',
      secretEnvVars: ['stripe_api_key', 'BAD NAME', '1BAD', 'WEBHOOK_SECRET'],
    });
    const dto = toAccessDto(c.repos.access.byKey(id, 'stripe')!);
    expect(dto.secretEnvVars).toEqual(['STRIPE_API_KEY', 'WEBHOOK_SECRET']);
  });

  it('a cadrage turn never overwrites what the operator already answered', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertFromCadrage(id, [{ key: 'ssh_prod', kind: 'ssh', label: 'VPS', why: 'déploiement' }]);
    const row = c.repos.access.byKey(id, 'ssh_prod')!;
    c.repos.access.patchFields(id, row.id, { host: 'deploy.exemple.com' });
    c.repos.access.setStatus(id, row.id, 'provided');

    // The model restates it with a different label; the operator's answer wins.
    c.repos.access.upsertFromCadrage(id, [{ key: 'ssh_prod', kind: 'ssh', label: 'AUTRE LIBELLÉ', why: 'x' }]);
    const after = toAccessDto(c.repos.access.byKey(id, 'ssh_prod')!);
    expect(after.label).toBe('VPS');
    expect(after.fields.host).toBe('deploy.exemple.com');
    expect(after.status).toBe('provided');
  });

  it('drops untouched cadrage rows the model stops listing, but keeps manual ones', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertFromCadrage(id, [
      { key: 'ssh_prod', kind: 'ssh', label: 'VPS' },
      { key: 'domaine', kind: 'domain', label: 'Domaine' },
    ]);
    c.repos.access.upsertManual(id, { key: 'perso', kind: 'other', label: 'Ajout manuel' });

    c.repos.access.upsertFromCadrage(id, [{ key: 'ssh_prod', kind: 'ssh', label: 'VPS' }]);
    expect(c.repos.access.list(id).map((r) => r.key).sort()).toEqual(['perso', 'ssh_prod']);
  });

  it('missing() ignores optional and skipped requirements', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertManual(id, { key: 'a', kind: 'ssh', label: 'Requis' });
    c.repos.access.upsertManual(id, { key: 'b', kind: 'domain', label: 'Optionnel', required: false });
    const c3 = c.repos.access.upsertManual(id, { key: 'c', kind: 'smtp', label: 'Ignoré' });
    c.repos.access.setStatus(id, c3.id, 'skipped');
    expect(c.repos.access.missing(id).map((r) => r.key)).toEqual(['a']);
  });
});

describe('.env writing', () => {
  it('merges idempotently, preserves comments, and stays 0600', () => {
    const ws = tmpDir('env');
    fs.writeFileSync(path.join(ws, '.env'), '# config locale\nEXISTING=garde-moi\nAPI_KEY=ancien\n');

    const written = writeEnv(ws, { API_KEY: 'nouveau', OTHER: 'valeur' });
    expect(written.sort()).toEqual(['API_KEY', 'OTHER']);

    const content = fs.readFileSync(path.join(ws, '.env'), 'utf8');
    expect(content).toContain('# config locale');
    expect(content).toContain('EXISTING=garde-moi');
    expect(content).toContain('API_KEY=nouveau');
    expect(content).not.toContain('API_KEY=ancien');
    expect(content).toContain('OTHER=valeur');

    // Only the owner may read it.
    expect(fs.statSync(path.join(ws, '.env')).mode & 0o777).toBe(0o600);

    // Rewriting the same values must not duplicate lines.
    writeEnv(ws, { API_KEY: 'nouveau' });
    expect(fs.readFileSync(path.join(ws, '.env'), 'utf8').match(/API_KEY=/g)!.length).toBe(1);
  });

  it('quotes values that would otherwise corrupt the file, and reads back names only', () => {
    const ws = tmpDir('env');
    writeEnv(ws, { TRICKY: 'avec espace et "guillemet"', MULTI: 'ligne1\nligne2' });
    const content = fs.readFileSync(path.join(ws, '.env'), 'utf8');
    expect(content.split('\n').filter(Boolean).length).toBe(2); // the newline did not split a line
    expect(readEnvKeys(ws).sort()).toEqual(['MULTI', 'TRICKY']);
  });

  it('rejects an invalid variable name', () => {
    const ws = tmpDir('env');
    expect(() => writeEnv(ws, { 'bad name': 'x' })).toThrow(/invalide/);
    expect(() => writeEnv(ws, { lowercase: 'x' })).toThrow(/invalide/);
  });
});

describe('SSH field validation', () => {
  it('rejects anything that could be read as an ssh option', () => {
    // -oProxyCommand=... would be arbitrary command execution.
    expect(() => validateSshFields({ host: '-oProxyCommand=touch /tmp/pwned', user: 'red' })).toThrow(/hôte invalide/);
    expect(() => validateSshFields({ host: 'ok.example.com', user: '-oProxyCommand=x' })).toThrow(/utilisateur invalide/);
    expect(() => validateSshFields({ host: 'a b', user: 'red' })).toThrow(/hôte invalide/);
    expect(() => validateSshFields({ host: 'ok.example.com', user: 'red', port: '99999' })).toThrow(/port invalide/);
    expect(() => validateSshFields({ host: 'ok.example.com', user: 'red', port: 'abc' })).toThrow(/port invalide/);
    expect(() => validateSshFields({ host: '', user: 'red' })).toThrow(/hôte manquant/);
    // A key outside the operator's home is refused before any spawn.
    expect(() => validateSshFields({ host: 'ok.example.com', user: 'red', key_path: '/etc/shadow' })).toThrow(/répertoire personnel/);
  });

  it('accepts a normal target and defaults the port', () => {
    expect(validateSshFields({ host: 'deploy.exemple.com', user: 'red' })).toMatchObject({
      host: 'deploy.exemple.com',
      user: 'red',
      port: '22',
    });
  });
});

describe('docs/ACCESS.md', () => {
  it('lists keys and reasons but never a value', async () => {
    const { c, id } = await seedProject();
    c.repos.access.upsertManual(id, {
      key: 'ssh_prod',
      kind: 'ssh',
      label: 'VPS de production',
      why: 'déploiement du service',
      secretEnvVars: ['DEPLOY_TOKEN'],
    });
    const row = c.repos.access.byKey(id, 'ssh_prod')!;
    c.repos.access.patchFields(id, row.id, { host: 'deploy.exemple.com', user: 'red' });

    const md = accessMarkdown(c.repos.access.list(id).map(toAccessDto));
    expect(md).toContain('ssh_prod');
    expect(md).toContain('DEPLOY_TOKEN'); // the NAME is documented
    expect(md).toContain('déploiement du service');
    // Even non-secret values stay out of the committed doc.
    expect(md).not.toContain('deploy.exemple.com');
  });

  it('states plainly when nothing external is needed', () => {
    expect(accessMarkdown([])).toContain('Aucun accès externe');
  });
});

describe('deploy gate', () => {
  it('refuses approval while a required access is missing, and allows it once skipped', async () => {
    const { c } = await testContainer();
    cRef = c;
    const id = await seedQueuedProject(c, 'Porte Deploiement');
    c.repos.projects.casStatus(id, ['queued'], 'building');
    c.repos.projects.casStatus(id, ['building'], 'awaiting_deploy_approval');

    const row = c.repos.access.upsertManual(id, { key: 'ssh_prod', kind: 'ssh', label: 'VPS de production' });
    await expect(c.deploy.approve(id, '')).rejects.toThrow(/Accès requis manquants/);

    // The escape hatch: mark it not needed.
    c.repos.access.setStatus(id, row.id, 'skipped');
    await expect(c.deploy.approve(id, '')).resolves.toBeUndefined();
  });
});
