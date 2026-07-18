// SOT-1711: tests for ptcg-analyze — recompute statistics FROM RAW RECORDS and render an
// evidence-qualified report. Covers: raw-record readback (checksum-verified), per-agent/seat/pair/deck
// tallies, average turns/time, Wilson-CI-overlap ranking (順位未確定), sample-insufficiency, diff vs a
// baseline, notification line, and the on-disk analyzeRun artifact writer + redaction.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTESTANTS,
  LocalObjectStore,
  runRoundRobin,
  sha256Hex,
  type ContestantInput,
  type GameRecord,
  type Manifest,
  type RunConfig,
  type ShardRunner,
  type ShardSpec,
} from '../lib/ptcgBattleLab.js';
import {
  ANALYSIS_SCHEMA_VERSION,
  analyzeRun,
  assertReportClean,
  buildNotification,
  ciOverlaps,
  computeAnalysis,
  computeDiff,
  decideRanking,
  readRawGames,
  renderReport,
  tallyAgent,
  tallyPair,
  type Analysis,
} from '../lib/ptcgAnalyze.js';

const NOW = '2026-07-18T07:00:00.000Z';

function inputs(deckOverrides: Partial<Record<string, string>> = {}): ContestantInput[] {
  return CONTESTANTS.map((c, i) => ({
    label: c.label,
    kanji: c.kanji,
    repo: c.repo,
    commit: `commit${i}${'a'.repeat(38)}`,
    deckHash: deckOverrides[c.label] ?? sha256Hex(`deck-${c.label}`),
  }));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-analyze-'));
}

/** Runner that gives seat0 an exact win count per shard id, with turns/time populated. */
function scriptedRunner(seat0Wins: Record<string, number>, opts: { withTurns?: boolean; faultEvery?: number } = {}): ShardRunner {
  const withTurns = opts.withTurns ?? true;
  const faultEvery = opts.faultEvery ?? 0;
  return async (shard: ShardSpec) => {
    const wins = seat0Wins[shard.shardId] ?? 0;
    const games: GameRecord[] = [];
    for (let i = 0; i < shard.matches; i++) {
      const g: GameRecord = {
        shardId: shard.shardId,
        matchIndex: i,
        seat0: shard.seat0,
        seat1: shard.seat1,
        winner: i < wins ? shard.seat0 : shard.seat1,
        fault: faultEvery > 0 && i % faultEvery === faultEvery - 1,
      };
      if (withTurns) {
        g.turns = 10 + (i % 5);
        g.durationMs = 500 + (i % 3) * 100;
      }
      games.push(g);
    }
    return { games };
  };
}

async function buildRun(
  cfg: RunConfig,
  seat0Wins: Record<string, number>,
  opts: { withTurns?: boolean; faultEvery?: number; deckOverrides?: Partial<Record<string, string>> } = {}
): Promise<{ dir: string; store: LocalObjectStore; manifest: Manifest; inputs: ContestantInput[] }> {
  const dir = tmpDir();
  const store = new LocalObjectStore(path.join(dir, 'obj'));
  const inp = inputs(opts.deckOverrides);
  const manifest = await runRoundRobin({
    dir,
    runId: 'r',
    inputs: inp,
    config: cfg,
    store,
    runner: scriptedRunner(seat0Wins, opts),
    now: () => NOW,
  });
  return { dir, store, manifest, inputs: inp };
}

// matsu >> take >> ume, well separated at n=100/shard (each agent plays 4 shards → 400 decided).
const SEPARATED: Record<string, number> = {
  'matsu-vs-take': 80,
  'take-vs-matsu': 20, // seat0=take wins 20 → matsu wins 80
  'matsu-vs-ume': 90,
  'ume-vs-matsu': 10, // seat0=ume wins 10 → matsu wins 90
  'take-vs-ume': 70,
  'ume-vs-take': 30, // seat0=ume wins 30 → take wins 70
};

// matsu clearly top; take and ume TIED at 0.325 → their CIs overlap → 順位未確定.
const TIED_LOWER: Record<string, number> = {
  'matsu-vs-take': 85,
  'take-vs-matsu': 15,
  'matsu-vs-ume': 85,
  'ume-vs-matsu': 15,
  'take-vs-ume': 50,
  'ume-vs-take': 50,
};

