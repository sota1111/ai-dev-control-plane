import {
  evaluateBreaker,
  normalizeConfig,
  elapsedMinutes,
  DEFAULT_CONFIG,
  type BreakerConfig,
  type BreakerState,
} from '../lib/circuitBreaker.js';

// SOT-1560 — circuit-breaker / stop-condition pure logic.

const NOW = 1_000_000_000_000; // fixed epoch ms for deterministic tests

function state(overrides: Partial<BreakerState> = {}): BreakerState {
  return { nowMs: NOW, ...overrides };
}

describe('normalizeConfig', () => {
  test('fills missing knobs with disabled defaults (all 0)', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({})).toEqual({
      max_runtime_min: 0,
      max_consecutive_failures: 0,
      issue_token_budget: 0,
      no_progress: 0,
    });
  });

  test('coerces negatives / NaN / non-numbers to 0 (disabled)', () => {
    const cfg = normalizeConfig({
      max_runtime_min: -5,
      max_consecutive_failures: Number.NaN,
      issue_token_budget: 'x' as unknown as number,
      no_progress: 2.9,
    });
    expect(cfg.max_runtime_min).toBe(0);
    expect(cfg.max_consecutive_failures).toBe(0);
    expect(cfg.issue_token_budget).toBe(0);
    expect(cfg.no_progress).toBe(2); // floored
  });
});

describe('elapsedMinutes', () => {
  test('computes whole minutes elapsed', () => {
    expect(elapsedMinutes(NOW - 90 * 60000, NOW)).toBe(90);
    expect(elapsedMinutes(NOW - 59_000, NOW)).toBe(0);
  });
  test('unknown start ⇒ null', () => {
    expect(elapsedMinutes(null, NOW)).toBeNull();
    expect(elapsedMinutes(undefined, NOW)).toBeNull();
  });
  test('negative (clock skew) ⇒ 0', () => {
    expect(elapsedMinutes(NOW + 5000, NOW)).toBe(0);
  });
});

describe('evaluateBreaker — default (all disabled) is a strict no-op', () => {
  test('never trips even with large observed values', () => {
    const d = evaluateBreaker(
      state({ startedAtMs: 0, consecutiveFailures: 999, tokensUsed: 9e9, noProgressCycles: 99 }),
      {},
    );
    expect(d.tripped).toBe(false);
    expect(d.breaker).toBeNull();
  });
});

describe('evaluateBreaker — max_runtime_min', () => {
  const cfg: Partial<BreakerConfig> = { max_runtime_min: 90 };
  test('under cap → not tripped', () => {
    expect(evaluateBreaker(state({ startedAtMs: NOW - 10 * 60000 }), cfg).tripped).toBe(false);
  });
  test('over cap → tripped', () => {
    const d = evaluateBreaker(state({ startedAtMs: NOW - 91 * 60000 }), cfg);
    expect(d.tripped).toBe(true);
    expect(d.breaker).toBe('max_runtime_min');
  });
  test('fail-safe: enabled but start unknown → tripped', () => {
    const d = evaluateBreaker(state({ startedAtMs: null }), cfg);
    expect(d.tripped).toBe(true);
    expect(d.breaker).toBe('max_runtime_min');
    expect(d.reason).toMatch(/fail-safe/i);
  });
});

describe('evaluateBreaker — max_consecutive_failures', () => {
  const cfg: Partial<BreakerConfig> = { max_consecutive_failures: 3 };
  test('below limit → not tripped', () => {
    expect(evaluateBreaker(state({ consecutiveFailures: 2 }), cfg).tripped).toBe(false);
  });
  test('at/over limit → tripped', () => {
    const d = evaluateBreaker(state({ consecutiveFailures: 3 }), cfg);
    expect(d.tripped).toBe(true);
    expect(d.breaker).toBe('max_consecutive_failures');
  });
  test('fail-safe: enabled but count unknown → tripped', () => {
    expect(evaluateBreaker(state({ consecutiveFailures: null }), cfg).tripped).toBe(true);
  });
});

describe('evaluateBreaker — issue_token_budget', () => {
  const cfg: Partial<BreakerConfig> = { issue_token_budget: 100000 };
  test('under budget → not tripped', () => {
    expect(evaluateBreaker(state({ tokensUsed: 50000 }), cfg).tripped).toBe(false);
  });
  test('at/over budget → tripped', () => {
    const d = evaluateBreaker(state({ tokensUsed: 100000 }), cfg);
    expect(d.tripped).toBe(true);
    expect(d.breaker).toBe('issue_token_budget');
  });
  test('fail-safe: enabled but usage unknown → tripped', () => {
    expect(evaluateBreaker(state({ tokensUsed: null }), cfg).tripped).toBe(true);
  });
});

describe('evaluateBreaker — no_progress', () => {
  const cfg: Partial<BreakerConfig> = { no_progress: 2 };
  test('below limit → not tripped', () => {
    expect(evaluateBreaker(state({ noProgressCycles: 1 }), cfg).tripped).toBe(false);
  });
  test('at/over limit → tripped', () => {
    const d = evaluateBreaker(state({ noProgressCycles: 2 }), cfg);
    expect(d.tripped).toBe(true);
    expect(d.breaker).toBe('no_progress');
  });
  test('fail-safe: enabled but progress unknown → tripped', () => {
    expect(evaluateBreaker(state({ noProgressCycles: null }), cfg).tripped).toBe(true);
  });
});

describe('evaluateBreaker — priority order', () => {
  test('runtime is reported before consecutive-failures when both would trip', () => {
    const d = evaluateBreaker(
      state({ startedAtMs: NOW - 200 * 60000, consecutiveFailures: 99 }),
      { max_runtime_min: 90, max_consecutive_failures: 3 },
    );
    expect(d.breaker).toBe('max_runtime_min');
  });
});
