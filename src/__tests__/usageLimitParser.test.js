const { parseUsageLimitResetEpoch } = require('../lib/usageLimitParser');

describe('parseUsageLimitResetEpoch', () => {
  const REF_MS = 1749722400000; // 2026-06-12T10:00:00Z
  const BUFFER = 600;
  const TODAY_MIDNIGHT_UTC = 1749686400;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(REF_MS);
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
  });
  afterEach(() => jest.restoreAllMocks());

  test('parses "resets 3:30pm (UTC)"', () => {
    // 3:30pm UTC = 15:30 UTC = TODAY_MIDNIGHT_UTC + 15.5 * 3600 = 1749742200
    const result = parseUsageLimitResetEpoch("You've hit your session limit · resets 3:30pm (UTC)");
    expect(result).toBe(1749742200 + BUFFER);
  });

  test('parses "resets 15:30 (UTC)"', () => {
    const result = parseUsageLimitResetEpoch("resets 15:30 (UTC)");
    expect(result).toBe(1749742200 + BUFFER); // same as above
  });

  test('parses "Your limit will reset at 3pm (America/Santiago)"', () => {
    // America/Santiago in June 2026 is UTC-4
    // 3pm Santiago = 19:00 UTC = TODAY_MIDNIGHT_UTC + 19 * 3600 = 1749754800
    const result = parseUsageLimitResetEpoch("Your limit will reset at 3pm (America/Santiago)");
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(REF_MS / 1000);
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "Your limit will reset at 7pm (Asia/Tokyo)"', () => {
    // 7pm Tokyo = 10:00 UTC (UTC+9). Exactly at ref time → next day
    // 10:00 UTC next day = 1749722400 + 86400 = 1749808800
    const result = parseUsageLimitResetEpoch("Your limit will reset at 7pm (Asia/Tokyo)");
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(REF_MS / 1000);
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(10);
    expect(d.getUTCDate()).toBe(13); // Next day
  });

  test('parses "Your limit will reset at Oct 6, 1pm"', () => {
    // Oct 6, 1pm UTC (no timezone given → UTC)
    const result = parseUsageLimitResetEpoch("Your limit will reset at Oct 6, 1pm");
    expect(typeof result).toBe('number');
    // Should be in 2026 (same year as ref)
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCMonth()).toBe(9); // October = month index 9
    expect(d.getUTCDate()).toBe(6);
    expect(d.getUTCHours()).toBe(13);
  });

  test('parses "reset at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("reset at 7pm");
    // 7pm UTC = 19:00 UTC today (after 10:00 ref) = TODAY_MIDNIGHT_UTC + 19 * 3600 = 1749754800
    expect(typeof result).toBe('number');
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "resets at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("resets at 7pm");
    expect(typeof result).toBe('number');
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "will reset at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("will reset at 7pm");
    expect(typeof result).toBe('number');
    const d = new Date((result - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('returns null for text with no usage limit message', () => {
    expect(parseUsageLimitResetEpoch("some random error occurred")).toBeNull();
  });

  test('returns null for unrecognizable time format', () => {
    expect(parseUsageLimitResetEpoch("resets at SOMETIME")).toBeNull();
  });

  test('applies custom buffer from env var', () => {
    process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS = '5';
    const result = parseUsageLimitResetEpoch("resets 15:30 (UTC)");
    // Should be reset epoch + 5 = 1749742200 + 5
    expect(result).toBe(1749742200 + 5);
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
  });
});
