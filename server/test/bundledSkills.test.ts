import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/pipeline/workspace.js';
import { testConfig, tmpDir } from './helpers.js';

describe('skills officiels bundlés (T12, issue #8)', () => {
  it('WorkspaceManager.create copie le bundle de skills et le référence dans CLAUDE.md', async () => {
    const base = tmpDir('skills');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo-skills', 'Demo Skills');

    const skillsDir = path.join(workspace, '.claude', 'skills');
    expect(fs.existsSync(skillsDir)).toBe(true);
    const names = fs.readdirSync(skillsDir);
    expect(names).toEqual(expect.arrayContaining(['security-review', 'webapp-testing', 'code-simplify']));
    for (const name of names) {
      expect(fs.existsSync(path.join(skillsDir, name, 'SKILL.md'))).toBe(true);
    }

    const claudeMd = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Skills disponibles');
    expect(claudeMd).toContain('security-review');
  });

  it('idempotent : un second appel ne duplique pas la section CLAUDE.md', async () => {
    const base = tmpDir('skills2');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo-skills2', 'Demo Skills 2');

    ws.writeBundledSkills(workspace);
    const claudeMd = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.split('Skills disponibles').length).toBe(2);
  });
});
