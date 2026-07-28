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

  it('ignores interleaved subagent events (parent_tool_use_id) in the turn count', async () => {
    const base = tmpDir('runner');
    // Post-mortem ia-play: 2 parallel subagents interleave 40 assistant events with
    // ALTERNATING message ids in the main stream. A "compare to previous id" counter
    // sees 40+ turns; the correct count is the 3 main-loop turns.
    const bin = makeFakeClaude(
      base,
      'claude-subagents',
      `
echo '{"type":"system","subtype":"init","session_id":"s-4","model":"m"}'
echo '{"type":"assistant","message":{"id":"msg_main_1","content":[{"type":"text","text":"lance les audits"}]}}'
i=0
while [ $i -lt 20 ]; do
  i=$((i+1))
  echo "{\\"type\\":\\"assistant\\",\\"parent_tool_use_id\\":\\"toolu_A\\",\\"message\\":{\\"id\\":\\"msg_a_$i\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"sub A $i\\"}]}}"
  echo "{\\"type\\":\\"assistant\\",\\"parent_tool_use_id\\":\\"toolu_B\\",\\"message\\":{\\"id\\":\\"msg_b_$i\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"sub B $i\\"}]}}"
done
echo '{"type":"assistant","message":{"id":"msg_main_2","content":[{"type":"text","text":"synthèse"}]}}'
echo '{"type":"assistant","message":{"id":"msg_main_3","content":[{"type":"text","text":"verdict"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"audit ok","total_cost_usd":0}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    const result = await run(specFor(base, 5)).result;
    expect(result.outcome).toBe('success');
    expect(result.resultText).toBe('audit ok');
  });

  it('counts non-consecutive re-emissions of a main-loop message id only once', async () => {
    const base = tmpDir('runner');
    // Main-loop blocks of the same message separated by other traffic must not
    // re-count (Set semantics, not "different from previous id").
    const bin = makeFakeClaude(
      base,
      'claude-reemit',
      `
echo '{"type":"system","subtype":"init","session_id":"s-5","model":"m"}'
for t in 1 2 3; do
  echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"id\\":\\"msg_$t\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"turn $t\\"}]}}"
done
for t in 1 2 3; do
  echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"id\\":\\"msg_$t\\",\\"content\\":[{\\"type\\":\\"tool_use\\",\\"name\\":\\"Bash\\",\\"input\\":{}}]}}"
done
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"fini","total_cost_usd":0}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    const result = await run(specFor(base, 4)).result;
    expect(result.outcome).toBe('success');
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

  it('accumulates usage across MULTIPLE result events (background subagent auto-resume)', async () => {
    const base = tmpDir('runner');
    // Verified CLI 2.1.214: a background subagent (--agents + Task) lets the main loop
    // emit result #1, then completion auto-resumes it → result #2. Each result carries
    // only its own segment's usage/num_turns — the runner must sum them, and keep the
    // LAST result's text as the final answer.
    const bin = makeFakeClaude(
      base,
      'claude-double-result',
      `
echo '{"type":"system","subtype":"init","session_id":"s-4","model":"m"}'
echo '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"je délègue au lecteur"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"le lecteur travaille","total_cost_usd":0.01,"usage":{"input_tokens":17,"output_tokens":597,"cache_creation_input_tokens":8780,"cache_read_input_tokens":48388}}'
echo '{"type":"assistant","message":{"id":"msg_2","content":[{"type":"text","text":"réponse finale"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"signature: runToolStep(ctx, o)","total_cost_usd":0.002,"usage":{"input_tokens":10,"output_tokens":161,"cache_creation_input_tokens":922,"cache_read_input_tokens":28995}}'
`
    );
    const config = testConfig(base, { claudeBin: bin, fakeCli: false });
    const run = createRealRunner(config, FAKE_CAPABILITIES);
    const result = await run(specFor(base, 10)).result;
    expect(result.outcome).toBe('success');
    expect(result.resultText).toBe('signature: runToolStep(ctx, o)');
    expect(result.numTurns).toBe(3);
    expect(result.costUsd).toBeCloseTo(0.012);
    expect(result.usage).toEqual({
      inputTokens: 27,
      outputTokens: 758,
      cacheCreationTokens: 9702,
      cacheReadTokens: 77383,
    });
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
