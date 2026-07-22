import type { Failure } from './types.js';

export const RESET_CLAMP_MIN_MS = 15 * 60 * 1000;
export const RESET_CLAMP_MAX_MS = 6 * 60 * 60 * 1000;
export const RESET_FALLBACK_MS = 30 * 60 * 1000;

interface LimitPattern {
  re: RegExp;
  /** capture group index containing an epoch (s or ms) */
  epoch?: number;
  /** capture group index containing a clock time like "3am" / "14:30" */
  clock?: number;
  /** broad patterns only apply when the run actually errored */
  requiresError?: boolean;
}

export const LIMIT_PATTERNS: LimitPattern[] = [
  { re: /usage limit reached\|(\d{10,13})/i, epoch: 1 },
  { re: /(?:5-?\s?hour|five-?\s?hour|weekly|session|opus|sonnet)\s+limit reached[^\n]*?resets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i, clock: 1 },
  { re: /(?:5-?\s?hour|five-?\s?hour|weekly|session)\s+limit reached/i },
  { re: /limit (?:will\s+)?resets?\s+(?:at\s+)?([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i, clock: 1 },
  { re: /you(?:'ve| have) (?:hit|reached) (?:your|the) .{0,40}limit/i },
  { re: /claude (?:ai\s+)?usage limit reached/i },
  { re: /usage limit/i, requiresError: true },
];

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run [`']?\/?login/i,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /oauth token (?:has )?(?:expired|revoked)/i,
  /credential.*(?:expired|invalid|missing)/i,
];

const RESUME_LOST_PATTERNS = [/no conversation found/i, /session (?:id )?.{0,40}not found/i, /could not resume/i];

const OVERLOADED_PATTERNS = [/overloaded[_ ]error/i, /\b529\b/, /\b503\b/, /internal server error/i, /api error.*retry/i, /connection (?:refused|reset|error)/i, /fetch failed/i, /etimedout|econnreset|enotfound/i];

/** Parse a clock string like "3am", "11:30pm", "14:30" into the next occurrence (local time), epoch ms. */
export function parseClockToEpoch(clock: string, now: number): number | null {
  const m = clock.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  if (Number.isNaN(hours) || hours > 23 || minutes > 59) return null;
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  const d = new Date(now);
  d.setHours(hours, minutes, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function clampResetAt(resetAt: number | null, now: number): number {
  if (resetAt === null || Number.isNaN(resetAt)) return now + RESET_FALLBACK_MS;
  return Math.min(Math.max(resetAt, now + RESET_CLAMP_MIN_MS), now + RESET_CLAMP_MAX_MS);
}

/** Try every limit pattern; returns the matched pattern + clamped resetAt when the text signals a usage limit. */
export function detectUsageLimit(text: string, isError: boolean, now = Date.now()): { resetAt: number; matchedPattern: string } | null {
  for (const p of LIMIT_PATTERNS) {
    if (p.requiresError && !isError) continue;
    const m = text.match(p.re);
    if (!m) continue;
    let resetAt: number | null = null;
    if (p.epoch !== undefined && m[p.epoch]) {
      const raw = parseInt(m[p.epoch], 10);
      resetAt = m[p.epoch].length >= 13 ? raw : raw * 1000;
    } else if (p.clock !== undefined && m[p.clock]) {
      resetAt = parseClockToEpoch(m[p.clock], now);
    }
    return { resetAt: clampResetAt(resetAt, now), matchedPattern: m[0].slice(0, 120) };
  }
  return null;
}

export interface ClassifyInput {
  resultText: string;
  resultIsError: boolean;
  hasResultEvent: boolean;
  stderr: string;
  lastAssistantText: string;
  exitCode: number | null;
  killedReason?: 'timeout' | 'canceled' | null;
  spawnError?: string | null;
  /** Latest rate_limit_event seen in the stream (exact reset epoch, seconds). */
  rateLimitInfo?: { status?: string; resetsAt?: number; rateLimitType?: string } | null;
}

const EVENT_RESET_MAX_MS = 8 * 24 * 60 * 60 * 1000; // trust event epochs up to 8 days (weekly window)

export function classifyFailure(input: ClassifyInput, now = Date.now()): Failure {
  if (input.spawnError) {
    return { kind: 'spawn_error', message: `Impossible de lancer claude: ${input.spawnError}` };
  }
  if (input.killedReason === 'canceled') {
    return { kind: 'canceled', message: 'Session interrompue à la demande' };
  }
  if (input.killedReason === 'timeout') {
    return { kind: 'timeout', message: 'Cap de durée/tours dépassé — session stoppée par le superviseur' };
  }

  const haystack = [input.resultText, input.stderr, input.lastAssistantText].filter(Boolean).join('\n');
  const isError = input.resultIsError || !input.hasResultEvent || (input.exitCode !== null && input.exitCode !== 0);

  // Exact signal first: the stream's rate_limit_event carries the true reset epoch.
  const rl = input.rateLimitInfo;
  if (isError && rl?.status && rl.status !== 'allowed' && !/allowed/.test(rl.status)) {
    const resetAt =
      typeof rl.resetsAt === 'number'
        ? Math.min(Math.max(rl.resetsAt * 1000, now + 60_000), now + EVENT_RESET_MAX_MS)
        : now + RESET_FALLBACK_MS;
    return {
      kind: 'usage_limit',
      message: `Limite d'usage atteinte (rate_limit_event: ${rl.rateLimitType ?? '?'} / ${rl.status})`,
      resetAt,
      matchedPattern: `rate_limit_event:${rl.rateLimitType ?? '?'}:${rl.status}`,
    };
  }

  const limit = detectUsageLimit(haystack, isError, now);
  if (limit) {
    return {
      kind: 'usage_limit',
      message: `Limite d'usage de l'abonnement atteinte (motif: « ${limit.matchedPattern} »)`,
      resetAt: limit.resetAt,
      matchedPattern: limit.matchedPattern,
    };
  }
  for (const re of AUTH_PATTERNS) {
    if (re.test(haystack)) return { kind: 'auth', message: `Authentification claude invalide: ${haystack.slice(0, 200)}` };
  }
  for (const re of RESUME_LOST_PATTERNS) {
    if (re.test(haystack)) return { kind: 'resume_lost', message: 'Session introuvable pour --resume — reprise impossible, redémarrage à neuf requis' };
  }
  for (const re of OVERLOADED_PATTERNS) {
    if (re.test(haystack)) return { kind: 'overloaded', message: `Erreur transitoire API: ${haystack.slice(0, 200)}` };
  }
  if (!input.hasResultEvent && input.exitCode !== 0) {
    return { kind: 'crash', message: `Le process claude s'est terminé (code ${input.exitCode}) sans résultat: ${haystack.slice(0, 300)}` };
  }
  return { kind: 'unknown', message: haystack.slice(0, 400) || `Échec inconnu (code ${input.exitCode})` };
}
