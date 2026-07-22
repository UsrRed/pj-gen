import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager, slugify } from '../src/pipeline/workspace.js';
import { testConfig, tmpDir } from './helpers.js';

describe('slugify', () => {
  it('normalizes accents and symbols', () => {
    expect(slugify('Mon Projet Génial !')).toBe('mon-projet-genial');
    expect(slugify('***')).toBe('projet');
  });
});

describe('WorkspaceManager path jail', () => {
  it('rejects traversal, absolute paths and symlink escapes; accepts normal paths', async () => {
    const base = tmpDir('jail');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const config = testConfig(base);
    const ws = new WorkspaceManager(config);
    const workspace = await ws.create('demo', 'Demo');

    expect(() => ws.assertInside(workspace, '../secret')).toThrow(/refusé/);
    expect(() => ws.assertInside(workspace, '/etc/passwd')).toThrow(/refusé/);
    expect(() => ws.assertInside(workspace, 'a/../../x')).toThrow(/refusé/);
    expect(ws.assertInside(workspace, 'docs/SPEC.md')).toContain(workspace);

    // symlink pointing outside the workspace
    const outside = path.join(base, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(workspace, 'link.txt'));
    expect(() => ws.readFile(workspace, 'link.txt')).toThrow(/refusé/);
  });

  it('creates a git repo authored by UsrRed with the commit-msg hook', async () => {
    const base = tmpDir('git');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo2', 'Demo 2');
    expect(fs.existsSync(path.join(workspace, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'CLAUDE.md'))).toBe(true);
    const hook = fs.readFileSync(path.join(workspace, '.git', 'hooks', 'commit-msg'), 'utf8');
    expect(hook).toContain('co-authored-by');
    const sha = await ws.headSha(workspace);
    expect(sha).toBeTruthy();
  });
});