describe('readRawGames — recompute source is the raw log, checksum-verified', () => {
  it('reads every completed shard record back and rejects a tampered object', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 10, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    const games = readRawGames(manifest, store);
    expect(games).toHaveLength(60); // 6 shards × 10
    expect(games.every((g) => typeof g.turns === 'number')).toBe(true);

    // Corrupt an object's bytes on disk → readback must throw on checksum mismatch.
    const ref = manifest.shards[0].gamesRef!;
    const filePath = path.join((store as unknown as { root: string }).root, ref.key);
    fs.writeFileSync(filePath, 'tampered\n');
    expect(() => readRawGames(manifest, store)).toThrow(/checksum mismatch/);
  });
});

describe('tallyAgent', () => {
  it('tallies wins/losses/draws/faults and averages turns & time', () => {
    const games: GameRecord[] = [
      { shardId: 's', matchIndex: 0, seat0: 'matsu', seat1: 'take', winner: 'matsu', fault: false, turns: 10, durationMs: 400 },
      { shardId: 's', matchIndex: 1, seat0: 'matsu', seat1: 'take', winner: 'take', fault: true, turns: 20, durationMs: 600 },
      { shardId: 's', matchIndex: 2, seat0: 'take', seat1: 'matsu', winner: 'draw', fault: false }, // no turns
    ];
    const m = tallyAgent(games, 'matsu', '松');
    expect(m.matches).toBe(3);
    expect(m.decided).toBe(2);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(1);
    expect(m.draws).toBe(1);
    expect(m.faults).toBe(1); // matsu lost the faulted game
    expect(m.winRate).toBeCloseTo(0.5, 6);
    expect(m.avgTurns).toBeCloseTo(15, 6); // only the 2 games with turns
    expect(m.turnsSamples).toBe(2);
    expect(m.avgDurationMs).toBeCloseTo(500, 6);
  });

  it('returns null averages when no game carries turns/time', () => {
    const games: GameRecord[] = [
      { shardId: 's', matchIndex: 0, seat0: 'matsu', seat1: 'take', winner: 'matsu', fault: false },
    ];
    const m = tallyAgent(games, 'matsu', '松');
    expect(m.avgTurns).toBeNull();
    expect(m.avgDurationMs).toBeNull();
    expect(m.turnsSamples).toBe(0);
  });

  it('respects the seat filter (先後 split)', () => {
    const games: GameRecord[] = [
      { shardId: 's', matchIndex: 0, seat0: 'matsu', seat1: 'take', winner: 'matsu', fault: false },
      { shardId: 's', matchIndex: 1, seat0: 'take', seat1: 'matsu', winner: 'take', fault: false },
    ];
    expect(tallyAgent(games, 'matsu', '松', 'first').matches).toBe(1);
    expect(tallyAgent(games, 'matsu', '松', 'first').wins).toBe(1);
    expect(tallyAgent(games, 'matsu', '松', 'second').matches).toBe(1);
    expect(tallyAgent(games, 'matsu', '松', 'second').wins).toBe(0);
  });
});

describe('tallyPair', () => {
  it('computes head-to-head wins and A win rate', () => {
    const games: GameRecord[] = [
      { shardId: 's', matchIndex: 0, seat0: 'matsu', seat1: 'take', winner: 'matsu', fault: false },
      { shardId: 's', matchIndex: 1, seat0: 'take', seat1: 'matsu', winner: 'matsu', fault: false },
      { shardId: 's', matchIndex: 2, seat0: 'take', seat1: 'matsu', winner: 'take', fault: false },
    ];
    const p = tallyPair(games, 'matsu', 'take');
    expect(p.games).toBe(3);
    expect(p.decided).toBe(3);
    expect(p.aWins).toBe(2); // matsu is `a`
    expect(p.bWins).toBe(1);
    expect(p.aWinRate).toBeCloseTo(2 / 3, 6);
  });
});

describe('decideRanking — never assert an order without evidence', () => {
  it('determined when CIs separate and sample sufficient', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 100, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    expect(a.ranking.order).toEqual(['matsu', 'take', 'ume']);
    expect(a.ranking.determined).toBe(true);
    expect(a.ranking.ambiguities).toHaveLength(0);
    expect(a.ranking.note).toContain('順位確定');
    expect(a.warnings).toEqual([]);
  });

  it('順位未確定 when two agents tie (CI overlap) even with a large sample', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 100, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      TIED_LOWER
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    expect(a.ranking.determined).toBe(false);
    expect(a.ranking.note).toContain('順位未確定');
    expect(a.ranking.ambiguities.some((x) => x.ciOverlap)).toBe(true);
    expect(a.warnings.some((w) => w.includes('CI重複'))).toBe(true);
    // No sample-insufficiency warning here (decided = 400 each).
    expect(a.warnings.some((w) => w.includes('サンプル不足'))).toBe(false);
  });

  it('順位未確定 with a サンプル不足 warning when the sample is thin', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 5, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW, minSample: 30 });
    expect(a.ranking.determined).toBe(false);
    expect(a.warnings.some((w) => w.includes('サンプル不足'))).toBe(true);
    expect(a.ranking.note).toContain('サンプル不足');
  });
});

