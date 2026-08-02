/**
 * Adaptive compute allocation across Kaggle competitions (design/README.md §50 資源配分).
 *
 * The scarce resource is Claude's account-global usage limit: the 4 Claude-lineage repos share ONE
 * cooldown, so spreading compute evenly across saturated and improving competitions just burns the
 * shared limit on low-value work. Instead of the static round-robin rotation (1 cron slot →
 * 1 fixed competition), a dynamic selector picks, for each slot, the improve-mode competition with
 * the highest expected rank gain, computed deterministically from history files already on disk
 * (leaderboard-rank.jsonl, score-progression plateau, experiment_ledger) — NO Kaggle CLI / LLM calls,
 * so all competitions can be priced cheaply and only the winner is then collected + drafted.
 *
 * Pure functions only (I/O lives in the caller). Backward compatible: a registry without an
 * `allocation` block stays on the static rotation.
 */

export type TargetMode = 'improve' | 'maintain';
export type CompetitionPhase = 'explore' | 'converge' | 'closed';

export interface PriorityWeights {
  /** Recently promoted / score rose — strongest positive signal (momentum). */
  momentum: number;
  /** Room left before saturation (inverse of consecutive non-improving streak). */
  headroom: number;
  /** How good / defensible the current standing is (rank gain potential). */
  rankGain: number;
  /** Deadline pressure — converge phase should be finished, not abandoned. */
  deadline: number;
}

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  momentum: 0.35,
  headroom: 0.3,
  rankGain: 0.2,
  deadline: 0.15,
};

export interface TargetPrioritySignals {
  mode: TargetMode;
  phase: CompetitionPhase;
  /** Latest experiment-ledger result is promoted, or the latest score rose. */
  recentlyPromoted: boolean;
  /** Consecutive non-improving submissions with the same approach (detectScorePlateau). */
  consecutiveNonImproving: number;
  /** Plateau threshold used for the streak (default 3). */
  plateauThreshold: number;
  /** 1-based public leaderboard rank; null when below the listed top-N (圏外). */
  rank: number | null;
  /** Number of leaderboard rows the rank was computed against. */
  totalListed: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Expected-rank-gain priority in [0,1]. A maintain-mode or closed-competition target is always 0
 * (the floor gate): it must never win a slot. Otherwise a normalized weighted sum of the signals.
 */
export function computeTargetPriority(
  sig: TargetPrioritySignals,
  weights: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS
): number {
  if (sig.mode === 'maintain' || sig.phase === 'closed') return 0;

  const momentum = sig.recentlyPromoted ? 1 : 0;
  const threshold = sig.plateauThreshold > 0 ? sig.plateauThreshold : 3;
  const headroom = clamp01(1 - sig.consecutiveNonImproving / threshold);
  // Rank gain: a listed rank near the top is a valuable, defensible position; 圏外 (rank=null) still
  // has upside but from a worse position, so it gets a moderate floor.
  const rankGain =
    sig.rank === null
      ? 0.4
      : clamp01(1 - (sig.rank - 1) / Math.max(sig.totalListed, 1));
  const deadline = sig.phase === 'converge' ? 1 : 0.3;

  const w = weights;
  const wsum = w.momentum + w.headroom + w.rankGain + w.deadline;
  if (wsum <= 0) return 0;
  return clamp01(
    (w.momentum * momentum + w.headroom * headroom + w.rankGain * rankGain + w.deadline * deadline) /
      wsum
  );
}

export interface CompetitionCandidate {
  key: string;
  /** Highest target priority in the competition (a slot drafts the whole competition). */
  priority: number;
  /** At least one target is improve-mode, not closed, and has no open cycle. */
  eligible: boolean;
}

/**
 * Pick the competition for a cron slot: the eligible one with the highest priority. Ties break by the
 * registry order of `candidates` (deterministic — cron must not depend on Date/random). Returns null
 * when nothing is eligible (every competition saturated / closed / already has an open cycle) so the
 * caller drafts nothing this slot.
 */
export function selectDynamicCompetition(candidates: CompetitionCandidate[]): string | null {
  let best: CompetitionCandidate | null = null;
  for (const c of candidates) {
    if (!c.eligible) continue;
    if (best === null || c.priority > best.priority) best = c;
  }
  return best ? best.key : null;
}

/**
 * Auto-maintain (design §49): a lineage that has gone `threshold` consecutive cycles without a
 * promotion AND is not currently on a promotion is presumed to have walked the escalation ladder to
 * exhaustion. The caller flips its registry `mode` to `maintain` so future slots reallocate to other
 * competitions (submissions continue). threshold<=0 disables the automation.
 */
export function shouldAutoMaintain(
  consecutiveNonImproving: number,
  recentlyPromoted: boolean,
  threshold: number
): boolean {
  if (threshold <= 0) return false;
  if (recentlyPromoted) return false;
  return consecutiveNonImproving >= threshold;
}

export interface AllocationConfig {
  /** `dynamic` = priority-driven slot selection; `static` (default) = legacy rotation. */
  mode: 'dynamic' | 'static';
  /** Consecutive non-improving cycles that auto-flip a lineage to maintain (0 disables). */
  autoMaintainThreshold: number;
  weights: PriorityWeights;
}

export const DEFAULT_ALLOCATION_CONFIG: AllocationConfig = {
  mode: 'static',
  autoMaintainThreshold: 0,
  weights: DEFAULT_PRIORITY_WEIGHTS,
};

/** Parse the optional registry `allocation` block. Missing → static/legacy (fully backward compatible). */
export function parseAllocationConfig(raw: unknown): AllocationConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ALLOCATION_CONFIG };
  const o = raw as Record<string, unknown>;
  const mode = o.mode === 'dynamic' ? 'dynamic' : 'static';
  const thrRaw = o.auto_maintain_threshold ?? o.autoMaintainThreshold ?? 0;
  const autoMaintainThreshold =
    typeof thrRaw === 'number' && Number.isFinite(thrRaw) && thrRaw >= 0 ? Math.floor(thrRaw) : 0;
  const wRaw = (o.weights ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d;
  const weights: PriorityWeights = {
    momentum: num(wRaw.momentum, DEFAULT_PRIORITY_WEIGHTS.momentum),
    headroom: num(wRaw.headroom, DEFAULT_PRIORITY_WEIGHTS.headroom),
    rankGain: num(wRaw.rank_gain ?? wRaw.rankGain, DEFAULT_PRIORITY_WEIGHTS.rankGain),
    deadline: num(wRaw.deadline, DEFAULT_PRIORITY_WEIGHTS.deadline),
  };
  return { mode, autoMaintainThreshold, weights };
}
