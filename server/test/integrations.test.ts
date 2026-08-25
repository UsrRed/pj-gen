import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { writeEnv } from '../src/access/envFile.js';
import { context7Mcp, exaMcp, memoryMcp } from '../src/pipeline/integrations.js';
import { testContainer } from './helpers.js';

describe('Intégrations MCP scopées par étape (T09/T10/T11, issue #8)', () => {
  it('context7Mcp: null par défaut (désactivé)', async () => {
    const { c } = await testContainer();
    expect(context7Mcp(c)).toBeNull();
  });

  it('context7Mcp: null si activé mais sans clé enregistrée', async () => {
    const { c } = await testContainer();
    c.repos.settings.set({ integrations: { context7: true, exa: false, memoryProvider: 'none' } });
    expect(context7Mcp(c)).toBeNull();
  });

  it('context7Mcp: activé + clé -> mcpConfig scopé avec la clé injectée, jamais --strict-mcp-config seul', async () => {
    const { c } = await testContainer();
    c.repos.settings.set({ integrations: { context7: true, exa: false, memoryProvider: 'none' } });
    fs.mkdirSync(c.config.dataDir, { recursive: true });
    writeEnv(c.config.dataDir, { CONTEXT7_API_KEY: 'sk-abc' });

    const mcp = context7Mcp(c);
    expect(mcp).not.toBeNull();
    expect(mcp!.tools).toEqual(['mcp__context7__*']);
    expect(mcp!.mcpConfig).toEqual([{ name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: 'sk-abc' } }]);
  });

  it('exaMcp: même gating (off -> null, on sans clé -> null, on + clé -> config)', async () => {
    const { c } = await testContainer();
    expect(exaMcp(c)).toBeNull();
    c.repos.settings.set({ integrations: { context7: false, exa: true, memoryProvider: 'none' } });
    expect(exaMcp(c)).toBeNull();
    fs.mkdirSync(c.config.dataDir, { recursive: true });
    writeEnv(c.config.dataDir, { EXA_API_KEY: 'exa-key' });
    expect(exaMcp(c)!.tools).toEqual(['mcp__exa__*']);
  });

  it('memoryMcp: none -> null, provider choisi sans clé -> null, provider + clé -> config du BON provider seulement', async () => {
    const { c } = await testContainer();
    expect(memoryMcp(c)).toBeNull();
    c.repos.settings.set({ integrations: { context7: false, exa: false, memoryProvider: 'mem0' } });
    expect(memoryMcp(c)).toBeNull();
    fs.mkdirSync(c.config.dataDir, { recursive: true });
    writeEnv(c.config.dataDir, { MEM0_API_KEY: 'm0-key', SUPERMEMORY_API_KEY: 'sm-key' });
    const mcp = memoryMcp(c);
    expect(mcp!.mcpConfig).toEqual([{ name: 'mem0', command: 'npx', args: ['-y', '@mem0/mcp'], env: { MEM0_API_KEY: 'm0-key' } }]);

    c.repos.settings.set({ integrations: { context7: false, exa: false, memoryProvider: 'supermemory' } });
    const mcp2 = memoryMcp(c);
    expect(mcp2!.mcpConfig).toEqual([{ name: 'supermemory', command: 'npx', args: ['-y', 'supermemory-mcp'], env: { SUPERMEMORY_API_KEY: 'sm-key' } }]);
  });
});