describe('decideRanking (direct)', () => {
  const stat = (label: string, winRate: number, ciLow: number, ciHigh: number, decided = 400) =>
    ({ label, winRate, ciLow, ciHigh, decided }) as ReturnType<typeof tallyAgent>;

  it('determined when all adjacencies are CI-separated and sample sufficient', () => {
    const r = decideRanking(
      [stat('a', 0.85, 0.81, 0.89), stat('b', 0.45, 0.40, 0.50), stat('c', 0.2, 0.16, 0.24)],
      30
    );
    expect(r.determined).toBe(true);
    expect(r.order).toEqual(['a', 'b', 'c']);
    expect(r.note).toContain('順位確定');
  });

  it('undetermined (thin sample) even when CIs are separated', () => {
    const r = decideRanking([stat('a', 0.85, 0.7, 0.95, 20), stat('b', 0.2, 0.05, 0.4, 20)], 30);
    expect(r.determined).toBe(false);
    expect(r.note).toContain('サンプル不足');
  });
});

describe('ciOverlaps', () => {
  it('detects overlap vs separation', () => {
    const hi = { ciLow: 0.6, ciHigh: 0.8 } as ReturnType<typeof tallyAgent>;
    const lo = { ciLow: 0.4, ciHigh: 0.55 } as ReturnType<typeof tallyAgent>;
    const mid = { ciLow: 0.5, ciHigh: 0.7 } as ReturnType<typeof tallyAgent>;
    expect(ciOverlaps(hi, lo)).toBe(false);
    expect(ciOverlaps(hi, mid)).toBe(true);
  });
});

describe('computeAnalysis — full breakdown', () => {
  it('produces overall / seat / pair / deck views and correct totals', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 10, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED,
      { faultEvery: 5 }
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    expect(a.schemaVersion).toBe(ANALYSIS_SCHEMA_VERSION);
    expect(a.totals.matches).toBe(60);
    expect(a.totals.decided).toBe(60); // no draws in scripted runner
    // seat split matches sum back to overall matches.
    for (const label of ['matsu', 'take', 'ume']) {
      const overall = a.agents.find((x) => x.label === label)!;
      const sp = a.bySeat[label];
      expect(sp.first.matches + sp.second.matches).toBe(overall.matches);
    }
    // 3 pairs, each agent uses a distinct deck → 3 deck rows.
    expect(a.byPair).toHaveLength(3);
    expect(a.byDeck).toHaveLength(3);
    // faultEvery=5 over 60 games → some faults recorded.
    expect(a.totals.faults).toBeGreaterThan(0);
    expect(a.warnings.some((w) => w.startsWith('faults present'))).toBe(true);
  });

  it('groups deck stats when two agents share a deck hash', async () => {
    const shared = sha256Hex('shared-deck');
    const { manifest, store } = await buildRun(
      { matchesPerShard: 10, seed: 1, deckMode: 'mirror', chunksPerOrientation: 1 },
      SEPARATED,
      { deckOverrides: { take: shared, ume: shared } }
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    expect(a.byDeck).toHaveLength(2); // matsu's deck + the shared take/ume deck
    const sharedRow = a.byDeck.find((d) => d.deckHash === shared)!;
    expect(sharedRow.agents.sort()).toEqual(['take', 'ume']);
    expect(sharedRow.matches).toBe(80); // take(40) + ume(40)
  });
});

