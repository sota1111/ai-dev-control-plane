// SOT-1711: ptcg-analyze — recompute PTCG battle statistics FROM RAW GAME RECORDS and render an
// evidence-qualified report.
//
// WHY THIS EXISTS. SOT-1713's ptcg-battle-lab persists every match as a raw record in an object store
// and keeps only a small per-shard tally in the git manifest. That tally is enough to sum win totals,
// but it deliberately does NOT carry the breakdowns and diagnostics an operator needs to trust a result:
// per-pair / per-seat(先後) / per-deck splits, average turns & time, and — most importantly — an honest
// statement of *uncertainty* (Wilson 95% CI overlap, insufficient sample) so a ranking is never claimed
// without statistical basis. This module reads the raw `games.jsonl` objects back (verifying their
// checksums), recomputes everything from the individual records, and produces two artifacts:
//   - aggregate.<run-id>.json — the machine-readable Analysis (this module's output shape)
//   - report.<run-id>.md      — the human-readable, evidence-qualified report
//
// It is pure/deterministic Node (the clock is injected), so it is fully unit-testable and reproducible:
// re-running analyze on the same manifest+objects yields byte-identical artifacts.

import fs from 'node:fs';
import path from 'node:path';
import {
  assertArtifactClean,
  loadManifest,
  sha256Hex,
  wilson95,
  type Aggregate,
  type ContestantInput,
  type GameRecord,
  type Manifest,
  type ObjectStore,
  type RunConfig,
  writeFileAtomic,
} from './ptcgBattleLab.js';

/** Analysis artifact schema version. Bump on any breaking shape change. */
export const ANALYSIS_SCHEMA_VERSION = 'ptcg-analyze/v1';

/** Default minimum decided matches per agent below which a ranking is treated as unproven. */
export const DEFAULT_MIN_SAMPLE = 30;

/** Per-agent statistics recomputed from raw records (used for overall, per-seat, and per-deck views). */
export interface AgentStat {
  label: string;
  kanji: string;
  /** Games the agent played (either seat). */
  matches: number;
  /** Games with a contestant winner (draws excluded). Denominator for winRate + CI. */
  decided: number;
  wins: number;
  losses: number;
  draws: number;
  faults: number;
  /** wins / decided (0 when decided=0). */
  winRate: number;
  /** Wilson 95% CI on winRate over `decided` matches. */
  ciLow: number;
  ciHigh: number;
  /** Mean turns over games that carried a `turns` field (null when none did). */
  avgTurns: number | null;
  /** Mean duration (ms) over games that carried a `durationMs` field (null when none did). */
  avgDurationMs: number | null;
  /** How many games contributed to avgTurns / avgDurationMs (sample transparency). */
  turnsSamples: number;
  durationSamples: number;
}

/** Per-agent 先後 (first/second seat) split. */
export interface SeatSplit {
  /** Stats when the agent played seat 0 (先手). */
  first: AgentStat;
  /** Stats when the agent played seat 1 (後手). */
  second: AgentStat;
}

/** Unordered-pair head-to-head statistics. */
export interface PairStat {
  /** Lexicographically-first label of the pair. */
  a: string;
  /** Lexicographically-second label of the pair. */
  b: string;
  games: number;
  decided: number;
  draws: number;
  faults: number;
  aWins: number;
  bWins: number;
  /** aWins / decided. */
  aWinRate: number;
  aCiLow: number;
  aCiHigh: number;
}

/** Per-deck (by deck content hash) statistics — decks are pinned per contestant in the manifest. */
export interface DeckStat {
  deckHash: string;
  /** Contestant labels that played this deck. */
  agents: string[];
  matches: number;
  decided: number;
  wins: number;
  losses: number;
  winRate: number;
  ciLow: number;
  ciHigh: number;
}

/** One adjacency in the winRate-sorted order and whether its two rows' CIs overlap. */
export interface RankingAdjacency {
  higher: string;
  lower: string;
  higherWinRate: number;
  lowerWinRate: number;
  /** True when the Wilson CIs overlap → the relative order is NOT statistically established. */
  ciOverlap: boolean;
}

