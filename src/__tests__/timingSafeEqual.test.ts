import { timingSafeEqualStr } from '../lib/timingSafeEqual.js';

describe('timingSafeEqualStr (SOT-935)', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqualStr('abc123', 'abc123')).toBe(true);
  });

  it('returns true for identical hex HMAC digests', () => {
    const hex = 'a'.repeat(64);
    expect(timingSafeEqualStr(hex, hex)).toBe(true);
  });

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqualStr('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different length without throwing', () => {
    expect(() => timingSafeEqualStr('short', 'a-much-longer-value')).not.toThrow();
    expect(timingSafeEqualStr('short', 'a-much-longer-value')).toBe(false);
  });

  it('returns false when either argument is empty (length mismatch)', () => {
    expect(timingSafeEqualStr('', 'nonempty')).toBe(false);
    expect(timingSafeEqualStr('nonempty', '')).toBe(false);
  });

  it('returns true for two empty strings', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
  });

  it('returns false for non-string inputs', () => {
    expect(timingSafeEqualStr(undefined as unknown as string, 'x')).toBe(false);
    expect(timingSafeEqualStr('x', null as unknown as string)).toBe(false);
    expect(timingSafeEqualStr(['arr'] as unknown as string, 'arr')).toBe(false);
    expect(timingSafeEqualStr(123 as unknown as string, 123 as unknown as string)).toBe(false);
  });
});