describe('computeDiff — vs a baseline', () => {
  it('diffs winRate and matches vs a prior Analysis', () => {
    const prev = {
      agents: [
        { label: 'matsu', winRate: 0.8, decided: 400 },
        { label: 'take', winRate: 0.5, decided: 400 },
      ],
    } as unknown as Analysis;
    const cur = [
      { label: 'matsu', winRate: 0.85, decided: 420 },
      { label: 'take', winRate: 0.45, decided: 380 },
    ] as ReturnType<typeof tallyAgent>[];
    const diff = computeDiff(cur, prev, 'base')!;
    expect(diff.baselineRunId).toBe('base');
    const matsu = diff.agents.find((d) => d.label === 'matsu')!;
    expect(matsu.winRateDelta).toBeCloseTo(0.05, 6);
    expect(matsu.matchesDelta).toBe(20);
    const take = diff.agents.find((d) => d.label === 'take')!;
    expect(take.winRateDelta).toBeCloseTo(-0.05, 6);
  });

  it('null deltas for an agent absent from the baseline', () => {
    const prev = { agents: [{ label: 'matsu', winRate: 0.8, decided: 400 }] } as unknown as Analysis;
    const cur = [{ label: 'ume', winRate: 0.2, decided: 100 }] as ReturnType<typeof tallyAgent>[];
    const diff = computeDiff(cur, prev, 'base')!;
    expect(diff.agents[0].winRateDelta).toBeNull();
    expect(diff.agents[0].prevMatches).toBeNull();
  });

  it('returns null when there is no baseline', () => {
    expect(computeDiff([], null, 'x')).toBeNull();
  });
});

describe('renderReport + buildNotification + redaction', () => {
  it('renders an evidence-qualified report with the ranking verdict and no host path', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 100, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      TIED_LOWER
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    const md = renderReport(a);
    expect(md).toContain('# PTCG battle report — run r');
    expect(md).toContain('順位未確定');
    expect(md).toContain('Overall standings');
    expect(md).toContain('先後 (seat) breakdown');
    expect(md).toContain('Head-to-head');
    expect(md).toContain('Deck breakdown');
    expect(() => assertReportClean(md, {})).not.toThrow();
  });

  it('assertReportClean flags a leaked host path', () => {
    expect(() => assertReportClean('see /workspaces/ptcg-agent-matsu/deck.csv', {})).toThrow(/disallowed/);
  });

  it('buildNotification includes run-id, verdict, standings and report path', async () => {
    const { manifest, store } = await buildRun(
      { matchesPerShard: 100, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    const a = computeAnalysis(manifest, readRawGames(manifest, store), { generatedAt: NOW });
    const line = buildNotification(a, 'artifacts/ptcg-battle-lab/runs/report.r.md');
    expect(line).toContain('run=r');
    expect(line).toContain('順位確定');
    expect(line).toContain('report=artifacts/ptcg-battle-lab/runs/report.r.md');
    expect(line).toContain('fault0');
  });
});

describe('analyzeRun — on-disk artifacts + regeneration from raw records', () => {
  it('writes aggregate.json + report.md and is idempotent from the raw logs', async () => {
    const { dir, store } = await buildRun(
      { matchesPerShard: 20, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    const r1 = analyzeRun({ dir, runId: 'r', store, generatedAt: NOW, env: {} });
    expect(fs.existsSync(r1.aggregatePath)).toBe(true);
    expect(fs.existsSync(r1.reportPath)).toBe(true);
    const agg1 = fs.readFileSync(r1.aggregatePath, 'utf8');

    // Re-run analyze from the SAME raw logs → byte-identical aggregate (regeneration from raw records).
    const r2 = analyzeRun({ dir, runId: 'r', store, generatedAt: NOW, env: {} });
    expect(fs.readFileSync(r2.aggregatePath, 'utf8')).toBe(agg1);
  });

  it('uses a baseline aggregate for the diff', async () => {
    const { dir, store } = await buildRun(
      { matchesPerShard: 20, seed: 1, deckMode: 'own', chunksPerOrientation: 1 },
      SEPARATED
    );
    // First analyze writes aggregate.r.json; copy it as a baseline run id.
    const base = analyzeRun({ dir, runId: 'r', store, generatedAt: NOW, env: {} });
    fs.copyFileSync(base.aggregatePath, path.join(dir, 'aggregate.base.json'));
    const withDiff = analyzeRun({ dir, runId: 'r', store, generatedAt: NOW, baselineRunId: 'base', env: {} });
    expect(withDiff.analysis.diff).not.toBeNull();
    expect(withDiff.analysis.diff!.baselineRunId).toBe('base');
    // Same data → zero deltas.
    for (const d of withDiff.analysis.diff!.agents) expect(d.winRateDelta).toBeCloseTo(0, 6);
  });

  it('throws a clear error when the manifest is missing', () => {
    const dir = tmpDir();
    const store = new LocalObjectStore(path.join(dir, 'obj'));
    expect(() => analyzeRun({ dir, runId: 'nope', store, generatedAt: NOW })).toThrow(/no manifest/);
  });
});
