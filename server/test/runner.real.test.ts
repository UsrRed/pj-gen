import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRealRunner } from '../src/claude/runner.js';
import { FAKE_CAPABILITIES } from '../src/claude/capabilities.js';
import { testConfig, tmpDir } from './helpers.js';
import type { SessionSpec } from '../src/claude/types.js';

function makeFakeClaude(dir: string, name: string, script: string): string {
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/bash\ncat >/dev/null\n${script}`, { mode: 0o755 });
  return bin;
}

function specFor(cwd: string, maxTurns: number): SessionSpec {
  return {
    cwd,
    prompt: 'test',
    sessionId: '00000000-0000-0000-0000-000000000001',
    resume: false,
    model: 'opus',
    tools: 'default',
    maxTurns,
    timeoutMs: 10_000,
  };
}

describe('RealRunner (fake claude binary)', () => {
  it('counts LOGICAL turns: multi-block assistant events sharing a message id are one turn', async () => {
    const base = tmpDir('runner');
    // 3 logical turns × 3 content-block events each = 9 assistant events.
    const bin = makeFakeClaude(
      base,
      'claude-blocks',
      `
echo '{"type":"system","subtype":"init","session_id":"s-1","model":"m"}'
for t in 1 2 3; do
  for b in 1 2 3; do
    echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"id\\":\\"msg_$t\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"turn $t bloc $b\\"}]}}"
  done
done
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"fini","total_cost_usd":0.01,"usage":{"input_tokens":12,"output_tokens":345,"cache_creation_input_tokens":6789,"cache_read_input_tokens":10111}}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    // Old (buggy) behavior: 9 events > maxTurns 5 → killed. New: 3 logical turns → success.
    const result = await run(specFor(base, 5)).result;
    expect(result.outcome).toBe('success');
    expect(result.resultText).toBe('fini');
    expect(result.numTurns).toBe(3);
    expect(result.sessionId).toBe('s-1');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 345, cacheCreationTokens: 6789, cacheReadTokens: 10111 });
  });

  it('kills a runaway session past the logical-turn cap and classifies it as timeout', async () => {
    const base = tmpDir('runner');
    const bin = makeFakeClaude(
      base,
      'claude-runaway',
      `
echo '{"type":"system","subtype":"init","session_id":"s-2","model":"m"}'
i=0
while [ $i -lt 60 ]; do
  i=$((i+1))
  echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"id\\":\\"msg_$i\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"t$i\\"}]}}"
  sleep 0.05
done
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":60,"result":"jamais atteint","total_cost_usd":0}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    const result = await run(specFor(base, 3)).result;
    expect(result.outcome).toBe('failure');
    expect(result.failure?.kind).toBe('timeout');
    expect(result.failure?.message).toContain('Cap');
  });

  it('cancel() terminates the process and classifies as canceled', async () => {
    const base = tmpDir('runner');
    const bin = makeFakeClaude(
      base,
      'claude-slow',
      `
echo '{"type":"system","subtype":"init","session_id":"s-3","model":"m"}'
sleep 30
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"x","total_cost_usd":0}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    const handle = run(specFor(base, 10));
    setTimeout(() => handle.cancel('canceled'), 300);
    const result = await handle.result;
    expect(result.outcome).toBe('failure');
    expect(result.failure?.kind).toBe('canceled');
  }, 15_000);
});
