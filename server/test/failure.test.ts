import { describe, expect, it } from 'vitest';
import { classifyFailure, detectUsageLimit, parseClockToEpoch, RESET_CLAMP_MAX_MS, RESET_CLAMP_MIN_MS, RESET_FALLBACK_MS } from '../src/claude/failure.js';

const NOW = new Date('2026-07-19T20:00:00').getTime();

function classify(text: string, opts: Partial<Parameters<typeof classifyFailure>[0]> = {}) {
  return classifyFailure(
    {
      resultText: text,
      resultIsError: true,
      hasResultEvent: true,
      stderr: '',
      lastAssistantText: '',
      exitCode: 1,
      ...opts,
    },
    NOW
  );
}

describe('detectUsageLimit', () => {
  it('parses the legacy epoch format', () => {
    const epochSec = Math.floor(NOW / 1000) + 2 * 3600;
    const hit = detectUsageLimit(`Claude AI usage limit reached|${epochSec}`, true, NOW);
    expect(hit).not.toBeNull();
    expect(hit!.resetAt).toBe(epochSec * 1000);
  });

  it('parses "5-hour limit reached ∙ resets 3am"', () => {
    const hit = detectUsageLimit('5-hour limit reached ∙ resets 3am', true, NOW);
    expect(hit).not.toBeNull();
    // 3am is next day (now = 20:00) → clamped inside [now+15min, now+6h]
    expect(hit!.resetAt).toBeGreaterThanOrEqual(NOW + RESET_CLAMP_MIN_MS);
    expect(hit!.resetAt).toBeLessThanOrEqual(NOW + RESET_CLAMP_MAX_MS);
  });

  it('parses a 24h clock reset', () => {
    const hit = detectUsageLimit('Session limit reached · resets 21:30', true, NOW);
    expect(hit).not.toBeNull();
    expect(new Date(hit!.resetAt).getHours()).toBe(21);
    expect(new Date(hit!.resetAt).getMinutes()).toBe(30);
  });

  it('falls back to now+30min when no time is given', () => {
    const hit = detectUsageLimit('You have reached your usage limit', true, NOW);
    expect(hit).not.toBeNull();
    expect(hit!.resetAt).toBe(NOW + RESET_FALLBACK_MS);
  });

  it('ignores the broad pattern when the run did not error', () => {
    expect(detectUsageLimit('discussing usage limit concepts', false, NOW)).toBeNull();
  });
});

describe('parseClockToEpoch', () => {
  it('handles am/pm and rolls to next day', () => {
    const t = parseClockToEpoch('3am', NOW)!;
    const d = new Date(t);
    expect(d.getHours()).toBe(3);
    expect(t).toBeGreaterThan(NOW);
  });
  it('handles 12am/12pm', () => {
    expect(new Date(parseClockToEpoch('12am', NOW)!).getHours()).toBe(0);
    expect(new Date(parseClockToEpoch('12pm', NOW)!).getHours()).toBe(12);
  });
  it('rejects invalid clocks', () => {
    expect(parseClockToEpoch('99:99', NOW)).toBeNull();
  });
});

describe('classifyFailure', () => {
  it('classifies usage limit with clamped resetAt', () => {
    const f = classify('Claude AI usage limit reached|1783000000');
    expect(f.kind).toBe('usage_limit');
    expect(f.resetAt).toBeDefined();
    expect(f.resetAt!).toBeLessThanOrEqual(NOW + RESET_CLAMP_MAX_MS);
  });

  it('classifies auth failures', () => {
    expect(classify('Not logged in. Please run /login').kind).toBe('auth');
  });

  it('classifies lost sessions', () => {
    expect(classify('No conversation found with session ID abc').kind).toBe('resume_lost');
  });

  it('classifies overloaded/transient', () => {
    expect(classify('API Error: 529 overloaded_error, please retry').kind).toBe('overloaded');
  });

  it('honors kill reasons', () => {
    expect(classify('', { killedReason: 'canceled' }).kind).toBe('canceled');
    expect(classify('', { killedReason: 'timeout' }).kind).toBe('timeout');
  });

  it('classifies crash without result event', () => {
    const f = classify('segfault', { hasResultEvent: false, resultIsError: false, exitCode: 139 });
    expect(f.kind).toBe('crash');
  });

  it('classifies spawn errors', () => {
    expect(classify('', { spawnError: 'ENOENT' }).kind).toBe('spawn_error');
  });

  it('limit beats auth when both appear', () => {
    const f = classify('usage limit reached|1783000000 — also not logged in');
    expect(f.kind).toBe('usage_limit');
  });

  it('uses the exact rate_limit_event epoch when the stream provided one', () => {
    const resetsAtSec = Math.floor(NOW / 1000) + 3 * 3600;
    const f = classify('some opaque API error', {
      rateLimitInfo: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'five_hour' },
    });
    expect(f.kind).toBe('usage_limit');
    expect(f.resetAt).toBe(resetsAtSec * 1000);
    expect(f.matchedPattern).toContain('rate_limit_event:five_hour');
  });

  it('ignores rate_limit_event with status allowed/allowed_warning', () => {
    const f = classify('boom crash', { rateLimitInfo: { status: 'allowed', resetsAt: 1, rateLimitType: 'five_hour' } });
    expect(f.kind).not.toBe('usage_limit');
    const f2 = classify('boom crash', { rateLimitInfo: { status: 'allowed_warning', resetsAt: 1 } });
    expect(f2.kind).not.toBe('usage_limit');
  });

  it('trusts weekly resets from events beyond the 6h text clamp', () => {
    const resetsAtSec = Math.floor(NOW / 1000) + 3 * 24 * 3600;
    const f = classify('err', { rateLimitInfo: { status: 'rejected', resetsAt: resetsAtSec, rateLimitType: 'weekly' } });
    expect(f.resetAt).toBe(resetsAtSec * 1000);
  });
});

/**
 * Regression (emeline): `error_max_budget_usd` had no pattern at all, so a budget kill was
 * classified 'unknown' and the surfaced error became the model's last narration
 * ("Je lance 10 agents de recherche en parallèle…") — an undiagnosable build failure.
 */
describe('budget kill', () => {
  it('classifies the CLI subtype, not the model narration', () => {
    const f = classify("Je lance 10 agents de recherche en parallèle (lecture seule) pour vérifier chaque groupe.", {
      resultSubtype: 'error_max_budget_usd',
    });
    expect(f.kind).toBe('budget_exceeded');
    expect(f.message).toMatch(/max-budget-usd/);
    expect(f.message).toMatch(/0 pour lever le plafond/);
    // The narration must NOT leak into the operator-facing message.
    expect(f.message).not.toMatch(/agents de recherche/);
  });

  it('also catches the prose form when no subtype is available', () => {
    expect(classify('Error: max budget exceeded for this session').kind).toBe('budget_exceeded');
  });

  it('never shadows a usage limit — that one must park and resume, not fail', () => {
    const f = classify('Claude AI usage limit reached', { resultSubtype: 'error_max_budget_usd' });
    expect(f.kind).toBe('usage_limit');
    expect(f.resetAt).toBeGreaterThan(NOW);
  });

  it('does not fire on a successful run that merely mentions a budget', () => {
    const f = classify('Le budget de la page est respecté', { resultIsError: false, exitCode: 0 });
    expect(f.kind).not.toBe('budget_exceeded');
  });
});
