import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NdjsonSplitter, assistantTextOf, decodeEvent, structuredOf } from '../src/claude/ndjson.js';
import { displayForEvent } from '../src/claude/display.js';
import { classifyFailure } from '../src/claude/failure.js';
import { usageOf } from '../src/claude/runner.js';

const FIXTURES = path.resolve(__dirname, '../fixtures/ndjson');

function readFixtureLines(name: string): string[] {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const splitter = new NdjsonSplitter();
  // Feed in awkward 7-byte chunks to prove incremental splitting works.
  const lines: string[] = [];
  for (let i = 0; i < raw.length; i += 7) lines.push(...splitter.push(raw.slice(i, i + 7)));
  lines.push(...splitter.flush());
  return lines;
}

describe('NdjsonSplitter', () => {
  it('reassembles lines across arbitrary chunk boundaries', () => {
    const s = new NdjsonSplitter();
    const out = [...s.push('{"type":"sys'), ...s.push('tem"}\n{"type":"result"'), ...s.push('}\n')];
    expect(out).toEqual(['{"type":"system"}', '{"type":"result"}']);
  });

  it('flushes a trailing unterminated line', () => {
    const s = new NdjsonSplitter();
    s.push('{"type":"result"}');
    expect(s.flush()).toEqual(['{"type":"result"}']);
  });
});

describe('decodeEvent', () => {
  it('returns null for non-JSON and JSON without type', () => {
    expect(decodeEvent('not json')).toBeNull();
    expect(decodeEvent('{"foo":1}')).toBeNull();
  });

  it('extracts assistant text and tool_use display', () => {
    const evt = decodeEvent(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Bonjour' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      })
    )!;
    expect(assistantTextOf(evt)).toBe('Bonjour');
    expect(displayForEvent(evt)).toContain('Bonjour');
    expect(displayForEvent(evt)).toContain('Bash');
  });
});

describe('fixture streams', () => {
  it('parses a successful run end-to-end', () => {
    const events = readFixtureLines('ok-run.ndjson').map((l) => decodeEvent(l));
    expect(events.every((e) => e !== null)).toBe(true);
    const result = events.find((e) => e!.type === 'result')!;
    expect(result.is_error).toBe(false);
    expect(result.total_cost_usd).toBeGreaterThan(0);
    const init = events.find((e) => e!.type === 'system')!;
    expect(init.session_id).toBeTruthy();
  });

  it('parses a structured-output run', () => {
    const events = readFixtureLines('schema-output.ndjson').map((l) => decodeEvent(l)!);
    const result = events.find((e) => e.type === 'result')!;
    expect(structuredOf(result)).toMatchObject({ title: expect.any(String) });
  });

  it('classifies the epoch limit fixture as usage_limit', () => {
    const events = readFixtureLines('limit-epoch.ndjson').map((l) => decodeEvent(l)!);
    const result = events.find((e) => e.type === 'result')!;
    const f = classifyFailure({
      resultText: String(result.result ?? ''),
      resultIsError: Boolean(result.is_error),
      hasResultEvent: true,
      stderr: '',
      lastAssistantText: '',
      exitCode: 1,
    });
    expect(f.kind).toBe('usage_limit');
    expect(f.resetAt).toBeDefined();
  });

  it('parses the REAL recorded stream (subscription, CLI 2.1.214)', () => {
    const events = readFixtureLines('real-simple.ndjson').map((l) => decodeEvent(l));
    expect(events.every((e) => e !== null)).toBe(true);
    const init = events.find((e) => e!.type === 'system' && e!.subtype === 'init')!;
    expect(init.session_id).toBeTruthy();
    const rl = events.find((e) => e!.type === 'rate_limit_event')!;
    expect(rl.rate_limit_info?.rateLimitType).toBe('five_hour');
    expect(typeof rl.rate_limit_info?.resetsAt).toBe('number');
    const result = events.find((e) => e!.type === 'result')!;
    expect(result.is_error).toBe(false);
    expect(result.result).toBe('OK');
    expect(result.total_cost_usd).toBeGreaterThan(0);
    // Token usage extraction (what the UI now shows instead of cost)
    const usage = usageOf(result);
    expect(usage).toEqual({ inputTokens: 2, outputTokens: 4, cacheCreationTokens: 5682, cacheReadTokens: 3289 });
  });

  it('parses the REAL structured-output stream', () => {
    const events = readFixtureLines('real-schema.ndjson').map((l) => decodeEvent(l)!);
    const result = events.find((e) => e.type === 'result')!;
    expect(structuredOf(result)).toMatchObject({ title: expect.any(String), spec_markdown: expect.any(String) });
  });

  it('parses the REAL resume stream (same session id kept)', () => {
    const simple = readFixtureLines('real-simple.ndjson').map((l) => decodeEvent(l)!);
    const resume = readFixtureLines('real-resume.ndjson').map((l) => decodeEvent(l)!);
    const sid1 = simple.find((e) => e.type === 'system')!.session_id;
    const sid2 = resume.find((e) => e.type === 'system')!.session_id;
    expect(sid1).toBe(sid2);
    expect(resume.find((e) => e.type === 'result')!.result).toBe('ENCORE OK');
  });

  it('classifies the text limit fixture as usage_limit', () => {
    const events = readFixtureLines('limit-text.ndjson').map((l) => decodeEvent(l)!);
    const result = events.find((e) => e.type === 'result')!;
    const f = classifyFailure({
      resultText: String(result.result ?? ''),
      resultIsError: Boolean(result.is_error),
      hasResultEvent: true,
      stderr: '',
      lastAssistantText: '',
      exitCode: 1,
    });
    expect(f.kind).toBe('usage_limit');
  });
});
