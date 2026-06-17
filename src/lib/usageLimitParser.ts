/**
 * Internal helper to parse raw usage limit reset time from text and returns the Unix epoch (seconds).
 */
export {};

function parseRawResetEpoch(text: string, nowMs: number): number | null {
  const keywords = ['resets', 'reset at', 'resets at', 'will reset at', 'Your limit will reset'];
  if (!keywords.some(k => text.toLowerCase().includes(k.toLowerCase()))) return null;

  // Try to find timezone in ( )
  const tzMatch = text.match(/\(([^)]+)\)/);
  const ianaTZ = tzMatch ? tzMatch[1] : 'UTC';

  // Extract date if present (e.g., Oct 6)
  const dateMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/i);
  
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
function parseUsageLimitResetEpoch(text: string, nowMs: number = Date.now()): number | null {
  const buffer = parseInt(process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS || '600', 10);
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

/**
 * Classifies the type of limit encountered in the text.
 * 
 * @param {string} text 
 * @param {number} nowMs 
 */
function classifyUsageLimit(text: string, nowMs: number = Date.now()): UsageLimitResult {
  const buffer = parseInt(process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS || '600', 10);
  const overloadBuffer = parseInt(process.env.OVERLOAD_RETRY_BUFFER_SECONDS || '3600', 10);
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
      result.retryAt = new Date((rawEpoch + buffer) * 1000).toISOString();
      return result;
    }
  }

  // API 429
  if (lowerText.includes('429') || lowerText.includes('too many requests') || lowerText.includes('rate limit')) {
    result.type = 'api_429';
    result.retryable = true;
    result.confidence = 'high';
    
    // Look for retry-after in seconds
    const retryAfterMatch = text.match(/retry-after:\s*(\d+)/i);
    const retryAfterSeconds = retryAfterMatch ? parseInt(retryAfterMatch[1], 10) : buffer;
    
    result.retryAt = new Date(nowMs + (retryAfterSeconds * 1000)).toISOString();
    return result;
  }

  // Auth Error
  if (lowerText.includes('401') || lowerText.includes('403') || lowerText.includes('unauthorized') || 
      lowerText.includes('authentication') || lowerText.includes('invalid api key') || lowerText.includes('credentials')) {
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
      lowerText.includes('503') || lowerText.includes('529') || lowerText.includes('service unavailable')) {
    result.type = 'model_unavailable';
    result.retryable = true;
    result.confidence = 'medium';
    result.retryAt = new Date(nowMs + (overloadBuffer * 1000)).toISOString();
    return result;
  }

  // Network Error
  if (lowerText.includes('econnreset') || lowerText.includes('etimedout') || lowerText.includes('network') || 
      lowerText.includes('fetch failed') || lowerText.includes('socket hang up')) {
    result.type = 'network_error';
    result.retryable = true;
    result.confidence = 'medium';
    const backoff = Math.min(buffer, 120);
    result.retryAt = new Date(nowMs + (backoff * 1000)).toISOString();
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

module.exports = { parseUsageLimitResetEpoch, classifyUsageLimit };
