const { classifyUsageLimit } = require('../lib/usageLimitParser');

export {};

describe('classifyUsageLimit', () => {
  const NOW_MS = Date.UTC(2026, 5, 16, 12, 0, 0);

  beforeEach(() => {
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
    delete process.env.OVERLOAD_RETRY_BUFFER_SECONDS;
  });

  afterEach(() => {
    delete process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS;
    delete process.env.OVERLOAD_RETRY_BUFFER_SECONDS;
  });

  it('classifies session limits with reset and retry timestamps', () => {
    const result = classifyUsageLimit(
      "You've hit your session limit. Your limit will reset at 3:30pm (UTC).",
      NOW_MS
    );

    expect(result).toMatchObject({
      type: 'session_limit',
      retryable: true,
      confidence: 'high',
      resetAt: '2026-06-16T15:30:00.000Z',
      retryAt: '2026-06-16T15:40:00.000Z'
    });
  });

  it('classifies weekly limits as non-retryable', () => {
    const result = classifyUsageLimit(
      'Weekly limit reached. Your limit will reset at 3:30pm (UTC).',
      NOW_MS
    );

    expect(result.type).toBe('weekly_limit');
    expect(result.retryable).toBe(false);
    expect(result.retryAt).toBeNull();
    expect(result.confidence).toBe('high');
  });

  it('classifies auth errors as non-retryable', () => {
    const result = classifyUsageLimit('Request failed: 401 unauthorized', NOW_MS);

    expect(result).toMatchObject({
      type: 'auth_error',
      retryable: false,
      retryAt: null,
      confidence: 'high'
    });
  });

  it('classifies network errors with short retry backoff', () => {
    const result = classifyUsageLimit('Network request failed: ECONNRESET', NOW_MS);

    expect(result.type).toBe('network_error');
    expect(result.retryable).toBe(true);
    expect(result.retryAt).toBe(new Date(NOW_MS + 120000).toISOString());
    expect(result.confidence).toBe('medium');
  });

  it('classifies API 429 with retry-after header', () => {
    const result = classifyUsageLimit('HTTP 429 Too Many Requests\nretry-after: 120', NOW_MS);

    expect(result.type).toBe('api_429');
    expect(result.retryable).toBe(true);
    expect(result.retryAt).toBe(new Date(NOW_MS + 120000).toISOString());
    expect(result.confidence).toBe('high');
  });

  it('classifies unknown text as non-retryable', () => {
    const result = classifyUsageLimit('build failed because a unit test assertion failed', NOW_MS);

    expect(result).toMatchObject({
      type: 'unknown',
      retryable: false,
      resetAt: null,
      retryAt: null,
      confidence: 'low'
    });
  });

  it('does not double-buffer session limit retryAt', () => {
    const result = classifyUsageLimit(
      "You've hit your session limit. Your limit will reset at 3:30pm (UTC).",
      NOW_MS
    );
    const resetMs = new Date(result.resetAt!).getTime();
    const retryMs = new Date(result.retryAt!).getTime();

    expect((retryMs - resetMs) / 1000).toBe(600);
  });

  it('uses USAGE_LIMIT_RETRY_BUFFER_SECONDS exactly once for session limits', () => {
    process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS = '45';

    const result = classifyUsageLimit(
      "You've hit your session limit. Your limit will reset at 3:30pm (UTC).",
      NOW_MS
    );
    const resetMs = new Date(result.resetAt!).getTime();
    const retryMs = new Date(result.retryAt!).getTime();

    expect((retryMs - resetMs) / 1000).toBe(45);
  });

  it('classifies 529 Overloaded as model_unavailable and retries 1 hour later', () => {
    const result = classifyUsageLimit(
      '[RUN:SOT-673] API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      NOW_MS
    );

    expect(result).toMatchObject({
      type: 'model_unavailable',
      retryable: true,
      confidence: 'medium',
      retryAt: '2026-06-16T13:00:00.000Z'
    });
  });

  it('honors OVERLOAD_RETRY_BUFFER_SECONDS override for overloaded errors', () => {
    process.env.OVERLOAD_RETRY_BUFFER_SECONDS = '1800';

    const result = classifyUsageLimit('Model is overloaded', NOW_MS);

    expect(result.type).toBe('model_unavailable');
    expect(result.retryAt).toBe('2026-06-16T12:30:00.000Z');
  });

  it('uses overload buffer for 503 errors as well', () => {
    const result = classifyUsageLimit('503 Service Unavailable', NOW_MS);

    expect(result.type).toBe('model_unavailable');
    expect(result.retryAt).toBe('2026-06-16T13:00:00.000Z');
  });
});
