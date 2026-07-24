import {
  parseRegistry,
  enabledByPriority,
  finalTwoTargets,
  isScheduledHour,
  planSubmission,
  type SubmissionRegistry,
  type RecentSubmission,
} from '../lib/kaggleSubmission.js';

// SOT-1904 — Kaggle 自動提出の優先度選定ロジック。
describe('kaggleSubmission', () => {
  const rawRegistry = {
    __doc__: 'ignored',
    competition: 'pokemon-tcg-ai-battle',
    daily_submission_cap: 5,
    schedule_hours_jst: [0, 4, 8, 16, 20],
    agents: [
      { name: 'fable', priority: 1, enabled: true, submit: { file: '', message: 'm' } },
      { name: 'take', priority: 2, enabled: true },
      { name: 'matsu', priority: 3, enabled: false },
      { name: 'ume', priority: 5, enabled: false },
    ],
  };

  const reg = (): SubmissionRegistry => parseRegistry(rawRegistry);
  const recent = (...names: string[]): RecentSubmission[] => names.map((agent) => ({ agent }));

  describe('parseRegistry', () => {
    test('parses valid registry and ignores __ keys', () => {
      const r = reg();
      expect(r.competition).toBe('pokemon-tcg-ai-battle');
      expect(r.dailySubmissionCap).toBe(5);
      expect(r.scheduleHoursJst).toEqual([0, 4, 8, 16, 20]);
      expect(r.agents).toHaveLength(4);
      expect(r.agents[0]).toMatchObject({ name: 'fable', priority: 1, enabled: true });
    });

    test('defaults cap and schedule when omitted', () => {
      const r = parseRegistry({ competition: 'c', agents: [{ name: 'a', priority: 1, enabled: true }] });
      expect(r.dailySubmissionCap).toBe(5);
      expect(r.scheduleHoursJst).toEqual([0, 4, 8, 16, 20]);
    });

    test('normalizes schedule hours (dedupe + sort)', () => {
      const r = parseRegistry({ competition: 'c', schedule_hours_jst: [20, 4, 4, 0], agents: [{ name: 'a', priority: 1, enabled: true }] });
      expect(r.scheduleHoursJst).toEqual([0, 4, 20]);
    });

    test.each([
      [{ competition: '', agents: [] }, /competition/],
      [{ competition: 'c', agents: [] }, /agents/],
      [{ competition: 'c', daily_submission_cap: 0, agents: [{ name: 'a', priority: 1, enabled: true }] }, /daily_submission_cap/],
      [{ competition: 'c', schedule_hours_jst: [24], agents: [{ name: 'a', priority: 1, enabled: true }] }, /schedule_hours_jst/],
      [{ competition: 'c', agents: [{ name: 'a', priority: 0, enabled: true }] }, /priority/],
      [{ competition: 'c', agents: [{ name: 'a', priority: 1, enabled: 'yes' }] }, /enabled/],
      [{ competition: 'c', agents: [{ name: 'a', priority: 1, enabled: true }, { name: 'a', priority: 2, enabled: true }] }, /duplicated/],
    ])('rejects invalid registry %#', (bad, re) => {
      expect(() => parseRegistry(bad)).toThrow(re as RegExp);
    });
  });

  describe('enabledByPriority / finalTwoTargets', () => {
    test('returns only enabled agents in priority order', () => {
      expect(enabledByPriority(reg()).map((a) => a.name)).toEqual(['fable', 'take']);
    });
    test('final-2 targets are the top-2 enabled by priority', () => {
      expect(finalTwoTargets(reg())).toEqual(['fable', 'take']);
    });
  });

  describe('isScheduledHour', () => {
    test('matches configured JST slots', () => {
      const r = reg();
      expect(isScheduledHour(r, 0)).toBe(true);
      expect(isScheduledHour(r, 16)).toBe(true);
      expect(isScheduledHour(r, 3)).toBe(false);
    });
  });

  describe('planSubmission', () => {
    test('skips when the daily cap is reached', () => {
      const p = planSubmission({ registry: reg(), recent: recent('take', 'fable'), submittedToday: 5 });
      expect(p.selected).toBeNull();
      expect(p.remainingToday).toBe(0);
      expect(p.reason).toMatch(/cap reached/);
    });

    test('steady state alternates the top-2 to keep them as the last-2', () => {
      // last-2 already = {fable, take}, most-recent = take → pick fable (not most-recent).
      const p1 = planSubmission({ registry: reg(), recent: recent('take', 'fable'), submittedToday: 1 });
      expect(p1.selected).toBe('fable');
      // most-recent = fable → pick take.
      const p2 = planSubmission({ registry: reg(), recent: recent('fable', 'take'), submittedToday: 1 });
      expect(p2.selected).toBe('take');
    });

    test('restores a target agent pushed out by a measurement submission', () => {
      // A measurement (zero) is most-recent; last-2 = {zero, fable}; take is missing → submit take.
      const p = planSubmission({ registry: reg(), recent: recent('zero', 'fable'), submittedToday: 1 });
      expect(p.selected).toBe('take');
      expect(p.currentLastTwo).toEqual(['zero', 'fable']);
      expect(p.reason).toMatch(/restore\/maintain final-2/);
    });

    test('converges to the target set within two submissions when both slots are measurements', () => {
      const r = reg();
      // last-2 = {zero, ume} (both non-target). Highest-priority missing target = fable.
      const p1 = planSubmission({ registry: r, recent: recent('zero', 'ume'), submittedToday: 1 });
      expect(p1.selected).toBe('fable');
      // After submitting fable → last-2 = {fable, zero}; take still missing → submit take.
      const p2 = planSubmission({ registry: r, recent: recent('fable', 'zero'), submittedToday: 2 });
      expect(p2.selected).toBe('take');
      // Now last-2 = {take, fable} == target set.
      expect(new Set(['take', 'fable'])).toEqual(new Set(finalTwoTargets(r)));
    });

    test('never selects a disabled agent', () => {
      // Even if matsu/ume dominate recent slots, only enabled fable/take are ever chosen.
      const p = planSubmission({ registry: reg(), recent: recent('matsu', 'ume'), submittedToday: 0 });
      expect(['fable', 'take']).toContain(p.selected);
    });

    test('picks the highest-priority enabled agent on an empty history', () => {
      const p = planSubmission({ registry: reg(), recent: [], submittedToday: 0 });
      expect(p.selected).toBe('fable');
      expect(p.remainingToday).toBe(5);
    });

    test('returns null when no agents are enabled', () => {
      const r = parseRegistry({ competition: 'c', agents: [{ name: 'a', priority: 1, enabled: false }] });
      const p = planSubmission({ registry: r, recent: [], submittedToday: 0 });
      expect(p.selected).toBeNull();
      expect(p.reason).toMatch(/no enabled agents/);
    });
  });
});
