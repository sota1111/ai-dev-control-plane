import { jest } from '@jest/globals';
import { parseUsageLimitResetEpoch } from '../lib/usageLimitParser.js';

describe('parseUsageLimitResetEpoch', () => {
  const REF_MS = 1749722400000; // 2026-06-12T10:00:00Z
  const BUFFER = 600;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(REF_MS);
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
  });
  afterEach(() => jest.restoreAllMocks());

  test('parses "resets 3:30pm (UTC)"', () => {
    const result = parseUsageLimitResetEpoch("You've hit your session limit · resets 3:30pm (UTC)");
    expect(result).toBe(1749742200 + BUFFER);
  });

  test('parses "resets 15:30 (UTC)"', () => {
    const result = parseUsageLimitResetEpoch("resets 15:30 (UTC)");
    expect(result).toBe(1749742200 + BUFFER); 
  });

  test('parses "Your limit will reset at 3pm (America/Santiago)"', () => {
    const result = parseUsageLimitResetEpoch("Your limit will reset at 3pm (America/Santiago)");
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(REF_MS / 1000);
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "Your limit will reset at 7pm (Asia/Tokyo)"', () => {
    const result = parseUsageLimitResetEpoch("Your limit will reset at 7pm (Asia/Tokyo)");
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(REF_MS / 1000);
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(10);
    expect(d.getUTCDate()).toBe(13); 
  });

  test('parses "Your limit will reset at Oct 6, 1pm"', () => {
    const result = parseUsageLimitResetEpoch("Your limit will reset at Oct 6, 1pm");
    expect(typeof result).toBe('number');
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCMonth()).toBe(9); 
    expect(d.getUTCDate()).toBe(6);
    expect(d.getUTCHours()).toBe(13);
  });

  test('parses "reset at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("reset at 7pm");
    expect(typeof result).toBe('number');
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "resets at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("resets at 7pm");
    expect(typeof result).toBe('number');
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCHours()).toBe(19);
  });

  test('parses "will reset at 7pm" (UTC assumed)', () => {
    const result = parseUsageLimitResetEpoch("will reset at 7pm");
    expect(typeof result).toBe('number');
    const d = new Date(((result as number) - BUFFER) * 1000);
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
    expect(result).toBe(1749742200 + 5);
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
  });

  test('parses Codex "try again at Jun 21st, 2026 12:05 AM." message', () => {
    const codexMsg =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
      "visit https://chatgpt.com/codex/settings/usage to purchase more credits or " +
      "try again at Jun 21st, 2026 12:05 AM.";
    const expectedReset = Math.floor(Date.UTC(2026, 5, 21, 0, 5, 0) / 1000);
    const result = parseUsageLimitResetEpoch(codexMsg);
    expect(result).toBe(expectedReset + BUFFER);
    // URL in parentheses must not be mistaken for a timezone (falls back to UTC).
    const d = new Date(((result as number) - BUFFER) * 1000);
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(5);
    expect(d.getUTCDate()).toBe(21);
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(5);
  });

  test('honours explicit cross-year date "try again at Jan 2nd, 2027 9:00 PM"', () => {
    const result = parseUsageLimitResetEpoch(
      "You've hit your usage limit. ... try again at Jan 2nd, 2027 9:00 PM."
    );
    const expectedReset = Math.floor(Date.UTC(2027, 0, 2, 21, 0, 0) / 1000);
    expect(result).toBe(expectedReset + BUFFER);
  });
});
