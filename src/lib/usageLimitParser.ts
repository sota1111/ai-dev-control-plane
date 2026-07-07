import * as appEnv from '../config/env.js';

/**
 * SOT-1446: never let a cooldown retry be scheduled more than MAX_COOLDOWN_SECONDS in the future,
 * so a misparsed / far-future reset can't strand a worker (observed: a Codex cooldown set ~185 days
 * out). Caps the given retry epoch (seconds) to now + maxCooldownSeconds. Only the RETRY/resume
 * time is capped — the reported reset time (resetAt) is left untouched.
 *
 * Exported so the cooldown-emit call sites (runner-cli `parse-usage-limit-epoch` for the worker
 * cooldown files, and classifyUsageLimit for the harness cooldown) share one ceiling. Kept OUT of
 * the pure parser (parseUsageLimitResetEpoch / parseRawResetEpoch) so timezone/date parsing stays
 * independently testable.
 */
export function capRetryEpoch(epochSeconds: number, nowMs: number = Date.now()): number {
  const maxAt = Math.floor(nowMs / 1000) + appEnv.maxCooldownSeconds();
  return Math.min(epochSeconds, maxAt);
}

/**
 * Internal helper to parse raw usage limit reset time from text and returns the Unix epoch (seconds).
 */

function parseRawResetEpoch(text: string, nowMs: number): number | null {
  // 'try again at' covers the Codex usage-limit phrasing
  // ("...try again at Jun 21st, 2026 12:05 AM.").
  const keywords = ['resets', 'reset at', 'resets at', 'will reset at', 'Your limit will reset', 'try again at', 'quota exceeded', 'resource exhausted', 'rate limit', 'RESOURCE_EXHAUSTED'];
  if (!keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) return null;

  // Try to find an IANA timezone in ( ). Guard against capturing a URL in
  // parentheses (e.g. Codex prints "(https://chatgpt.com/...)"): a valid tz has
  // no whitespace and is not a URL. Fall back to UTC otherwise.
  const tzCandidate = (text.match(/\(([^)]+)\)/) || [])[1];
  const ianaTZ = tzCandidate && !/\s/.test(tzCandidate) && !tzCandidate.includes('http')
    ? tzCandidate
    : 'UTC';

  // Extract date if present (e.g., "Oct 6", "Jun 21st, 2026").
  // Optional ordinal suffix (st/nd/rd/th) and optional 4-digit year are supported.
  const dateMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/i);
  
  // Extract time (e.g., 3:30pm, 15:30, 3pm, 7pm)
  const timeRegex = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
  const timeMatch = text.match(timeRegex);
  
  if (!timeMatch) return null;

  let hours: number, minutes: number, ampm: string | null;
  if (timeMatch[1]) {
    // Matched (\d{1,2})(?::(\d{2}))?\s*(am|pm)
    hours = parseInt(timeMatch[1], 10);
    minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    ampm = timeMatch[3].toLowerCase();
  } else {
    // Matched (\d{1,2}):(\d{2})
    hours = parseInt(timeMatch[4], 10);
    minutes = parseInt(timeMatch[5], 10);
    ampm = null;
  }
  
  if (ampm) {
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
  }

  const now = new Date(nowMs);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let day = now.getUTCDate();

  if (dateMatch) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    month = months.indexOf(dateMatch[1].toLowerCase());
    day = parseInt(dateMatch[2], 10);
    // Use the explicit year when present (e.g. "Jun 21st, 2026"), so cross-year
    // resets are not silently assumed to be the current year.
    if (dateMatch[3]) {
      year = parseInt(dateMatch[3], 10);
    }
  }

  try {
    const epoch = getEpochForTZ(year, month, day, hours, minutes, ianaTZ);
    if (isNaN(epoch)) return null;

    let resultEpoch = Math.floor(epoch / 1000);
    
    // If parsed UTC time is in the past, and no date was specified, add 24 hours
    if (!dateMatch && resultEpoch <= Math.floor(nowMs / 1000)) {
      resultEpoch += 86400;
    }

    return resultEpoch;
  } catch (e) {
    return null;
  }
}

/**
 * Parses usage limit reset time from text and returns the Unix epoch (seconds) of the reset time + buffer.
 * 
 * @param {string} text - Combined stdout/stderr from run_auto.sh
 * @param {number} [nowMs] - Optional current time in ms for testability
 * @returns {number | null} - Unix epoch (seconds) or null if not applicable
 */
