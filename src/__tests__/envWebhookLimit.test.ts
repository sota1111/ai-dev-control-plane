import { webhookJsonLimit } from '../config/env.js';

describe('webhookJsonLimit', () => {
  test('defaults to 5mb', () => {
    expect(webhookJsonLimit({})).toBe('5mb');
  });

  test('accepts supported byte-size values and normalizes case', () => {
    expect(webhookJsonLimit({ WEBHOOK_JSON_LIMIT: ' 2MB ' })).toBe('2mb');
    expect(webhookJsonLimit({ WEBHOOK_JSON_LIMIT: '512kb' })).toBe('512kb');
  });

  test('falls back for invalid or unbounded values', () => {
    expect(webhookJsonLimit({ WEBHOOK_JSON_LIMIT: 'infinity' })).toBe('5mb');
    expect(webhookJsonLimit({ WEBHOOK_JSON_LIMIT: '-1mb' })).toBe('5mb');
  });
});
