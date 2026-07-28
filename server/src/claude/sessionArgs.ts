import path from 'node:path';
import type { Config } from '../config.js';
import { READER_AGENTS } from '../prompts/common.js';
import { toolEnv } from '../core/toolEnv.js';
import type { Capabilities } from './capabilities.js';
import type { SessionSpec } from './types.js';

/** Absolute path of the PreToolUse guard that blocks pkill/killall in spawned sessions. */
export const KILL_GUARD_PATH = path.resolve(import.meta.dirname, '../../hooks/kill-guard.mjs');

/** Env vars that must never leak into spawned sessions (they would bypass OAuth or override the model). */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
];

export function buildEnv(config: Config): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIPPED_ENV) delete env[k];
  // Shared caches + CI=1, applied AFTER the strip loop so it can never re-introduce a key.
  Object.assign(env, toolEnv(config));
  env.GIT_AUTHOR_NAME = config.gitAuthorName;
  env.GIT_AUTHOR_EMAIL = config.gitAuthorEmail;
  env.GIT_COMMITTER_NAME = config.gitAuthorName;
  env.GIT_COMMITTER_EMAIL = config.gitAuthorEmail;
  env.DISABLE_AUTOUPDATER = '1';
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/** The prompt itself is written to stdin (not argv) — avoids argv size limits and ps exposure. */
export function buildArgs(spec: SessionSpec, caps: Capabilities): string[] {
  const argv = ['-p', '--output-format', 'stream-json', '--verbose'];

  if (spec.resume) {
    argv.push('--resume', spec.sessionId);
    if (spec.forkSession && caps.hasForkSession) argv.push('--fork-session');
  } else {
    argv.push('--session-id', spec.sessionId);
  }

  argv.push('--model', spec.model);
  if (spec.fallbackModel && caps.hasFallbackModel) argv.push('--fallback-model', spec.fallbackModel);

  if (spec.tools === 'none') {
    argv.push('--tools', '');
  } else if (Array.isArray(spec.tools)) {
    // Named allowlist still needs the skip-permissions flag in -p (headless has no prompt UI).
    argv.push('--tools', spec.tools.join(','), '--dangerously-skip-permissions');
  } else {
    argv.push('--dangerously-skip-permissions');
    // Full-autonomy sessions get the Haiku reconnaissance subagent: big-file answers
    // stay out of the main transcript, which is cache-re-read at every turn.
    if (caps.hasAgents) argv.push('--agents', JSON.stringify(READER_AGENTS));
  }

  if (caps.hasSettingSources) argv.push('--setting-sources', 'project,local');
  if (caps.hasStrictMcpConfig) argv.push('--strict-mcp-config');
  argv.push(
    '--settings',
    JSON.stringify({
      includeCoAuthoredBy: false,
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node "${KILL_GUARD_PATH}"` }] }],
      },
    })
  );

  if (spec.jsonSchema && caps.hasJsonSchema) argv.push('--json-schema', JSON.stringify(spec.jsonSchema));
  if (spec.appendSystemPrompt) argv.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.maxBudgetUsd && caps.hasMaxBudget) argv.push('--max-budget-usd', String(spec.maxBudgetUsd));

  return argv;
}