/** The ranking verdict — deliberately conservative: `determined` only when there is real evidence. */
export interface Ranking {
  /** True only when every adjacency is CI-separated AND every agent has >= minSample decided matches. */
  determined: boolean;
  /** Labels sorted by winRate desc (the *tentative* order even when undetermined). */
  order: string[];
  /** Adjacencies whose order is unproven (CI overlap). */
  ambiguities: RankingAdjacency[];
  /** Human-readable verdict (順位確定 / 順位未確定 with the reason). */
  note: string;
}

/** Per-agent delta vs a baseline run. */
export interface AgentDiff {
  label: string;
  winRate: number;
  prevWinRate: number | null;
  winRateDelta: number | null;
  matches: number;
  prevMatches: number | null;
  matchesDelta: number | null;
}

export interface RunDiff {
  baselineRunId: string;
  agents: AgentDiff[];
}

/** The full analysis artifact (written as aggregate.<run-id>.json). */
export interface Analysis {
  schemaVersion: string;
  runId: string;
  generatedAt: string;
  minSample: number;
  config: RunConfig;
  inputs: ContestantInput[];
  totals: {
    shardsTotal: number;
    shardsCompleted: number;
    matches: number;
    decided: number;
    draws: number;
    faults: number;
  };
  /** Overall per-agent stats, sorted by winRate desc. */
  agents: AgentStat[];
  /** Per-agent 先後 split keyed by label. */
  bySeat: Record<string, SeatSplit>;
  /** Head-to-head per unordered pair. */
  byPair: PairStat[];
  /** Per-deck stats keyed by deck hash. */
  byDeck: DeckStat[];
  ranking: Ranking;
  diff: RunDiff | null;
  /** Operator-facing warnings (faults present, sample不足, CI重複). */
  warnings: string[];
}

// --------------------------------------------------------------------------- //
// Raw-record loading — recompute FROM the raw logs, not from the manifest tally.
// --------------------------------------------------------------------------- //

/**
 * Read back every raw game record across all COMPLETED shards, verifying each object's checksum/size
 * against the manifest ref (integrity) before parsing. This is the "regenerate from raw records"
 * guarantee: the returned records are the ground truth analyze computes from, never the manifest summary.
 */
export function readRawGames(manifest: Manifest, store: ObjectStore): GameRecord[] {
  const games: GameRecord[] = [];
  for (const shard of manifest.shards) {
    if (shard.status !== 'completed' || !shard.gamesRef) continue;
    const buf = store.get(shard.gamesRef.key, shard.gamesRef);
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      games.push(JSON.parse(trimmed) as GameRecord);
    }
  }
  return games;
}

// --------------------------------------------------------------------------- //
// Statistics
// --------------------------------------------------------------------------- //

/** Whether `g`'s winner is a real contestant (i.e. the game was decided, not a draw). */
function isDecided(g: GameRecord): boolean {
  return g.winner === g.seat0 || g.winner === g.seat1;
}

type SeatFilter = 'first' | 'second' | 'any';

/**
 * Tally one agent's stats over `games`, optionally restricted to the seat it occupied (先後 split).
 * All views (overall, per-seat, per-deck) are built from this single accumulator so they can never
 * drift apart.
 */
export function tallyAgent(
  games: GameRecord[],
  label: string,
  kanji: string,
  seat: SeatFilter = 'any'
): AgentStat {
  let matches = 0;
  let decided = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let faults = 0;
  let turnsSum = 0;
  let turnsSamples = 0;
  let durSum = 0;
  let durationSamples = 0;

  for (const g of games) {
    const isSeat0 = g.seat0 === label;
    const isSeat1 = g.seat1 === label;
    if (!isSeat0 && !isSeat1) continue;
    if (seat === 'first' && !isSeat0) continue;
    if (seat === 'second' && !isSeat1) continue;

    matches++;
    if (isDecided(g)) {
      decided++;
      if (g.winner === label) wins++;
      else {
        losses++;
        if (g.fault) faults++; // the fault is charged to the loser
      }
    } else {
      draws++;
    }
    if (typeof g.turns === 'number') {
      turnsSum += g.turns;
      turnsSamples++;
    }
    if (typeof g.durationMs === 'number') {
      durSum += g.durationMs;
      durationSamples++;
    }
  }

  const ci = wilson95(wins, decided);
  return {
    label,
    kanji,
    matches,
    decided,
    wins,
    losses,
    draws,
    faults,
    winRate: decided === 0 ? 0 : wins / decided,
    ciLow: ci.low,
    ciHigh: ci.high,
    avgTurns: turnsSamples === 0 ? null : turnsSum / turnsSamples,
    avgDurationMs: durationSamples === 0 ? null : durSum / durationSamples,
    turnsSamples,
    durationSamples,
  };
}

