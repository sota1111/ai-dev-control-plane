import { classifyUsageLimit, isWorkerOnlyUsageLimit } from '../lib/usageLimitParser.js';

describe('isWorkerOnlyUsageLimit (SOT-1587 codex/claude cooldown separation)', () => {
  const CODEX_LIMIT = "ERROR: You've hit your usage limit. try again at Jul 8th, 2026 5:42 AM.\nCODEX_USAGE_LIMIT: cooldown set until epoch 1783437029, delegating to Claude";

  it('true when only codex hit the limit (marker present, no Claude marker)', () => {
    expect(isWorkerOnlyUsageLimit(CODEX_LIMIT)).toBe(true);
  });

  it('true for a codex cooldown-active handoff (CODEX_COOLDOWN_ACTIVE)', () => {
    expect(isWorkerOnlyUsageLimit('CODEX_COOLDOWN_ACTIVE: codex usage limit until epoch 123, delegating to Claude')).toBe(true);
  });

  it('true when only antigravity hit the limit', () => {
    expect(isWorkerOnlyUsageLimit('ANTIGRAVITY_USAGE_LIMIT: cooldown set until epoch 123, delegating to Claude')).toBe(true);
  });

  it('false when Claude also hit a usage limit (global cooldown must still apply)', () => {
    expect(isWorkerOnlyUsageLimit(CODEX_LIMIT + '\nCLAUDE_USAGE_LIMIT: cooldown set until epoch 123, delegating')).toBe(false);
  });

  it('false when Claude is the one limited (CLAUDE_COOLDOWN_ACTIVE)', () => {
    expect(isWorkerOnlyUsageLimit('CLAUDE_COOLDOWN_ACTIVE: claude usage limit until epoch 123, delegating')).toBe(false);
  });

  it('false when no worker marker is present (bare usage-limit text stays global — backward compatible)', () => {
    expect(isWorkerOnlyUsageLimit("You've hit your usage limit. try again at Jul 8th, 2026 5:42 AM.")).toBe(false);
  });

  it('false for empty output', () => {
    expect(isWorkerOnlyUsageLimit('')).toBe(false);
  });
});

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

  it('classifies the Codex "try again at" usage-limit message as a retryable session limit', () => {
    const codexMsg =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), " +
      "visit https://chatgpt.com/codex/settings/usage to purchase more credits or " +
      "try again at Jun 21st, 2026 12:05 AM.";
    const result = classifyUsageLimit(codexMsg, NOW_MS);

    // SOT-1446: resetAt stays the true (far-future) reported reset, but retryAt is capped to at
    // most 5h out (NOW_MS + MAX_COOLDOWN_SECONDS default 18000s) so the worker is never stranded.
    expect(result).toMatchObject({
      type: 'session_limit',
      retryable: true,
      confidence: 'high',
      resetAt: '2026-06-21T00:05:00.000Z',
      retryAt: '2026-06-16T17:00:00.000Z'
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

  it('does NOT classify a bare timestamp containing "503" as model_unavailable', () => {
    // 開始時刻 12:50:34 -> "125034" は部分文字列 "503" を含む。run_auto.sh のバナー
    // ("Start: 20260619_125034" / "...run_20260619_125034.log") がこれを出力し、
    // 旧 includes('503') が HTTP 503 と誤検知して不要な1時間 cooldown を引き起こしていた。
    const text = [
      'Start: 20260619_125034',
      'Log: docs/ai/auto_logs/run_20260619_125034.log',
      'SOT-841 is already complete and in a terminal hold state. No work to do. Terminating.',
      '== Finished: 20260619_125107 (exit: 1) =='
    ].join('\n');
    const result = classifyUsageLimit(text, NOW_MS);

    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.retryAt).toBeNull();
  });

  it('does NOT classify a bare "429" inside a digit run (e.g. PID/timestamp) as api_429', () => {
    const result = classifyUsageLimit('Spawned run_auto.sh pid=1142986 at 04:29:00, exit 1', NOW_MS);
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('still classifies a real 503 with context even when other digits are present', () => {
    const result = classifyUsageLimit('pid=125034 API Error: 503 Service Unavailable', NOW_MS);
    expect(result.type).toBe('model_unavailable');
    expect(result.retryable).toBe(true);
  });

  describe('SOT-1446 cooldown cap (retry within at most 5h)', () => {
    const MAX = 18000; // default MAX_COOLDOWN_SECONDS = 5h

    it('caps a far-future session-limit retry to NOW + 5h without touching resetAt', () => {
      const result = classifyUsageLimit(
        "You've hit your usage limit. try again at Jun 21st, 2027 9:00 PM.",
        NOW_MS
      );
      const retryMs = new Date(result.retryAt!).getTime();
      expect(retryMs).toBe(NOW_MS + MAX * 1000);
      expect(retryMs).toBeGreaterThan(NOW_MS);
      // resetAt stays the true far-future reported reset — only the retry is capped.
      expect(new Date(result.resetAt!).getUTCFullYear()).toBe(2027);
    });

    it('does NOT cap a normal near-term reset (~3.5h out)', () => {
      const result = classifyUsageLimit(
        "You've hit your session limit. Your limit will reset at 3:30pm (UTC).",
        NOW_MS
      );
      // 15:40 UTC = 3h40m out < 5h → unchanged.
      expect(result.retryAt).toBe('2026-06-16T15:40:00.000Z');
    });

    it('honours a MAX_COOLDOWN_SECONDS override', () => {
      process.env.MAX_COOLDOWN_SECONDS = '3600';
      try {
        const result = classifyUsageLimit(
          "You've hit your usage limit. try again at Jun 21st, 2027 9:00 PM.",
          NOW_MS
        );
        expect(new Date(result.retryAt!).getTime()).toBe(NOW_MS + 3600 * 1000);
      } finally {
        delete process.env.MAX_COOLDOWN_SECONDS;
      }
    });
  });
});
