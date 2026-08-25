import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/claude/sessionArgs.js';
import { FAKE_CAPABILITIES } from '../src/claude/capabilities.js';
import type { SessionSpec } from '../src/claude/types.js';

function spec(mcpConfig?: SessionSpec['mcpConfig']): SessionSpec {
  return {
    sessionId: `00000000-0000-0000-0000-${Date.now()}`.slice(0, 36),
    resume: false,
    model: 'sonnet',
    tools: 'none',
    prompt: 'x',
    maxTurns: 10,
    timeoutMs: 60_000,
    mcpConfig,
  } as SessionSpec;
}

describe('MCP scopé par session (T07)', () => {
  it('sans mcpConfig : --strict-mcp-config seul, pas de --mcp-config, aucun fichier écrit', () => {
    const { argv, mcpConfigPath } = buildArgs(spec(), FAKE_CAPABILITIES);
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).not.toContain('--mcp-config');
    expect(mcpConfigPath).toBeNull();
  });

  it('avec mcpConfig : --strict-mcp-config ET --mcp-config vers un fichier contenant uniquement les serveurs listés', () => {
    const { argv, mcpConfigPath } = buildArgs(
      spec([{ name: 'context7', command: 'npx', args: ['-y', 'context7-mcp'], env: { API_KEY: 'x' } }]),
      FAKE_CAPABILITIES
    );
    expect(argv).toContain('--strict-mcp-config');
    const i = argv.indexOf('--mcp-config');
    expect(i).toBeGreaterThan(-1);
    expect(mcpConfigPath).toBe(argv[i + 1]);
    const written = JSON.parse(fs.readFileSync(mcpConfigPath!, 'utf8'));
    expect(Object.keys(written.mcpServers)).toEqual(['context7']);
    expect(written.mcpServers.context7.command).toBe('npx');
    fs.unlinkSync(mcpConfigPath!);
  });
});