/** Head-to-head stats for the unordered pair {a,b} (a is the lexicographically-first label). */
export function tallyPair(games: GameRecord[], a: string, b: string): PairStat {
  let gamesN = 0;
  let decided = 0;
  let draws = 0;
  let faults = 0;
  let aWins = 0;
  let bWins = 0;
  for (const g of games) {
    const seats = [g.seat0, g.seat1];
    if (!(seats.includes(a) && seats.includes(b))) continue;
    gamesN++;
    if (isDecided(g)) {
      decided++;
      if (g.winner === a) aWins++;
      else bWins++;
      if (g.fault) faults++;
    } else {
      draws++;
    }
  }
  const ci = wilson95(aWins, decided);
  return {
    a,
    b,
    games: gamesN,
    decided,
    draws,
    faults,
    aWins,
    bWins,
    aWinRate: decided === 0 ? 0 : aWins / decided,
    aCiLow: ci.low,
    aCiHigh: ci.high,
  };
}

/** Do two Wilson CIs overlap? Overlap ⇒ the two win rates are NOT statistically separated. */
export function ciOverlaps(a: AgentStat, b: AgentStat): boolean {
  return !(a.ciLow > b.ciHigh || b.ciLow > a.ciHigh);
}

/**
 * Decide the ranking conservatively. The order is always winRate-desc, but `determined` is true ONLY
 * when (1) every agent has >= minSample decided matches and (2) no adjacent pair's CIs overlap. Any
 * overlap or thin sample keeps it 順位未確定 so we never assert an order without evidence.
 */
export function decideRanking(agents: AgentStat[], minSample: number): Ranking {
  const order = agents.map((a) => a.label);
  const ambiguities: RankingAdjacency[] = [];
  for (let i = 0; i + 1 < agents.length; i++) {
    const hi = agents[i];
    const lo = agents[i + 1];
    if (ciOverlaps(hi, lo)) {
      ambiguities.push({
        higher: hi.label,
        lower: lo.label,
        higherWinRate: hi.winRate,
        lowerWinRate: lo.winRate,
        ciOverlap: true,
      });
    }
  }
  const thin = agents.filter((a) => a.decided < minSample).map((a) => a.label);
  const determined = ambiguities.length === 0 && thin.length === 0;
  let note: string;
  if (determined) {
    note = `順位確定: ${order.join(' > ')}（全隣接でWilson95% CIが分離、各エージェント decided ≥ ${minSample}）`;
  } else {
    const reasons: string[] = [];
    if (ambiguities.length > 0) {
      reasons.push(
        `CI重複: ${ambiguities.map((x) => `${x.higher}↔${x.lower}`).join(', ')}`
      );
    }
    if (thin.length > 0) reasons.push(`サンプル不足(decided<${minSample}): ${thin.join(', ')}`);
    note = `順位未確定（${reasons.join(' / ')}）— 暫定順: ${order.join(' > ')}`;
  }
  return { determined, order, ambiguities, note };
}

/** Compute the diff of the current agents vs a baseline analyze aggregate (per-agent winRate/matches). */
export function computeDiff(agents: AgentStat[], baseline: Aggregate | Analysis | null, baselineRunId: string): RunDiff | null {
  if (!baseline) return null;
  // Accept either an analyze Analysis (has `agents`) or a battle-lab Aggregate (has `standings`).
  const prevRows: Array<{ label: string; winRate: number; matches: number }> =
    'agents' in baseline
      ? baseline.agents.map((a) => ({ label: a.label, winRate: a.winRate, matches: a.decided }))
      : baseline.standings.map((s) => ({ label: s.label, winRate: s.winRate, matches: s.matches }));
  const prev = new Map(prevRows.map((r) => [r.label, r]));
  return {
    baselineRunId,
    agents: agents.map((a) => {
      const p = prev.get(a.label) ?? null;
      return {
        label: a.label,
        winRate: a.winRate,
        prevWinRate: p ? p.winRate : null,
        winRateDelta: p ? a.winRate - p.winRate : null,
        matches: a.decided,
        prevMatches: p ? p.matches : null,
        matchesDelta: p ? a.decided - p.matches : null,
      };
    }),
  };
}

