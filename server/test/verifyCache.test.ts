import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { StackInfo } from '@pjgen/shared';
import { verifyStack } from '../src/pipeline/verify.js';
import { installFingerprint, installIsFresh, markInstallOk } from '../src/pipeline/verifyCache.js';
import { testConfig, tmpDir } from './helpers.js';

/** A workspace with a .git dir (where the memo lives) and a package.json. */
function seedWorkspace(): string {
  const ws = tmpDir('verifycache');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'x', dependencies: { a: '1.0.0' } }));
  return ws;
}

describe('install fingerprint', () => {
  it('changes when a manifest changes and stays stable otherwise', () => {
    const ws = seedWorkspace();
    const fp1 = installFingerprint(ws, 'npm ci');
    expect(installFingerprint(ws, 'npm ci')).toBe(fp1);
    // A different install command is a different install.
    expect(installFingerprint(ws, 'npm install')).not.toBe(fp1);
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'x', dependencies: { a: '2.0.0' } }));
    expect(installFingerprint(ws, 'npm ci')).not.toBe(fp1);
  });

  it('adding an empty lockfile invalidates the fingerprint', () => {
    const ws = seedWorkspace();
    const fp1 = installFingerprint(ws, 'npm ci');
    fs.writeFileSync(path.join(ws, 'package-lock.json'), '');
    expect(installFingerprint(ws, 'npm ci')).not.toBe(fp1);
  });

  it('is not fresh until marked, and stops being fresh if the installed tree is removed', () => {
    const ws = seedWorkspace();
    const fp = installFingerprint(ws, 'npm ci');
    expect(installIsFresh(ws, fp)).toBe(false);

    markInstallOk(ws, fp);
    // Marked but nothing installed → a manual rm -rf node_modules must force a re-install.
    expect(installIsFresh(ws, fp)).toBe(false);

    fs.mkdirSync(path.join(ws, 'node_modules'), { recursive: true });
    expect(installIsFresh(ws, fp)).toBe(true);

    fs.rmSync(path.join(ws, 'node_modules'), { recursive: true, force: true });
    expect(installIsFresh(ws, fp)).toBe(false);
  });

  it('lives inside .git so it is never committed or exposed as an artifact', () => {
    const ws = seedWorkspace();
    markInstallOk(ws, 'deadbeef');
    expect(fs.existsSync(path.join(ws, '.git', 'pjgen-verify.json'))).toBe(true);
    expect(fs.readdirSync(ws).filter((f) => f !== '.git' && f !== 'package.json')).toEqual([]);
  });
});

describe('verifyStack install skip', () => {
  const stack: StackInfo = {
    language: 'node',
    install_cmd: 'mkdir -p node_modules && echo installed >> install.log',
    build_cmd: '',
    test_cmd: 'true',
    run_cmd: '',
  } as StackInfo;

  it('runs install once, then skips it while the manifests are unchanged', async () => {
    const ws = seedWorkspace();
    const config = testConfig(tmpDir('cfg'), { fakeCli: false });
    const log = path.join(ws, 'install.log');

    expect((await verifyStack(config, ws, stack, ['install', 'test'])).ok).toBe(true);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(1);

    expect((await verifyStack(config, ws, stack, ['install', 'test'])).ok).toBe(true);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(1); // skipped

    // forceInstall bypasses the memo — used after a fix session touched the tree.
    expect((await verifyStack(config, ws, stack, ['install'], { forceInstall: true })).ok).toBe(true);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(2);

    // A manifest change always re-installs.
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ name: 'x', dependencies: { b: '1.0.0' } }));
    expect((await verifyStack(config, ws, stack, ['install'])).ok).toBe(true);
    expect(fs.readFileSync(log, 'utf8').trim().split('\n').length).toBe(3);
  });

  it('does not memoise a failed install', async () => {
    const ws = seedWorkspace();
    const config = testConfig(tmpDir('cfg'), { fakeCli: false });
    const failing = { ...stack, install_cmd: 'exit 1' } as StackInfo;

    expect((await verifyStack(config, ws, failing, ['install'])).ok).toBe(false);
    expect(installIsFresh(ws, installFingerprint(ws, failing.install_cmd))).toBe(false);
  });

  it('reports the real elapsed time (it used to always return 0)', async () => {
    const ws = seedWorkspace();
    const config = testConfig(tmpDir('cfg'), { fakeCli: false });
    const slow = { ...stack, install_cmd: '', test_cmd: 'sleep 0.2' } as StackInfo;
    const r = await verifyStack(config, ws, slow, ['test']);
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBeGreaterThan(100);
  });
});
