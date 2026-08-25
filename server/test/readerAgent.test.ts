import { describe, expect, it } from 'vitest';
import { buildArgs } from '../src/claude/sessionArgs.js';
import { FAKE_CAPABILITIES } from '../src/claude/capabilities.js';
import { NAVIGATION_RULES, READER_AGENTS, commonSystemPrompt, generatedClaudeMd } from '../src/prompts/common.js';
import type { SessionSpec } from '../src/claude/types.js';

function spec(tools: SessionSpec['tools']): SessionSpec {
  return {
    sessionId: '00000000-0000-0000-0000-000000000001',
    resume: false,
    model: 'sonnet',
    tools,
    prompt: 'x',
    maxTurns: 10,
    timeoutMs: 60_000,
  } as SessionSpec;
}

function agentsArg(argv: string[]): string | null {
  const i = argv.indexOf('--agents');
  return i === -1 ? null : argv[i + 1];
}

describe('Sous-agent lecteur (reconnaissance Haiku)', () => {
  it('injecte --agents dans les sessions à pleine autonomie', () => {
    const arg = agentsArg(buildArgs(spec('default'), FAKE_CAPABILITIES).argv);
    expect(arg).not.toBeNull();
    const parsed = JSON.parse(arg!) as typeof READER_AGENTS;
    expect(parsed.lecteur.model).toBe('haiku');
    // Read-only: any write/exec tool here would let the reader mutate the repo out of band.
    expect(parsed.lecteur.tools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it("n'injecte pas --agents dans les sessions sans outils ni les allowlists nommées", () => {
    expect(agentsArg(buildArgs(spec('none'), FAKE_CAPABILITIES).argv)).toBeNull();
    expect(agentsArg(buildArgs(spec(['WebSearch', 'WebFetch']), FAKE_CAPABILITIES).argv)).toBeNull();
  });

  it('respecte le gate de capability (CLI sans --agents)', () => {
    const { argv } = buildArgs(spec('default'), { ...FAKE_CAPABILITIES, hasAgents: false });
    expect(agentsArg(argv)).toBeNull();
  });

  it('la règle de délégation est scopée qualité: reconnaissance seulement, jamais les fichiers à éditer', () => {
    expect(NAVIGATION_RULES).toContain('lecteur');
    expect(NAVIGATION_RULES).toContain('PAS modifier');
    expect(NAVIGATION_RULES).toContain('JAMAIS pour un fichier que tu vas éditer');
    // The rule reaches both channels: system prompt and generated CLAUDE.md.
    expect(commonSystemPrompt()).toContain('lecteur');
    expect(generatedClaudeMd('Titre')).toContain('lecteur');
  });
});
