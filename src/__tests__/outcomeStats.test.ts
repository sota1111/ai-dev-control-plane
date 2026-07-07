import { parseOutcomeLines, summarizeOutcomes, formatOutcomeSummary, promotionCandidates } from '../lib/outcomeStats.js';

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

  test('COMPLETED_NO_PR counts toward successRate, not the unverified bucket (SOT-1550)', () => {
    const log = [
      '[2026-07-01 00:00:00] [OUTCOME] issue=SOT-1 trigger=webhook outcome=TASK_COMPLETED code=0 run outcome TASK_COMPLETED',
      '[2026-07-01 00:10:00] [OUTCOME] issue=SOT-2 trigger=webhook outcome=COMPLETED_NO_PR code=0 run outcome COMPLETED_NO_PR',
      '[2026-07-01 00:20:00] [OUTCOME] issue=SOT-3 trigger=webhook outcome=COMPLETION_UNVERIFIED code=0 run outcome COMPLETION_UNVERIFIED',
      '[2026-07-01 00:30:00] [OUTCOME] issue=SOT-4 trigger=webhook outcome=FAILED code=2 run outcome FAILED',
    ].join('\n');
    const summary = summarizeOutcomes(parseOutcomeLines(log));
    expect(summary.total).toBe(4);
    expect(summary.byOutcome).toEqual({ TASK_COMPLETED: 1, COMPLETED_NO_PR: 1, COMPLETION_UNVERIFIED: 1, FAILED: 1 });
    // TASK_COMPLETED + COMPLETED_NO_PR = 2/4; UNVERIFIED is neither success nor failure.
    expect(summary.successRate).toBe(0.5);
    expect(summary.failureRate).toBe(0.25);
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

  // SOT-1575 — failure-pattern promotion candidates (N-threshold over same-kind failures).
  describe('promotionCandidates', () => {
    // 3× exit code 75, 2× exit code 2, plus non-FAILED noise that must be ignored.
    const failLog = [
      '[2026-07-01 00:00:00] [OUTCOME] issue=SOT-1 trigger=webhook outcome=FAILED code=75 run outcome FAILED',
      '[2026-07-01 00:10:00] [OUTCOME] issue=SOT-1 trigger=webhook outcome=FAILED code=75 run outcome FAILED',
      '[2026-07-01 00:20:00] [OUTCOME] issue=SOT-2 trigger=queue outcome=FAILED code=75 run outcome FAILED',
      '[2026-07-01 00:30:00] [OUTCOME] issue=SOT-3 trigger=webhook outcome=FAILED code=2 run outcome FAILED',
      '[2026-07-01 00:40:00] [OUTCOME] issue=SOT-4 trigger=webhook outcome=FAILED code=2 run outcome FAILED',
      '[2026-07-01 00:50:00] [OUTCOME] issue=SOT-5 trigger=webhook outcome=TASK_COMPLETED code=0 run outcome TASK_COMPLETED',
    ].join('\n');
    const records = parseOutcomeLines(failLog);

    test('returns only kinds at/above the threshold, most frequent first', () => {
      const candidates = promotionCandidates(records, { threshold: 3 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toEqual({ kind: '75', count: 3, issues: ['SOT-1', 'SOT-2'] });
    });

    test('N-1 occurrences is NOT a candidate; N is (boundary)', () => {
      // code=2 occurs twice: threshold 3 → excluded, threshold 2 → included.
      expect(promotionCandidates(records, { threshold: 3 }).map((c) => c.kind)).toEqual(['75']);
      const at2 = promotionCandidates(records, { threshold: 2 });
      expect(at2.map((c) => c.kind)).toEqual(['75', '2']); // 3 before 2 (count desc)
      expect(at2.find((c) => c.kind === '2')).toEqual({ kind: '2', count: 2, issues: ['SOT-3', 'SOT-4'] });
    });

    test('default threshold is 3 and non-FAILED outcomes are ignored', () => {
      const candidates = promotionCandidates(records);
      expect(candidates.map((c) => c.kind)).toEqual(['75']);
    });

    test('failureOutcomes can widen the failure set', () => {
      const log = [
        '[2026-07-01 00:00:00] [OUTCOME] issue=SOT-1 outcome=NON_RETRYABLE_LIMIT code=1 run',
        '[2026-07-01 00:10:00] [OUTCOME] issue=SOT-2 outcome=NON_RETRYABLE_LIMIT code=1 run',
      ].join('\n');
      const recs = parseOutcomeLines(log);
      expect(promotionCandidates(recs, { threshold: 2 })).toHaveLength(0); // only FAILED by default
      const widened = promotionCandidates(recs, { threshold: 2, failureOutcomes: ['FAILED', 'NON_RETRYABLE_LIMIT'] });
      expect(widened).toEqual([{ kind: '1', count: 2, issues: ['SOT-1', 'SOT-2'] }]);
    });

    test('empty input yields no candidates', () => {
      expect(promotionCandidates([], { threshold: 1 })).toEqual([]);
    });
  });
});
