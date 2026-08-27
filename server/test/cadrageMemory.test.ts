import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../src/claude/types.js';
import { writeEnv } from '../src/access/envFile.js';
import { testContainer, fastScript } from './helpers.js';

describe('Mémoire persistante en cadrage (T11, issue #8)', () => {
  it('désactivée par défaut: tools=none, aucun mcpConfig envoyé au runner', async () => {
    const specs: SessionSpec[] = [];
    const { c } = await testContainer({
      script: fastScript((spec) => {
        specs.push(spec);
        return undefined;
      }),
    });
    const ws = await c.ws.create('demo-mem-off', 'Demo Mem Off');
    c.repos.projects.insert({ id: 'p-mem-off', slug: 'demo-mem-off', title: 'Demo Mem Off', model: null, workspacePath: ws, initialPrompt: 'x' });
    await c.chat.runCadrageTurn('p-mem-off', 'Je veux un blog.');

    const cadrageSpec = specs.find((s) => s.sessionId && s.tools !== undefined);
    expect(cadrageSpec).toBeDefined();
    expect(cadrageSpec!.tools).toBe('none');
    expect(cadrageSpec!.mcpConfig).toBeUndefined();
  });

  it("activée + clé mem0: le runner reçoit l'allowlist mcp__mem0__* et le serveur MCP scopé", async () => {
    const specs: SessionSpec[] = [];
    const { c } = await testContainer({
      script: fastScript((spec) => {
        specs.push(spec);
        return undefined;
      }),
    });
    c.repos.settings.set({ integrations: { context7: false, exa: false, memoryProvider: 'mem0' } });
    fs.mkdirSync(c.config.dataDir, { recursive: true });
    writeEnv(c.config.dataDir, { MEM0_API_KEY: 'm0-secret' });

    const ws = await c.ws.create('demo-mem-on', 'Demo Mem On');
    c.repos.projects.insert({ id: 'p-mem-on', slug: 'demo-mem-on', title: 'Demo Mem On', model: null, workspacePath: ws, initialPrompt: 'x' });
    await c.chat.runCadrageTurn('p-mem-on', 'Je veux un blog.');

    const cadrageSpec = specs[specs.length - 1];
    expect(cadrageSpec.tools).toEqual(['mcp__mem0__*']);
    expect(cadrageSpec.mcpConfig).toEqual([{ name: 'mem0', command: 'npx', args: ['-y', '@mem0/mcp'], env: { MEM0_API_KEY: 'm0-secret' } }]);
    expect(cadrageSpec.appendSystemPrompt).toContain('Mémoire persistante');
  });
});
