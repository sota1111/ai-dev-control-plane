import { parseOutcomeLines, summarizeOutcomes, formatOutcomeSummary } from '../lib/outcomeStats.js';

// SOT-1439 / P5 — structured outcome parsing + aggregation.
describe('outcomeStats', () => {
  const sampleLog = [
    '[2026-07-01 00:00:00] [RUN] issue=SOT-1 start',
    '[2026-07-01 00:05:00] [OUTCOME] issue=SOT-1 trigger=webhook outcome=TASK_COMPLETED code=0 run outcome TASK_COMPLETED',
    '[2026-07-01 01:00:00] [OUTCOME] issue=SOT-2 trigger=queue outcome=USAGE_LIMIT_RETRY code=1 run outcome USAGE_LIMIT_RETRY',
    'some noise line without a tag',
    '[2026-07-01 02:00:00] [OUTCOME] issue=SOT-3 trigger=webhook outcome=FAILED code=2 run outcome FAILED',
    '[2026-07-01 03:00:00] [OUTCOME] issue=SOT-4 trigger=webhook outcome=TASK_COMPLETED code=0 run outcome TASK_COMPLETED',
  ].join('\n');

  test('parseOutcomeLines extracts only [OUTCOME] lines with fields', () => {
    const records = parseOutcomeLines(sampleLog);
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({ issue: 'SOT-1', trigger: 'webhook', outcome: 'TASK_COMPLETED', code: 0 });
    expect(records[1]).toMatchObject({ issue: 'SOT-2', outcome: 'USAGE_LIMIT_RETRY', code: 1 });
    expect(records[0].epochMs).toBe(Date.parse('2026-07-01 00:05:00Z'));
  });

  test('summarizeOutcomes computes counts and rates', () => {
    const summary = summarizeOutcomes(parseOutcomeLines(sampleLog));
    expect(summary.total).toBe(4);
    expect(summary.byOutcome).toEqual({ TASK_COMPLETED: 2, USAGE_LIMIT_RETRY: 1, FAILED: 1 });
    expect(summary.successRate).toBe(0.5);
    expect(summary.usageLimitRate).toBe(0.25);
    expect(summary.failureRate).toBe(0.25);
  });

  test('summarizeOutcomes respects sinceMs window', () => {
    const records = parseOutcomeLines(sampleLog);
    // Keep only outcomes at/after 01:30 → drops the two before it, keeps SOT-3 (FAILED) and SOT-4 (TASK_COMPLETED).
    const summary = summarizeOutcomes(records, { sinceMs: Date.parse('2026-07-01 01:30:00Z') });
    expect(summary.total).toBe(2);
    expect(summary.byOutcome).toEqual({ FAILED: 1, TASK_COMPLETED: 1 });
    expect(summary.successRate).toBe(0.5);
  });

  test('empty input yields a zeroed summary and readable format', () => {
    const summary = summarizeOutcomes([]);
    expect(summary.total).toBe(0);
    expect(summary.successRate).toBe(0);
    expect(formatOutcomeSummary(summary)).toContain('なし');
  });

  test('formatOutcomeSummary lists counts sorted desc', () => {
    const summary = summarizeOutcomes(parseOutcomeLines(sampleLog));
    const s = formatOutcomeSummary(summary);
    expect(s).toContain('4件');
    expect(s).toContain('TASK_COMPLETED=2');
    expect(s).toContain('成功 50%');
  });
});
