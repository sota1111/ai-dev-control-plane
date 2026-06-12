/**
 * Parses usage limit reset time from text and returns the Unix epoch (seconds) of the reset time + buffer.
 * 
 * @param {string} text - Combined stdout/stderr from run_auto.sh
 * @param {number} [nowMs] - Optional current time in ms for testability
 * @returns {number | null} - Unix epoch (seconds) or null if not applicable
 */
function parseUsageLimitResetEpoch(text, nowMs = Date.now()) {
  const buffer = parseInt(process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS || '600', 10);
  
  const keywords = ['resets', 'reset at', 'resets at', 'will reset at', 'Your limit will reset'];
  if (!keywords.some(k => text.includes(k))) return null;

  // Try to find timezone in ( )
  const tzMatch = text.match(/\(([^)]+)\)/);
  const ianaTZ = tzMatch ? tzMatch[1] : 'UTC';

  // Extract date if present (e.g., Oct 6)
  const dateMatch = text.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/i);
  
  // Extract time (e.g., 3:30pm, 15:30, 3pm, 7pm)
  // We use a regex that requires am/pm or a colon to avoid matching day numbers
  const timeRegex = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/i;
  const timeMatch = text.match(timeRegex);
  
  if (!timeMatch) return null;

  let hours, minutes, ampm;
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

    return resultEpoch + buffer;
  } catch (e) {
    return null;
  }
}

/**
 * Calculates UTC epoch for a given local time in a specific timezone.
 */
function getEpochForTZ(year, month, day, hours, minutes, timeZone) {
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
function getTimezoneOffsetMs(timeZone, date) {
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
    const p = {};
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

module.exports = { parseUsageLimitResetEpoch };
