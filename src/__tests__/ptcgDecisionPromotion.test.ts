import {
  choosePolicyAction,
  evaluatePromotion,
  type DecisionOption,
  type DecisionScene,
  type PromotionInput,
} from '../lib/ptcgDecisionPromotion.js';

const input: PromotionInput = {
  version: 'sot-1745-candidate-v1',
  artifact: 'matsu-policy-sot-1745-v1',
  deckId: 'champion-54811671',
  tactic: 'matsu-mcts-decision-v1',
  paired: {
    candidateId: 'matsu-decision-v1',
    agent: { tactic: 'matsu-mcts-decision-v1', deckId: 'champion-54811671' },
    pairs: 40,
    games: 80,
    candidateWins: 51,
    baselineWins: 29,
    draws: 0,
    winRateDifference: 0.275,
    confidence95: { low: 0.08, high: 0.47 },
    faults: { candidate: 0, baseline: 0 },
    timeouts: { candidate: 0, baseline: 0 },
  },
  decisions: [
    {
      scene: 'opening-board',
      matchup: 'alakazam',
      traceRef: 'replay-54811671/alakazam/opening-03',
      failure: 'benched a second multi-prize attacker before the draw engine was stable',
      expectedAction: 'establish a draw pivot before exposing another multi-prize target',
      policyChange: 'penalize early multi-prize bench exposure without a draw pivot',
      regressionPassed: true,
    },
    {
      scene: 'evolution-window',
      matchup: 'mega-lucario',
      traceRef: 'replay-54811671/mega-lucario/evolution-02',
      failure: 'spent the evolution resource before the attacker could act safely',
      expectedAction: 'retain the evolution until an attack or protected pivot is available',
      policyChange: 'reward actionable evolution and penalize stranded evolution',
      regressionPassed: true,
    },
    {
      scene: 'prize-trade',
      matchup: 'mega-lucario',
      traceRef: 'replay-54811671/mega-lucario/prize-04',
      failure: 'accepted a two-for-three prize exchange while a single-prize line existed',
      expectedAction: 'prefer the favorable single-prize line unless immediate lethal exists',
      policyChange: 'include the next-reply prize liability in target scoring',
      regressionPassed: true,
    },
    {
      scene: 'disruption-recovery',
      matchup: 'alakazam',
      traceRef: 'replay-54811671/alakazam/recovery-05',
      failure: 'used the last search resource before restoring an attacker',
      expectedAction: 'restore draw/search continuity before optional board development',
      policyChange: 'reserve one recovery route after hand disruption',
      regressionPassed: true,
    },
  ],
  matchupDeltas: [
    { matchup: 'alakazam', winRateDifference: 0.2 },
    { matchup: 'mega-lucario', winRateDifference: 0.1 },
  ],
  baselineRuntimeMs: 800,
  candidateRuntimeMs: 820,
};

describe('Matsu decision candidate promotion gate', () => {
  it.each<[DecisionScene, DecisionOption[], string]>([
    [
      'opening-board',
      [
        { id: 'expose-attacker', baseScore: 10, exposesMultiPrize: true },
        { id: 'draw-pivot', baseScore: 9, establishesDrawPivot: true },
      ],
      'draw-pivot',
    ],
    [
      'evolution-window',
      [
        { id: 'stranded-evolution', baseScore: 10, strandedEvolution: true },
        { id: 'actionable-evolution', baseScore: 9, actionableEvolution: true },
      ],
      'actionable-evolution',
    ],
    [
      'prize-trade',
      [
        { id: 'two-for-three', baseScore: 10, replyPrizeLiability: 3 },
        { id: 'single-prize-line', baseScore: 9, replyPrizeLiability: 1 },
      ],
      'single-prize-line',
    ],
    [
      'disruption-recovery',
      [
        { id: 'optional-bench', baseScore: 10, optionalDevelopment: true },
        { id: 'restore-search', baseScore: 9, restoresContinuity: true },
      ],
      'restore-search',
    ],
  ])('changes the champion choice for replay scene %s', (scene, options, expected) => {
    expect(choosePolicyAction(scene, options)).toBe(expected);
  });

  it('promotes only a versioned candidate with four passing scenes and significant paired evidence', () => {
    const verdict = evaluatePromotion(input);
    expect(verdict).toMatchObject({
      schemaVersion: 'matsu-decision-policy/v1',
      version: 'sot-1745-candidate-v1',
      promoted: true,
      submissionEligible: true,
      reasons: [],
    });
    expect(new Set(verdict.decisions.map((row) => row.scene)).size).toBe(4);
  });

  it.each([
    [
      'non-significant CI',
      { paired: { ...input.paired, confidence95: { low: -0.02, high: 0.3 } } },
    ],
    ['matchup regression', { matchupDeltas: [{ matchup: 'alakazam', winRateDifference: -0.01 }] }],
    ['fault increase', { paired: { ...input.paired, faults: { candidate: 1, baseline: 0 } } }],
    ['timeout increase', { paired: { ...input.paired, timeouts: { candidate: 1, baseline: 0 } } }],
    ['runtime regression', { candidateRuntimeMs: 900 }],
  ])('rejects %s and never marks it submission eligible', (_name, patch) => {
    const verdict = evaluatePromotion({ ...input, ...patch } as PromotionInput);
    expect(verdict.promoted).toBe(false);
    expect(verdict.submissionEligible).toBe(false);
    expect(verdict.reasons.length).toBeGreaterThan(0);
  });

  it('requires regression evidence for every specified decision scene', () => {
    const verdict = evaluatePromotion({ ...input, decisions: input.decisions.slice(0, 3) });
    expect(verdict.reasons).toContain('missing replay evidence: disruption-recovery');
    expect(verdict.submissionEligible).toBe(false);
  });
});