export function parseUsageLimitResetEpoch(text: string, nowMs: number = Date.now()): number | null {
  const buffer = appEnv.usageLimitRetryBufferSeconds();
  const rawEpoch = parseRawResetEpoch(text, nowMs);
  if (rawEpoch === null) return null;
  return rawEpoch + buffer;
}

interface UsageLimitResult {
  type: string;
  retryable: boolean;
  resetAt: string | null;
  retryAt: string | null;
  confidence: string;
  rawMessage: string;
}

// SOT-1587: attribute a usage-limit hit to the worker that caused it. The dispatcher run scripts print
// an explicit marker at the point they detect a usage limit — CLAUDE_* from run_claude.sh, CODEX_* from
// run_codex.sh, ANTIGRAVITY_* from run_antigravity.sh. These let us tell WHOSE limit is in the combined
// run output (classifyUsageLimit alone cannot: it just pattern-matches the raw CLI error text, which for
// a codex handoff is codex's "You've hit your usage limit … try again at …").
const CLAUDE_LIMIT_MARKER = /CLAUDE_USAGE_LIMIT|CLAUDE_COOLDOWN_ACTIVE/i;
const WORKER_LIMIT_MARKER = /CODEX_USAGE_LIMIT|CODEX_COOLDOWN_ACTIVE|ANTIGRAVITY_USAGE_LIMIT|ANTIGRAVITY_COOLDOWN_ACTIVE/i;

/**
 * SOT-1587: true when the ONLY worker that hit a usage limit in this run is a fallback worker
 * (codex / antigravity), NOT Claude. Such a limit is already handled by that worker's own per-worker
 * cooldown file + dispatcher handoff, so it must NOT drive the GLOBAL runner cooldown (which represents
 * "Claude — the account-global primary — is unavailable" and gates the whole pipeline). Separating the
 * two keeps a codex cooldown from wrongly halting Claude-primary work.
 *
 * Returns false when Claude also hit a limit (global cooldown applies) or when there is no worker
 * marker at all (backward compatible: a bare usage-limit classification still gates globally).
 */
export function isWorkerOnlyUsageLimit(output: string): boolean {
  if (!output) return false;
  if (CLAUDE_LIMIT_MARKER.test(output)) return false; // Claude also limited → global cooldown is correct
  return WORKER_LIMIT_MARKER.test(output);            // only codex/antigravity limited → per-worker only
}

// HTTP ステータスを示す文脈語。裸の数字一致による誤検知を抑えるため、
// ステータスコード判定は「単語境界つきの数字」かつ「この文脈語のいずれかが本文に存在」
// する場合のみ真とする。
const HTTP_STATUS_CONTEXT = /\b(https?|status|error|code|response|api|server|unavailable|overloaded|service|too many requests|rate ?limits?|unauthorized|forbidden|quota)\b/;

/**
 * 本文中に指定のHTTPステータスコードが「ステータスコードとして」現れているかを判定する。
 *
 * 素朴な includes('503') はタイムスタンプ等（例: 開始時刻 "125034" に '503' が部分一致）にも
 * マッチして usage-limit を誤検知し、不要な cooldown を引き起こす。これを防ぐため:
 *   1. 数字は単語境界 \b で囲んでマッチさせる（連続数字の途中一致を排除）
 *   2. かつ HTTP/ステータス文脈語が本文に存在することを要求する
 *
 * @param {string} lowerText 小文字化済みの本文
 * @param {string} code 判定するステータスコード（例: '503'）
 */
function hasHttpStatus(lowerText: string, code: string): boolean {
  if (!new RegExp(`\\b${code}\\b`).test(lowerText)) return false;
  return HTTP_STATUS_CONTEXT.test(lowerText);
}

/**
 * Classifies the type of limit encountered in the text.
 *
 * @param {string} text
 * @param {number} nowMs
 */