export interface ComputeOptions {
  generatedAt: string;
  minSample?: number;
  baseline?: Aggregate | Analysis | null;
  baselineRunId?: string;
}

/** Recompute the full Analysis from a manifest + the raw records read out of the object store. */
export function computeAnalysis(manifest: Manifest, games: GameRecord[], opts: ComputeOptions): Analysis {
  const minSample = opts.minSample ?? DEFAULT_MIN_SAMPLE;
  const kanjiOf = new Map(manifest.inputs.map((i) => [i.label, i.kanji]));

  const agents = manifest.inputs
    .map((inp) => tallyAgent(games, inp.label, inp.kanji, 'any'))
    .sort((a, b) => b.winRate - a.winRate || a.label.localeCompare(b.label));

  const bySeat: Record<string, SeatSplit> = {};
  for (const inp of manifest.inputs) {
    bySeat[inp.label] = {
      first: tallyAgent(games, inp.label, inp.kanji, 'first'),
      second: tallyAgent(games, inp.label, inp.kanji, 'second'),
    };
  }

  const byPair: PairStat[] = [];
  const labels = manifest.inputs.map((i) => i.label);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const [a, b] = [labels[i], labels[j]].sort();
      byPair.push(tallyPair(games, a, b));
    }
  }

  // Per-deck: attribute each agent's participation to that agent's deck hash.
  const deckGroups = new Map<string, string[]>();
  for (const inp of manifest.inputs) {
    const arr = deckGroups.get(inp.deckHash) ?? [];
    arr.push(inp.label);
    deckGroups.set(inp.deckHash, arr);
  }
  const byDeck: DeckStat[] = [];
  for (const [deckHash, deckAgents] of deckGroups) {
    let matches = 0;
    let decided = 0;
    let wins = 0;
    let losses = 0;
    for (const label of deckAgents) {
      const s = tallyAgent(games, label, kanjiOf.get(label) ?? '', 'any');
      matches += s.matches;
      decided += s.decided;
      wins += s.wins;
      losses += s.losses;
    }
    const ci = wilson95(wins, decided);
    byDeck.push({
      deckHash,
      agents: deckAgents.slice().sort(),
      matches,
      decided,
      wins,
      losses,
      winRate: decided === 0 ? 0 : wins / decided,
      ciLow: ci.low,
      ciHigh: ci.high,
    });
  }
  byDeck.sort((a, b) => b.winRate - a.winRate || a.deckHash.localeCompare(b.deckHash));

  const shardsCompleted = manifest.shards.filter((s) => s.status === 'completed').length;
  const totalDecided = agents.reduce((n, a) => n + a.decided, 0); // each decided game counts its 2 seats
  const totalDraws = agents.reduce((n, a) => n + a.draws, 0);
  const totals = {
    shardsTotal: manifest.shards.length,
    shardsCompleted,
    matches: games.length,
    decided: totalDecided / 2,
    draws: totalDraws / 2,
    faults: agents.reduce((n, a) => n + a.faults, 0),
  };

  const ranking = decideRanking(agents, minSample);

  const warnings: string[] = [];
  if (totals.faults > 0) warnings.push(`faults present: ${totals.faults}`);
  for (const a of agents) {
    if (a.decided < minSample) warnings.push(`サンプル不足: ${a.label} (decided=${a.decided} < ${minSample})`);
  }
  for (const x of ranking.ambiguities) warnings.push(`CI重複: ${x.higher} ↔ ${x.lower}`);

  const diff = computeDiff(agents, opts.baseline ?? null, opts.baselineRunId ?? 'unknown');

  return {
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    runId: manifest.runId,
    generatedAt: opts.generatedAt,
    minSample,
    config: manifest.config,
    inputs: manifest.inputs,
    totals,
    agents,
    bySeat,
    byPair,
    byDeck,
    ranking,
    diff,
    warnings,
  };
}

// --------------------------------------------------------------------------- //
// Report rendering
// --------------------------------------------------------------------------- //

function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}
function ci(low: number, high: number): string {
  return `[${low.toFixed(3)}, ${high.toFixed(3)}]`;
}
function num(x: number | null, digits = 1): string {
  return x === null ? '—' : x.toFixed(digits);
}
function signed(x: number | null): string {
  if (x === null) return '—';
  const s = x >= 0 ? '+' : '';
  return s + x.toFixed(3);
}

