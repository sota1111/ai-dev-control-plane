import {
  deriveOracleDriftSignalFromHistory,
  DEFAULT_SONNET_NET_CEILING_FLOOR,
  type GoldHistoryEntry,
} from '../lib/sonnetGoldOracleDrift.js';
import {
  detectOracleDrift,
  DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES,
  DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES,
} from '../lib/kaggleImprovement.js';

// SIGNATE rank-26 post-mortem — net(自己参照 proxy) 飽和×真KPI停滞の履歴導出。
describe('deriveOracleDriftSignalFromHistory', () => {
  const entry = (net: number, over: Partial<GoldHistoryEntry> = {}): GoldHistoryEntry => ({
    net,
    ...over,
  });

  test('undefined when fewer than 2 net observations', () => {
    expect(deriveOracleDriftSignalFromHistory([])).toBeUndefined();
    expect(deriveOracleDriftSignalFromHistory([entry(99)])).toBeUndefined();
  });

  test('undefined when proxy is not saturated (below the ceiling floor)', () => {
    // net stuck at 40 is normal headroom, NOT oracle drift.
    expect(deriveOracleDriftSignalFromHistory([entry(38), entry(40)])).toBeUndefined();
  });

  test('fires when net is pinned near the ceiling with no true KPI (SIGNATE net99 shape)', () => {
    const sig = deriveOracleDriftSignalFromHistory([entry(96), entry(98), entry(99)]);
    expect(sig).toBeDefined();
    expect(sig!.proxySaturated).toBe(true);
    expect(sig!.trueKpiStagnant).toBe(true);
    expect(sig!.stagnantCycles).toBe(3);
    // absence of a true-KPI field is treated as missing true feedback.
    expect(sig!.trueKpiName).toContain('未計測');
    // → detectOracleDrift escalates: 3 >= reanchor(2), < escalate(4) → reanchor.
    expect(detectOracleDrift(sig).level).toBe('reanchor');
  });

  test('escalate level once the near-ceiling plateau persists past the escalate threshold', () => {
    const plateau = Array.from({ length: DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES }, () => entry(97));
    const sig = deriveOracleDriftSignalFromHistory(plateau);
    expect(sig!.stagnantCycles).toBe(DEFAULT_ORACLE_DRIFT_ESCALATE_CYCLES);
    expect(detectOracleDrift(sig).level).toBe('escalate');
  });

  test('single near-ceiling cycle does not yet reanchor (needs sustained saturation)', () => {
    // last cycle high, prior below floor → stagnantCycles=1 < reanchor(2) → none.
    const sig = deriveOracleDriftSignalFromHistory([entry(80), entry(92)]);
    expect(sig!.stagnantCycles).toBe(1);
    expect(detectOracleDrift(sig).level).toBe('none');
    expect(DEFAULT_ORACLE_DRIFT_REANCHOR_CYCLES).toBe(2);
  });

  test('a moving independent true KPI clears the drift (true feedback is closing the loop)', () => {
    const sig = deriveOracleDriftSignalFromHistory([
      entry(96, { true_net: 84 }),
      entry(98, { true_net: 88 }),
      entry(99, { true_net: 91 }),
    ]);
    // proxy saturated but true KPI is rising → not drift.
    expect(sig).toBeUndefined();
  });

  test('a flat/declining true KPI still counts as stagnant → drift', () => {
    const sig = deriveOracleDriftSignalFromHistory([
      entry(96, { true_accuracy: 88.5 }),
      entry(99, { true_accuracy: 88.5 }),
    ]);
    expect(sig).toBeDefined();
    expect(sig!.trueKpiName).not.toContain('未計測'); // a true KPI exists, it just isn't moving
    expect(detectOracleDrift(sig).level).toBe('reanchor');
  });

  test('custom ceiling floor is honored', () => {
    const belowCustom = deriveOracleDriftSignalFromHistory([entry(82), entry(85)], {
      netCeilingFloor: 90,
    });
    expect(belowCustom).toBeUndefined();
    const aboveCustom = deriveOracleDriftSignalFromHistory([entry(82), entry(85)], {
      netCeilingFloor: 80,
    });
    expect(aboveCustom).toBeDefined();
    expect(DEFAULT_SONNET_NET_CEILING_FLOOR).toBe(90);
  });
});
