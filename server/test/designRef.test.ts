import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceManager } from '../src/pipeline/workspace.js';
import { testConfig, tmpDir } from './helpers.js';

describe('design reference (Claude Design hand-off)', () => {
  it('stores an HTML mockup, README and binds it in CLAUDE.md', async () => {
    const base = tmpDir('design');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo-design', 'Demo Design');

    const written = ws.writeDesignReference(workspace, {
      content: '<html><body><div class="hero">Maquette</div></body></html>',
      url: 'https://claude.ai/design/xyz',
    });
    expect(written).toContain('docs/design/mockup.html');
    expect(written).toContain('docs/design/README.md');
    expect(ws.hasDesignReference(workspace)).toBe(true);

    const readme = fs.readFileSync(path.join(workspace, 'docs/design/README.md'), 'utf8');
    expect(readme).toContain('https://claude.ai/design/xyz');
    const claudeMd = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Référence visuelle');
    // idempotent: a second write must not duplicate the CLAUDE.md section
    ws.writeDesignReference(workspace, { content: '<div>v2</div>' }, 2);
    const claudeMd2 = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
    expect(claudeMd2.split('Référence visuelle').length).toBe(2);
    expect(fs.readFileSync(path.join(workspace, 'docs/design/mockup.html'), 'utf8')).toContain('v2');
  });

  it('classifies React exports and plain notes', async () => {
    const base = tmpDir('design2');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo-design2', 'Demo Design 2');

    const jsx = ws.writeDesignReference(workspace, { content: "import React from 'react';\nexport default function Mockup() { return <div/>; }" });
    expect(jsx).toContain('docs/design/Mockup.jsx');
    const notes = ws.writeDesignReference(workspace, { content: 'Palette sombre, typo serif, hero plein écran.' });
    expect(notes).toContain('docs/design/NOTES.md');
  });

  it('without design, hasDesignReference is false', async () => {
    const base = tmpDir('design3');
    fs.mkdirSync(path.join(base, 'ws'), { recursive: true });
    const ws = new WorkspaceManager(testConfig(base));
    const workspace = await ws.create('demo-plain', 'Demo Plain');
    expect(ws.hasDesignReference(workspace)).toBe(false);
  });
});