/** Render the human-readable, evidence-qualified report (report.<run-id>.md). Pure string builder. */
export function renderReport(a: Analysis): string {
  const L: string[] = [];
  L.push(`# PTCG battle report — run ${a.runId}`);
  L.push('');
  L.push(`- schema: \`${a.schemaVersion}\` · generated: ${a.generatedAt}`);
  L.push(
    `- shards: ${a.totals.shardsCompleted}/${a.totals.shardsTotal} completed · matches: ${a.totals.matches} · decided: ${a.totals.decided} · draws: ${a.totals.draws} · faults: ${a.totals.faults}`
  );
  L.push(
    `- config: matches/shard=${a.config.matchesPerShard} seed=${a.config.seed} deck-mode=${a.config.deckMode} chunks=${a.config.chunksPerOrientation} · min-sample=${a.minSample}`
  );
  L.push('');

  L.push('## 順位 (ranking)');
  L.push('');
  L.push(a.ranking.determined ? `**順位確定** — ${a.ranking.note}` : `**順位未確定** — ${a.ranking.note}`);
  L.push('');

  L.push('## Overall standings (raw records から再計算)');
  L.push('');
  L.push('| # | agent | winRate | Wilson95% CI | W-L | decided | draws | faults | 平均手数 | 平均時間(ms) |');
  L.push('|---|-------|--------:|--------------|-----|--------:|------:|-------:|--------:|-------------:|');
  a.agents.forEach((s, i) => {
    L.push(
      `| ${i + 1} | ${s.kanji} ${s.label} | ${pct(s.winRate)} | ${ci(s.ciLow, s.ciHigh)} | ${s.wins}-${s.losses} | ${s.decided} | ${s.draws} | ${s.faults} | ${num(s.avgTurns)} | ${num(s.avgDurationMs, 0)} |`
    );
  });
  L.push('');

  L.push('## 先後 (seat) breakdown');
  L.push('');
  L.push('| agent | seat | winRate | Wilson95% CI | W-L | decided |');
  L.push('|-------|------|--------:|--------------|-----|--------:|');
  for (const label of a.agents.map((x) => x.label)) {
    const sp = a.bySeat[label];
    for (const [seatName, s] of [['先手', sp.first], ['後手', sp.second]] as const) {
      L.push(
        `| ${s.kanji} ${label} | ${seatName} | ${pct(s.winRate)} | ${ci(s.ciLow, s.ciHigh)} | ${s.wins}-${s.losses} | ${s.decided} |`
      );
    }
  }
  L.push('');

  L.push('## Head-to-head (pair) breakdown');
  L.push('');
  L.push('| pair | A winRate (vs B) | Wilson95% CI | A-B wins | decided | draws | faults |');
  L.push('|------|-----------------:|--------------|----------|--------:|------:|-------:|');
  for (const p of a.byPair) {
    L.push(
      `| ${p.a} vs ${p.b} | ${pct(p.aWinRate)} | ${ci(p.aCiLow, p.aCiHigh)} | ${p.aWins}-${p.bWins} | ${p.decided} | ${p.draws} | ${p.faults} |`
    );
  }
  L.push('');

  L.push('## Deck breakdown (by deck hash)');
  L.push('');
  L.push('| deck (sha256[:12]) | agents | winRate | Wilson95% CI | decided |');
  L.push('|--------------------|--------|--------:|--------------|--------:|');
  for (const d of a.byDeck) {
    L.push(
      `| \`${d.deckHash.slice(0, 12)}\` | ${d.agents.join(', ')} | ${pct(d.winRate)} | ${ci(d.ciLow, d.ciHigh)} | ${d.decided} |`
    );
  }
  L.push('');

  if (a.diff) {
    L.push(`## Diff vs baseline run \`${a.diff.baselineRunId}\``);
    L.push('');
    L.push('| agent | winRate | Δ winRate | decided | Δ decided |');
    L.push('|-------|--------:|----------:|--------:|----------:|');
    for (const d of a.diff.agents) {
      L.push(
        `| ${d.label} | ${pct(d.winRate)} | ${signed(d.winRateDelta)} | ${d.matches} | ${d.matchesDelta === null ? '—' : (d.matchesDelta >= 0 ? '+' : '') + d.matchesDelta} |`
      );
    }
    L.push('');
  }

  L.push('## Warnings');
  L.push('');
  if (a.warnings.length === 0) {
    L.push('- none');
  } else {
    for (const w of a.warnings) L.push(`- ${w}`);
  }
  L.push('');
  L.push('## Inputs (pinned)');
  L.push('');
  L.push('| agent | repo | commit[:12] | deckHash[:12] |');
  L.push('|-------|------|-------------|---------------|');
  for (const inp of a.inputs) {
    L.push(`| ${inp.kanji} ${inp.label} | ${inp.repo} | \`${inp.commit.slice(0, 12)}\` | \`${inp.deckHash.slice(0, 12)}\` |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}

// --------------------------------------------------------------------------- //
// One-line notification (Linear / Discord run-id + report tracking)
// --------------------------------------------------------------------------- //

/** Build the one-line Discord/Linear notification: run-id, verdict, standings summary, report path. */
export function buildNotification(a: Analysis, reportPath: string): string {
  const standings = a.agents
    .map((s) => `${s.kanji}${s.label} ${pct(s.winRate)}`)
    .join(' > ');
  const verdict = a.ranking.determined ? '順位確定' : '順位未確定';
  const faults = a.totals.faults === 0 ? 'fault0' : `fault${a.totals.faults}`;
  return `PTCG analyze run=${a.runId}: ${verdict} ${standings} (${faults}, n=${a.totals.matches}) report=${reportPath}`;
}

// --------------------------------------------------------------------------- //
// Artifact paths + on-disk driver
// --------------------------------------------------------------------------- //

export function aggregatePath(dir: string, runId: string): string {
  return path.join(dir, `aggregate.${runId}.json`);
}
export function reportPath(dir: string, runId: string): string {
  return path.join(dir, `report.${runId}.md`);
}

/** Load a previously-written analyze aggregate.<run-id>.json (baseline for diff), or null if absent. */
export function loadAggregate(dir: string, runId: string): Analysis | null {
  const p = aggregatePath(dir, runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Analysis;
}

export interface AnalyzeRunOptions {
  /** Directory holding manifest.<run-id>.json and where aggregate/report are written. */
  dir: string;
  runId: string;
  store: ObjectStore;
  generatedAt: string;
  minSample?: number;
  /** Optional baseline run-id (its aggregate.<id>.json under `dir`) for the diff. */
  baselineRunId?: string;
  env?: NodeJS.ProcessEnv;
}

export interface AnalyzeRunResult {
  analysis: Analysis;
  report: string;
  aggregatePath: string;
  reportPath: string;
}

/**
 * End-to-end analyze: load the manifest, read raw records from the store (checksum-verified), recompute
 * the Analysis, and write aggregate.<run-id>.json + report.<run-id>.md atomically (both asserted clean
 * of secrets/host paths before persisting). Returns the analysis and the artifact paths.
 */
export function analyzeRun(opts: AnalyzeRunOptions): AnalyzeRunResult {
  const manifest = loadManifest(opts.dir, opts.runId);
  if (!manifest) throw new Error(`no manifest for run ${opts.runId} in ${opts.dir}`);
  const games = readRawGames(manifest, opts.store);
  const baseline = opts.baselineRunId ? loadAggregate(opts.dir, opts.baselineRunId) : null;
  const analysis = computeAnalysis(manifest, games, {
    generatedAt: opts.generatedAt,
    minSample: opts.minSample,
    baseline,
    baselineRunId: opts.baselineRunId,
  });
  const report = renderReport(analysis);
  const env = opts.env ?? process.env;
  assertArtifactClean(analysis, env);
  const aggP = aggregatePath(opts.dir, opts.runId);
  const repP = reportPath(opts.dir, opts.runId);
  writeFileAtomic(aggP, JSON.stringify(analysis, null, 2) + '\n');
  // The rendered report must also be free of host paths / secrets.
  assertReportClean(report, env);
  writeFileAtomic(repP, report);
  return { analysis, report, aggregatePath: aggP, reportPath: repP };
}

/** Assert the rendered markdown report contains no host path / secret (a string-level redaction check). */
export function assertReportClean(report: string, env: NodeJS.ProcessEnv = process.env): void {
  // Reuse the JSON-artifact scanner by wrapping the whole report body as one string node.
  assertArtifactClean({ report }, env);
}

/** sha256 of a report (used by callers that want a stable content id for tracking). */
export function reportChecksum(report: string): string {
  return sha256Hex(report);
}