export function classifyUsageLimit(text: string, nowMs: number = Date.now()): UsageLimitResult {
  const buffer = appEnv.usageLimitRetryBufferSeconds();
  const overloadBuffer = appEnv.overloadRetryBufferSeconds();
  const lowerText = text.toLowerCase();
  
  const result: UsageLimitResult = {
    type: 'unknown',
    retryable: false,
    resetAt: null,
    retryAt: null,
    confidence: 'low',
    rawMessage: text.substring(0, 300)
  };

  // Weekly limit
  if (lowerText.includes('weekly limit') || lowerText.includes('limit resets next week') || lowerText.includes('this week')) {
    result.type = 'weekly_limit';
    result.retryable = false;
    result.confidence = 'high';
    const rawEpoch = parseRawResetEpoch(text, nowMs);
    if (rawEpoch) {
      result.resetAt = new Date(rawEpoch * 1000).toISOString();
    }
    return result;
  }

  // Session limit
  if (lowerText.includes('session limit') || lowerText.includes('usage limit') || 
      lowerText.includes('your limit will reset') || lowerText.includes('resets at')) {
    const rawEpoch = parseRawResetEpoch(text, nowMs);
    if (rawEpoch) {
      result.type = 'session_limit';
      result.retryable = true;
      result.confidence = 'high';
      result.resetAt = new Date(rawEpoch * 1000).toISOString();
      result.retryAt = new Date(capRetryEpoch(rawEpoch + buffer, nowMs) * 1000).toISOString();
      return result;
    }
  }

  // API 429
  if (lowerText.includes('too many requests') || lowerText.includes('rate limit') || hasHttpStatus(lowerText, '429')) {
    result.type = 'api_429';
    result.retryable = true;
    result.confidence = 'high';
    
    // Look for retry-after in seconds
    const retryAfterMatch = text.match(/retry-after:\s*(\d+)/i);
    const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : buffer;
    
    result.retryAt = new Date(capRetryEpoch(Math.floor(nowMs / 1000) + retryAfterSeconds, nowMs) * 1000).toISOString();
    return result;
  }

  // Auth Error
  if (lowerText.includes('unauthorized') || lowerText.includes('authentication') ||
      lowerText.includes('invalid api key') || lowerText.includes('credentials') ||
      hasHttpStatus(lowerText, '401') || hasHttpStatus(lowerText, '403')) {
    result.type = 'auth_error';
    result.retryable = false;
    result.confidence = 'high';
    return result;
  }

  // Context Limit
  if (lowerText.includes('context length') || lowerText.includes('maximum context') || 
      lowerText.includes('too many tokens') || lowerText.includes('prompt is too long')) {
    result.type = 'context_limit';
    result.retryable = false;
    result.confidence = 'high';
    return result;
  }

  // Model Unavailable
  if (lowerText.includes('model is currently unavailable') || lowerText.includes('overloaded') ||
      lowerText.includes('service unavailable') || hasHttpStatus(lowerText, '503') || hasHttpStatus(lowerText, '529')) {
    result.type = 'model_unavailable';
    result.retryable = true;
    result.confidence = 'medium';
    result.retryAt = new Date(capRetryEpoch(Math.floor(nowMs / 1000) + overloadBuffer, nowMs) * 1000).toISOString();
    return result;
  }

  // Network Error
  if (lowerText.includes('econnreset') || lowerText.includes('etimedout') || lowerText.includes('network') || 
      lowerText.includes('fetch failed') || lowerText.includes('socket hang up')) {
    result.type = 'network_error';
    result.retryable = true;
    result.confidence = 'medium';
    const backoff = Math.min(buffer, 120);
    result.retryAt = new Date(capRetryEpoch(Math.floor(nowMs / 1000) + backoff, nowMs) * 1000).toISOString();
    return result;
  }

  return result;
}

/**
 * Calculates UTC epoch for a given local time in a specific timezone.
 */
function getEpochForTZ(year: number, month: number, day: number, hours: number, minutes: number, timeZone: string): number {
  let date = new Date(Date.UTC(year, month, day, hours, minutes));
  for (let i = 0; i < 2; i++) {
    const offsetMs = getTimezoneOffsetMs(timeZone, date);
    const correctedDate = new Date(Date.UTC(year, month, day, hours, minutes) - offsetMs);
    if (Math.abs(correctedDate.getTime() - date.getTime() + offsetMs) < 1000) {
        return correctedDate.getTime();
    }
    date = correctedDate;
  }
  return date.getTime();
}

/**
 * Gets the difference between local time in timeZone and UTC for a given date.
 */
function getTimezoneOffsetMs(timeZone: string, date: Date): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const p: any = {};
    parts.forEach(part => p[part.type] = part.value);
    
    const tzDate = new Date(Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour % 24,
      p.minute,
      p.second
    ));
    return tzDate.getTime() - date.getTime();
  } catch (e) {
    return 0;
  }
}
