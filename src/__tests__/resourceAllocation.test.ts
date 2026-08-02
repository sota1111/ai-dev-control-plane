import {
  computeTargetPriority,
  selectDynamicCompetition,
  cooldownAdjustedPriority,
  shouldAutoMaintain,
  parseAllocationConfig,
  DEFAULT_PRIORITY_WEIGHTS,
  DEFAULT_ALLOCATION_CONFIG,
  type TargetPrioritySignals,
  type CompetitionCandidate,
} from '../lib/resourceAllocation.js';

const base: TargetPrioritySignals = {
  mode: 'improve',
  phase: 'explore',
  recentlyPromoted: false,
  consecutiveNonImproving: 0,
  plateauThreshold: 3,
  rank: null,
  totalListed: 0,
};

describe('resourceAllocation — computeTargetPriority', () => {
  it('floor-gates maintain mode and closed phase to 0', () => {
    expect(computeTargetPriority({ ...base, mode: 'maintain', recentlyPromoted: true })).toBe(0);
    expect(computeTargetPriority({ ...base, phase: 'closed', recentlyPromoted: true })).toBe(0);
  });

  it('rewards momentum (recent promotion) strongly', () => {
    const withMomentum = computeTargetPriority({ ...base, recentlyPromoted: true });
    const without = computeTargetPriority({ ...base, recentlyPromoted: false });
    expect(withMomentum).toBeGreaterThan(without);
  });

  it('drops headroom to 0 as the non-improving streak reaches the threshold', () => {
    const fresh = computeTargetPriority({ ...base, consecutiveNonImproving: 0 });
    const saturated = computeTargetPriority({ ...base, consecutiveNonImproving: 3, plateauThreshold: 3 });
    expect(saturated).toBeLessThan(fresh);
    // headroom fully consumed at/above threshold
    const beyond = computeTargetPriority({ ...base, consecutiveNonImproving: 10, plateauThreshold: 3 });
    expect(beyond).toBe(saturated);
  });

  it('ranks a top-listed position above a 圏外 (null) one', () => {
    const top = computeTargetPriority({ ...base, rank: 1, totalListed: 20 });
    const offlist = computeTargetPriority({ ...base, rank: null, totalListed: 20 });
    const bottom = computeTargetPriority({ ...base, rank: 20, totalListed: 20 });
    expect(top).toBeGreaterThan(offlist);
    expect(offlist).toBeGreaterThan(bottom);
  });

  it('adds deadline pressure in the converge phase', () => {
    const converge = computeTargetPriority({ ...base, phase: 'converge' });
    const explore = computeTargetPriority({ ...base, phase: 'explore' });
    expect(converge).toBeGreaterThan(explore);
  });

  it('reflects the real fleet: improving kaggriculture > saturated ptcg', () => {
    const kaggriculture = computeTargetPriority({
      ...base, recentlyPromoted: true, consecutiveNonImproving: 0, rank: null,
    });
    const ptcgSaturated = computeTargetPriority({
      ...base, mode: 'maintain', // already flipped
    });
    const ptcgBeforeFlip = computeTargetPriority({
      ...base, recentlyPromoted: false, consecutiveNonImproving: 8, plateauThreshold: 3, rank: null,
    });
    expect(kaggriculture).toBeGreaterThan(ptcgBeforeFlip);
    expect(ptcgSaturated).toBe(0);
  });
});

describe('resourceAllocation — selectDynamicCompetition', () => {
  const c = (key: string, priority: number, eligible = true): CompetitionCandidate => ({ key, priority, eligible });

  it('picks the highest-priority eligible competition', () => {
    expect(selectDynamicCompetition([
      c('ptcg', 0.0, false),
      c('kaggriculture', 0.82),
      c('agent-security', 0.79),
      c('biohub', 0.61),
    ])).toBe('kaggriculture');
  });

  it('skips ineligible (saturated/closed/open-cycle) competitions even if higher priority', () => {
    expect(selectDynamicCompetition([
      c('ptcg', 0.9, false),
      c('biohub', 0.5, true),
    ])).toBe('biohub');
  });

  it('returns null when nothing is eligible', () => {
    expect(selectDynamicCompetition([c('ptcg', 0.9, false), c('biohub', 0.5, false)])).toBeNull();
    expect(selectDynamicCompetition([])).toBeNull();
  });

  it('breaks ties by registry order (deterministic)', () => {
    expect(selectDynamicCompetition([c('a', 0.5), c('b', 0.5), c('c', 0.5)])).toBe('a');
  });
});

