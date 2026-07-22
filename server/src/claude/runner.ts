import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { Capabilities } from './capabilities.js';
import { buildArgs, buildEnv } from './sessionArgs.js';
import { NdjsonSplitter, decodeEvent, assistantTextOf, structuredOf, type ClaudeEvent, type RateLimitInfo } from './ndjson.js';
import { displayForEvent } from './display.js';
import { classifyFailure } from './failure.js';
import { ZERO_USAGE, type RunHandle, type RunHooks, type RunResult, type RunUsage, type SessionSpec } from './types.js';

const KILL_GRACE_MS = 10_000;
const STDERR_CAP = 32 * 1024;

/** Extract the aggregate token usage from a `result` event's snake_case `usage` block. */
export function usageOf(evt: ClaudeEvent | null): RunUsage {
  const u = evt?.usage as Record<string, unknown> | undefined;
  if (!u) return ZERO_USAGE;
  const num = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheCreationTokens: num('cache_creation_input_tokens'),
    cacheReadTokens: num('cache_read_input_tokens'),
  };
}

export function createRealRunner(config: Config, caps: Capabilities) {
  return function run(spec: SessionSpec, hooks: RunHooks = {}): RunHandle {
    const argv = buildArgs(spec, caps);
    const env = buildEnv(config);
    const startedAt = Date.now();

    let killedReason: 'timeout' | 'canceled' | null = null;
    let spawnError: string | null = null;
    let resultEvent: ClaudeEvent | null = null;
    let lastAssistantText = '';
    let actualSessionId = spec.sessionId;
    // Logical turns: the stream emits one `assistant` event PER CONTENT BLOCK
    // (thinking/text/tool_use share the same message.id) — count unique ids, not events.
    let turns = 0;
    let lastAssistantMsgId: string | null = null;
    let stderrBuf = '';
    let lastRateLimitInfo: RateLimitInfo | null = null;

    const child = spawn(config.claudeBin, argv, {
      cwd: spec.cwd,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const pid = child.pid ?? null;
    if (pid) hooks.onPid?.(pid);

    const killGroup = (signal: NodeJS.Signals) => {
      try {
        if (pid) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let killTimer: NodeJS.Timeout | null = null;
    const requestKill = (reason: 'timeout' | 'canceled') => {
      if (killedReason) return;
      killedReason = reason;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timeout = setTimeout(() => requestKill('timeout'), spec.timeoutMs);

    child.on('error', (err) => {
      spawnError = err.message;
    });
    child.stdin.on('error', () => {
      /* EPIPE when the process dies before reading the prompt */
    });
    child.stdin.write(spec.prompt);
    child.stdin.end();

    const splitter = new NdjsonSplitter();
    const handleLine = (line: string) => {
      const evt = decodeEvent(line);
      // Raw line always persisted; empty display = noise filtered from SSE/UI.
      const display = evt ? (displayForEvent(evt) ?? '') : line;
      hooks.onLog?.({ kind: evt ? 'stdout_json' : 'meta', line, display });
      if (!evt) return;
      if (evt.type === 'system' && evt.subtype === 'init' && typeof evt.session_id === 'string') {
        actualSessionId = evt.session_id;
      } else if (evt.type === 'assistant') {
        const msgId = (evt.message as { id?: string } | undefined)?.id ?? null;
        if (msgId === null || msgId !== lastAssistantMsgId) {
          turns += 1;
          lastAssistantMsgId = msgId;
        }
        const text = assistantTextOf(evt);
        if (text.trim()) lastAssistantText = text;
        if (turns > spec.maxTurns) requestKill('timeout');
      } else if (evt.type === 'result') {
        resultEvent = evt;
      } else if (evt.type === 'rate_limit_event' && evt.rate_limit_info) {
        lastRateLimitInfo = evt.rate_limit_info;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });

    const stderrSplitter = new NdjsonSplitter();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderrBuf.length < STDERR_CAP) stderrBuf += chunk.slice(0, STDERR_CAP - stderrBuf.length);
      for (const line of stderrSplitter.push(chunk)) {
        hooks.onLog?.({ kind: 'stderr', line, display: `⚠ ${line.slice(0, 500)}` });
      }
    });

    const result = new Promise<RunResult>((resolve) => {
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        for (const line of splitter.flush()) handleLine(line);
        for (const line of stderrSplitter.flush()) hooks.onLog?.({ kind: 'stderr', line, display: `⚠ ${line.slice(0, 500)}` });

        const durationMs = Date.now() - startedAt;
        const resultText = String(resultEvent?.result ?? '');
        const numTurns = typeof resultEvent?.num_turns === 'number' ? resultEvent.num_turns : turns;
        const costUsd = typeof resultEvent?.total_cost_usd === 'number' ? resultEvent.total_cost_usd : 0;
        const usage = usageOf(resultEvent);

        if (resultEvent && !resultEvent.is_error && !killedReason && !spawnError) {
          resolve({
            outcome: 'success',
            sessionId: actualSessionId,
            resultText,
            structured: structuredOf(resultEvent),
            numTurns,
            costUsd,
            usage,
            rateLimitInfo: lastRateLimitInfo ?? undefined,
            durationMs,
          });
          return;
        }
        const failure = classifyFailure({
          resultText,
          resultIsError: Boolean(resultEvent?.is_error),
          hasResultEvent: resultEvent !== null,
          stderr: stderrBuf,
          lastAssistantText,
          exitCode: code,
          killedReason,
          spawnError,
          rateLimitInfo: lastRateLimitInfo,
        });
        resolve({
          outcome: 'failure',
          sessionId: actualSessionId,
          resultText,
          structured: resultEvent ? structuredOf(resultEvent) : undefined,
          numTurns,
          costUsd,
          usage,
          rateLimitInfo: lastRateLimitInfo ?? undefined,
          durationMs,
          failure,
        });
      });
    });

    return {
      pid,
      result,
      cancel: (reason) => requestKill(reason),
    };
  };
}
