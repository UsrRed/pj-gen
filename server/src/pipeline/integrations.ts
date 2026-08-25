import type { McpServerConfig } from '../claude/types.js';
import { readEnvValues } from '../access/envFile.js';
import { INTEGRATION_SECRET_VARS, MEMORY_PROVIDER_SECRET_VARS } from '../access/integrationSecrets.js';
import type { CoreDeps } from '../core/deps.js';

export interface StepMcp {
  mcpConfig: McpServerConfig[];
  /** Explicit MCP tool allowlist (wildcard per server: `mcp__<server>__*`), added on top of any other tools. */
  tools: string[];
}

/**
 * context7 (issue #8, T09): up-to-date library/API docs, scoped to architecture and
 * task_breakdown — the two generation steps that pick concrete APIs/versions. Returns
 * null when the operator hasn't opted in (SettingsDto.integrations.context7) or hasn't
 * supplied a key yet — the caller falls back to the normal MCP-less session.
 */
export function context7Mcp(deps: CoreDeps): StepMcp | null {
  const settings = deps.repos.settings.getAll();
  if (!settings.integrations.context7) return null;
  const varName = INTEGRATION_SECRET_VARS.context7;
  const key = readEnvValues(deps.config.dataDir, [varName])[varName];
  if (!key) return null;
  return {
    mcpConfig: [{ name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: { CONTEXT7_API_KEY: key } }],
    tools: ['mcp__context7__*'],
  };
}

/** EXA (issue #8, T10): web search, scoped to design_benchmark. Same opt-in gating as context7Mcp. */
export function exaMcp(deps: CoreDeps): StepMcp | null {
  const settings = deps.repos.settings.getAll();
  if (!settings.integrations.exa) return null;
  const varName = INTEGRATION_SECRET_VARS.exa;
  const key = readEnvValues(deps.config.dataDir, [varName])[varName];
  if (!key) return null;
  return {
    mcpConfig: [{ name: 'exa', command: 'npx', args: ['-y', 'exa-mcp-server'], env: { EXA_API_KEY: key } }],
    tools: ['mcp__exa__*'],
  };
}

/**
 * Persistent memory (issue #8, T11): at most ONE provider active (mem0 XOR supermemory —
 * they overlap in purpose), scoped to cadrage. Package names below match each provider's
 * published MCP server as of this writing; if a provider changes its package, update the
 * `command`/`args` here (kept out of Settings — not something an operator should need to type).
 */
export function memoryMcp(deps: CoreDeps): StepMcp | null {
  const settings = deps.repos.settings.getAll();
  const provider = settings.integrations.memoryProvider;
  if (provider === 'none') return null;
  const varName = MEMORY_PROVIDER_SECRET_VARS[provider];
  const key = readEnvValues(deps.config.dataDir, [varName])[varName];
  if (!key) return null;
  if (provider === 'mem0') {
    return {
      mcpConfig: [{ name: 'mem0', command: 'npx', args: ['-y', '@mem0/mcp'], env: { MEM0_API_KEY: key } }],
      tools: ['mcp__mem0__*'],
    };
  }
  return {
    mcpConfig: [{ name: 'supermemory', command: 'npx', args: ['-y', 'supermemory-mcp'], env: { SUPERMEMORY_API_KEY: key } }],
    tools: ['mcp__supermemory__*'],
  };
}
