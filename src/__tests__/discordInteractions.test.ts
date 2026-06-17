'use strict';

const { verifyDiscordSignature } = require('../lib/discordInteractions');

describe('verifyDiscordSignature', () => {
  test('returns false for invalid signature format', () => {
    const result = verifyDiscordSignature(
      'a'.repeat(64),
      'b'.repeat(128),
      '1234567890',
      'test body'
    );
    expect(result).toBe(false);
  });

  test('returns false for missing/empty inputs', () => {
    expect(verifyDiscordSignature('', '', '', '')).toBe(false);
    expect(verifyDiscordSignature(null, null, null, null)).toBe(false);
  });
});
