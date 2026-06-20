import crypto from 'node:crypto';

/**
 * Constant-time string equality for secrets / signatures (SOT-935).
 *
 * Plain `a === b` short-circuits on the first differing byte, leaking timing
 * information that can be used to recover an HMAC/signature byte-by-byte. This
 * helper compares in constant time via `crypto.timingSafeEqual`.
 *
 * Both inputs must be strings of equal byte length to be considered equal.
 * Non-string inputs or any length mismatch return `false` without throwing
 * (`crypto.timingSafeEqual` throws on differing buffer lengths). The length
 * check is itself non-secret (signature lengths are fixed for a given scheme),
 * so an early length-based `false` does not leak useful timing information.
 */
export function timingSafeEqualStr(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}