describe('resourceAllocation — cooldown (anti-monopoly, §50)', () => {
  const c = (key: string, priority: number, eligible = true): CompetitionCandidate => ({ key, priority, eligible });

  it('decays a competition drafted in recent slots by cooldownFactor per appearance', () => {
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: [], cooldownFactor: 0.5, cooldownWindow: 3 })).toBe(0.8);
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: ['a'], cooldownFactor: 0.5, cooldownWindow: 3 })).toBeCloseTo(0.4);
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: ['a', 'a'], cooldownFactor: 0.5, cooldownWindow: 3 })).toBeCloseTo(0.2);
  });

  it('only counts appearances within the cooldown window', () => {
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: ['a', 'b', 'c', 'a'], cooldownFactor: 0.5, cooldownWindow: 3 })).toBeCloseTo(0.4);
  });

  it('is disabled by cooldownFactor=1 or cooldownWindow=0', () => {
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: ['a', 'a'], cooldownFactor: 1 })).toBe(0.8);
    expect(cooldownAdjustedPriority('a', 0.8, { recentlyDrafted: ['a', 'a'], cooldownWindow: 0 })).toBe(0.8);
  });

  it('breaks the monopoly: a recently-drafted high-priority competition yields to a fresh one', () => {
    // agent-security (0.78) drafted last two slots decays to 0.195; biohub (0.61) untouched wins.
    const pick = selectDynamicCompetition(
      [c('agent-security', 0.78), c('biohub', 0.61), c('ptcg', 0.42)],
      { recentlyDrafted: ['agent-security', 'agent-security'], cooldownFactor: 0.5, cooldownWindow: 3 }
    );
    expect(pick).toBe('biohub');
  });

  it('lets a high-priority competition win again once its penalty decays out of the window', () => {
    const pick = selectDynamicCompetition(
      [c('agent-security', 0.78), c('biohub', 0.61)],
      { recentlyDrafted: ['biohub', 'ptcg', 'kaggriculture'], cooldownFactor: 0.5, cooldownWindow: 3 }
    );
    expect(pick).toBe('agent-security');
  });
});

describe('resourceAllocation — shouldAutoMaintain', () => {
  it('flips after threshold consecutive non-improving cycles', () => {
    expect(shouldAutoMaintain(6, false, 6)).toBe(true);
    expect(shouldAutoMaintain(5, false, 6)).toBe(false);
  });

  it('never flips a lineage that just promoted', () => {
    expect(shouldAutoMaintain(10, true, 6)).toBe(false);
  });

  it('is disabled when threshold <= 0', () => {
    expect(shouldAutoMaintain(100, false, 0)).toBe(false);
  });
});

describe('resourceAllocation — parseAllocationConfig', () => {
  it('defaults to static/legacy when missing', () => {
    expect(parseAllocationConfig(undefined)).toEqual(DEFAULT_ALLOCATION_CONFIG);
    expect(parseAllocationConfig(null).mode).toBe('static');
  });

  it('parses dynamic mode, threshold, weights, and cooldown (snake_case)', () => {
    const cfg = parseAllocationConfig({
      mode: 'dynamic',
      auto_maintain_threshold: 6,
      weights: { momentum: 0.5, headroom: 0.2, rank_gain: 0.2, deadline: 0.1 },
      cooldown_window: 4,
      cooldown_factor: 0.4,
    });
    expect(cfg.mode).toBe('dynamic');
    expect(cfg.autoMaintainThreshold).toBe(6);
    expect(cfg.weights).toEqual({ momentum: 0.5, headroom: 0.2, rankGain: 0.2, deadline: 0.1 });
    expect(cfg.cooldownWindow).toBe(4);
    expect(cfg.cooldownFactor).toBe(0.4);
  });

  it('defaults cooldown to window=3 factor=0.5 and rejects out-of-range factor', () => {
    expect(parseAllocationConfig({ mode: 'dynamic' }).cooldownWindow).toBe(3);
    expect(parseAllocationConfig({ mode: 'dynamic' }).cooldownFactor).toBe(0.5);
    expect(parseAllocationConfig({ cooldown_factor: 2 }).cooldownFactor).toBe(0.5);
    expect(parseAllocationConfig({ cooldown_factor: 0 }).cooldownFactor).toBe(0.5);
  });

  it('falls back to default weights for missing/invalid fields', () => {
    const cfg = parseAllocationConfig({ mode: 'dynamic', weights: { momentum: -1 } });
    expect(cfg.weights.momentum).toBe(DEFAULT_PRIORITY_WEIGHTS.momentum);
    expect(cfg.weights.headroom).toBe(DEFAULT_PRIORITY_WEIGHTS.headroom);
  });

  it('treats an unknown mode as static', () => {
    expect(parseAllocationConfig({ mode: 'weird' }).mode).toBe('static');
  });
});
