// SOT-1713: ptcg-battle-lab — a resumable, standard artifact pipeline for the 松竹梅 (matsu/take/ume)
// cross-agent round-robin battle.
//
// WHY THIS EXISTS. The three sibling agent repos (ptcg-agent-matsu/take/ume) have been battled against
// each other many times, but always through ad-hoc /tmp driver scripts whose outputs lived outside git,
// could not be resumed after an interruption without double-counting, and sometimes leaked host paths
// into results. This module is the canonical orchestration layer that fixes that: ONE entrypoint runs
// the full 先後入替 (seat-swap) round-robin as sharded work, records a redacted manifest (run-id, input
// commits, deck hashes, seed, schema version), persists raw game logs to an object store referenced by
// checksum, and — crucially — is *resumable*: a completed shard is never re-run and never re-aggregated.
//
// SEPARATION OF CONCERNS. The actual match execution (which needs the cabt engine and the sibling repos,
// and therefore cannot run in the control-plane / CI) lives behind the pluggable `ShardRunner` interface.
// Everything in THIS module — shard planning, atomic writes, the object store, resume/duplicate rejection,
// manifest schema + validation, secret/host-path redaction, aggregation — is pure/deterministic Node and
// is exercised end-to-end by a fixture runner in the tests. A real runner (shelling to matsu's
// eval/battle_matsu_take_ume.py) plugs into the same interface without changing any of this.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Manifest/artifact schema version. Bumped to v2 (SOT-1715) when contestants became
 * (tactic × deck) tuples carrying `tactic`/`deckId`. v1 manifests (the legacy 3-contestant
 * own-deck run) remain readable — see {@link SUPPORTED_SCHEMA_VERSIONS} / {@link loadManifest}.
 */
export const SCHEMA_VERSION = 'ptcg-battle-lab/v2';

/**
 * Schema versions this build can READ. New manifests are always written at {@link SCHEMA_VERSION},
 * but a run started under an older schema must still resume, so `loadManifest` accepts any listed
 * version. The v1→v2 shape change is purely additive (optional `tactic`/`deckId` on inputs), so a
 * v1 manifest validates and resumes unchanged.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = [
  'ptcg-battle-lab/v1',
  'ptcg-battle-lab/v2',
] as const;

/** The three contestants. label = stable id used in shard ids and aggregates. */
export interface Contestant {
  /** Stable rōmaji id (matsu/take/ume) — used in shard ids, keys, aggregates. */
  label: string;
  /** Kanji display name (松/竹/梅). */
  kanji: string;
  /** Sibling repo directory name (never an absolute path — host-specific info stays out of artifacts). */
  repo: string;
}

export const CONTESTANTS: readonly Contestant[] = [
  { label: 'matsu', kanji: '松', repo: 'ptcg-agent-matsu' },
  { label: 'take', kanji: '竹', repo: 'ptcg-agent-take' },
  { label: 'ume', kanji: '梅', repo: 'ptcg-agent-ume' },
  { label: 'zero', kanji: '零', repo: 'ptcg-agent-zero' },
] as const;

/**
 * A tactic (playing style) — one of 松/竹/梅, backed by a sibling agent repo. In the (tactic × deck)
 * model a tactic is combined with each deck to form a contestant. `TACTICS` mirrors `CONTESTANTS`;
 * the two exist side-by-side so the legacy 3-contestant own-deck run and the 75-contestant matrix
 * run share the same tactic/kanji/repo metadata.
 */
export interface Tactic {
  /** Stable rōmaji tactic id (matsu/take/ume). */
  tactic: string;
  /** Kanji display name (松/竹/梅). */
  kanji: string;
  /** Sibling repo directory name (never an absolute path). */
  repo: string;
}

export const TACTICS: readonly Tactic[] = [
  { tactic: 'matsu', kanji: '松', repo: 'ptcg-agent-matsu' },
  { tactic: 'take', kanji: '竹', repo: 'ptcg-agent-take' },
  { tactic: 'ume', kanji: '梅', repo: 'ptcg-agent-ume' },
  { tactic: 'zero', kanji: '零', repo: 'ptcg-agent-zero' },
] as const;

/** Per-contestant inputs pinned into the manifest so a run is reproducible/attributable. */
export interface ContestantInput {
  /**
   * Stable id used in shard ids, keys, aggregates. In the legacy own-deck run this is a bare tactic
   * (`matsu`); in the (tactic × deck) matrix it is `${tactic}:${deckId}` (e.g. `matsu:01`).
   */
  label: string;
  kanji: string;
  repo: string;
  /** Git commit SHA of the agent repo at run time. */
  commit: string;
  /** sha256 of the deck the contestant plays (content hash, NOT a path). */
  deckHash: string;
  /**
   * v2: the tactic (matsu/take/ume) this contestant plays. Optional/backward-compatible — v1
   * own-deck inputs omit it (there the tactic is just the label).
   */
  tactic?: string;
  /**
   * v2: the deck id (e.g. `01`) drawn from `decks/initial`. Optional/backward-compatible — v1
   * own-deck inputs omit it (each contestant plays its repo's own deck.csv).
   */
  deckId?: string;
}

/** Run configuration recorded in the manifest (the "conditions" acceptance criterion). */
export interface RunConfig {
  /** Matches played per shard. */
  matchesPerShard: number;
  /** Base RNG seed for the run (per-shard seed derives from it deterministically). */
  seed: number;
  /** How decks are drawn, e.g. "own" (each plays its deck.csv) or "mirror" (shared pool). */
  deckMode: string;
  /** Chunks each ordered pairing is split into (for shard-level parallelism). Default 1. */
  chunksPerOrientation: number;
}

/** A unit of resumable work: one seat orientation of one pairing, optionally one seed-chunk of it. */
export interface ShardSpec {
  /** Stable, unique id, e.g. "matsu-vs-take" or "matsu-vs-take#1". Drives resume/dedup. */
  shardId: string;
  /** Contestant label in engine seat 0 (先手). */
  seat0: string;
  /** Contestant label in engine seat 1 (後手). */
  seat1: string;
  /** Matches to play in this shard. */
  matches: number;
  /** Deterministic per-shard seed (base seed offset by pairing+chunk). */
  seed: number;
}

/** One raw game record (persisted to object storage, never inlined into the git manifest). */
export interface GameRecord {
  shardId: string;
  matchIndex: number;
  seat0: string;
  seat1: string;
  /** Winner label, or 'draw'. (When `fault` is set the loser faulted; `winner` still names the winner.) */
  winner: string;
  /** Whether the result was decided by a fault (illegal move / crash / timeout). */
  fault: boolean;
  /**
   * Number of turns/moves the match lasted. Optional and backward-compatible: v1 records written before
   * SOT-1711 omit it, and `analyze` averages only over the games that carry it.
   */
  turns?: number;
  /** Match wall-clock duration in milliseconds. Optional/backward-compatible like `turns`. */
  durationMs?: number;
}

/** Small per-shard tally kept in the manifest (safe to store; drives aggregation without raw logs). */
export interface ShardSummary {
  matches: number;
  /** wins keyed by contestant label. */
  wins: Record<string, number>;
  /** faults charged, keyed by contestant label. */
  faults: Record<string, number>;
}

/** What a runner returns for one shard. */
export interface ShardResult {
  games: GameRecord[];
}

/** Reference to a raw log object stored in the object store (kept in git instead of the bytes). */
export interface ObjectRef {
  key: string;
  /** sha256 hex of the stored bytes. */
  checksum: string;
  /** byte length. */
  size: number;
}

export type ShardStatus = 'pending' | 'completed';

export interface ShardEntry {
  shardId: string;
  seat0: string;
  seat1: string;
  matches: number;
  seed: number;
  status: ShardStatus;
  /** Set once completed: reference to the raw games.jsonl object. */
  gamesRef: ObjectRef | null;
  /** Set once completed: the tally used for aggregation. */
  summary: ShardSummary | null;
  /** ISO timestamp the shard completed (stamped by the caller, never Date.now here). */
  completedAt: string | null;
}

/** Per-contestant standings row in the aggregate. */
export interface StandingsRow {
  label: string;
  kanji: string;
  matches: number;
  wins: number;
  losses: number;
  faults: number;
  winRate: number;
  /** Wilson 95% CI lower/upper bounds on the win rate. */
  ciLow: number;
  ciHigh: number;
}

export interface Aggregate {
  totalMatches: number;
  totalFaults: number;
  standings: StandingsRow[];
}

export interface Manifest {
  schemaVersion: string;
  runId: string;
  createdAt: string;
  updatedAt: string;
  config: RunConfig;
  inputs: ContestantInput[];
  shards: ShardEntry[];
  aggregate: Aggregate | null;
}

export interface TotalBattleState {
  schemaVersion: 'ptcg-total-battle/v1';
  runId: string;
  phase: 'screen' | 'confirm' | 'completed';
  screenRunId: string;
  confirmRunId: string;
  keepTop: number;
  selectedLabels: string[];
}

export interface TotalBattleOptions {
  dir: string;
  runId: string;
  inputs: ContestantInput[];
  screenMatches: number;
  confirmMatches: number;
  keepTop: number;
  seed: number;
  chunksPerOrientation: number;
  deckMode: string;
  store: ObjectStore;
  runner: ShardRunner;
  now: () => string;
  onShard?: (phase: 'screen' | 'confirm', shardId: string, action: 'run' | 'skip') => void;
}

/** A pluggable battle backend: runs one shard's matches. Kept async so a real backend can shell out. */
export type ShardRunner = (shard: ShardSpec, inputs: ContestantInput[]) => Promise<ShardResult>;

// --------------------------------------------------------------------------- //
// Hashing / atomic IO
// --------------------------------------------------------------------------- //

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Write a file atomically: write to a sibling temp file then rename onto the target. rename(2) is
 * atomic within a filesystem, so a reader/interrupted run never observes a half-written artifact.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  // Unique-ish temp name without Date.now/Math.random (deterministic-friendly): pid + counter.
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${atomicCounter++}`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
let atomicCounter = 0;

// --------------------------------------------------------------------------- //
// Object store — the "raw log goes to object storage, manifest keeps a checksum ref" boundary.
// --------------------------------------------------------------------------- //

export interface ObjectStore {
  /** Store bytes under key; returns the ref (key + checksum + size) recorded in the manifest. */
  put(key: string, data: string | Buffer): ObjectRef;
  /** Read bytes back (throws if absent or checksum mismatches when a ref is supplied). */
  get(key: string, expected?: ObjectRef): Buffer;
  /** Whether a key exists. */
  has(key: string): boolean;
}

/**
 * Local filesystem object store. Stands in for real object storage (S3/GCS) behind the same interface;
 * the git-tracked manifest only ever holds `ObjectRef`s, never the raw bytes, so swapping the backend
 * changes nothing upstream. Writes are atomic.
 */
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    // Keys are relative logical paths; reject traversal so a key can never escape the store root.
    const resolved = path.resolve(this.root, key);
    const rootResolved = path.resolve(this.root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(`object key escapes store root: ${key}`);
    }
    return resolved;
  }

  put(key: string, data: string | Buffer): ObjectRef {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    writeFileAtomic(this.pathFor(key), buf);
    return { key, checksum: sha256Hex(buf), size: buf.length };
  }

  get(key: string, expected?: ObjectRef): Buffer {
    const buf = fs.readFileSync(this.pathFor(key));
    if (expected) {
      const checksum = sha256Hex(buf);
      if (checksum !== expected.checksum) {
        throw new Error(`object ${key} checksum mismatch: ${checksum} != ${expected.checksum}`);
      }
      if (buf.length !== expected.size) {
        throw new Error(`object ${key} size mismatch: ${buf.length} != ${expected.size}`);
      }
    }
    return buf;
  }

  has(key: string): boolean {
    return fs.existsSync(this.pathFor(key));
  }
}

// --------------------------------------------------------------------------- //
// Redaction — "no token / env var / absolute path in artifacts" acceptance criterion.
// --------------------------------------------------------------------------- //

/** Absolute-path prefixes that are host-specific and must never appear in an artifact. */
const HOST_PATH_PREFIXES = [
  '/home/',
  '/Users/',
  '/root/',
  '/workspaces/',
  '/tmp/',
  'C:\\',
  '/var/',
];

/** Token-ish patterns that indicate a leaked secret. */
const SECRET_PATTERNS: RegExp[] = [
  /gh[posu]_[A-Za-z0-9]{16,}/, // GitHub tokens
  /sk-[A-Za-z0-9]{16,}/, // OpenAI-style keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /AKIA[0-9A-Z]{12,}/, // AWS access key id
  /Bearer\s+[A-Za-z0-9._-]{16,}/i, // bearer auth
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private keys
];

/** Env var names whose *values* must never be embedded verbatim. */
const SENSITIVE_ENV_KEYS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'API_KEY',
  'APIKEY',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'CLIENT_SECRET',
  'WEBHOOK_SECRET',
];

/**
 * Scan a JSON-serializable artifact for leaks: host-specific absolute paths, token-like strings, and
 * values equal to a sensitive environment variable. Returns a list of human-readable leak descriptions
 * (empty = clean). `env` is injectable for tests.
 */
export function findArtifactLeaks(
  artifact: unknown,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const leaks: string[] = [];
  const sensitiveValues = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8) continue;
    if (SENSITIVE_ENV_KEYS.some((k) => name.toUpperCase().includes(k))) {
      sensitiveValues.add(value);
    }
  }

  const visit = (node: unknown, pathStr: string): void => {
    if (typeof node === 'string') {
      for (const prefix of HOST_PATH_PREFIXES) {
        if (node.includes(prefix)) {
          leaks.push(`absolute/host path at ${pathStr}: contains "${prefix}"`);
        }
      }
      for (const re of SECRET_PATTERNS) {
        if (re.test(node)) {
          leaks.push(`secret-like token at ${pathStr}`);
        }
      }
      if (sensitiveValues.has(node)) {
        leaks.push(`sensitive env value embedded at ${pathStr}`);
      }
    } else if (Array.isArray(node)) {
      node.forEach((child, i) => visit(child, `${pathStr}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        visit(v, pathStr ? `${pathStr}.${k}` : k);
      }
    }
  };
  visit(artifact, '');
  return leaks;
}

/** Throw if the artifact contains any secret / host-specific leak. */
export function assertArtifactClean(artifact: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const leaks = findArtifactLeaks(artifact, env);
  if (leaks.length > 0) {
    throw new Error(`artifact contains disallowed content:\n  - ${leaks.join('\n  - ')}`);
  }
}

// --------------------------------------------------------------------------- //
// Shard planning — the 先後入替 round-robin.
// --------------------------------------------------------------------------- //

/**
 * Build the shard plan: every unordered pair of contestants, played in BOTH seat orientations
 * (先後入替), optionally split into `chunksPerOrientation` seed-chunks. Shard ids are stable across
 * resume so a re-run maps 1:1 onto the same plan.
 */
export function roundRobinShards(inputs: ContestantInput[], config: RunConfig): ShardSpec[] {
  const chunks = Math.max(1, config.chunksPerOrientation | 0);
  const shards: ShardSpec[] = [];
  let pairIndex = 0;
  for (let i = 0; i < inputs.length; i++) {
    for (let j = i + 1; j < inputs.length; j++) {
      const a = inputs[i].label;
      const b = inputs[j].label;
      // Two orientations: A先手/B後手 and B先手/A後手.
      for (const [seat0, seat1] of [
        [a, b],
        [b, a],
      ] as const) {
        for (let c = 0; c < chunks; c++) {
          const base = `${seat0}-vs-${seat1}`;
          const shardId = chunks > 1 ? `${base}#${c}` : base;
          shards.push({
            shardId,
            seat0,
            seat1,
            matches: config.matchesPerShard,
            // Deterministic per-shard seed: distinct per pairing/orientation/chunk, derived from base.
            seed: config.seed + pairIndex * 1000 + (seat0 === a ? 0 : 500) + c,
          });
        }
      }
      pairIndex++;
    }
  }
  return shards;
}

// --------------------------------------------------------------------------- //
// (tactic × deck) contestant model — SOT-1715.
// --------------------------------------------------------------------------- //

/** A deck drawn from `decks/initial`: a stable id + the content hash of its csv (never a path). */
export interface DeckRef {
  /** Deck id, e.g. `01` — the numeric prefix of the csv filename. */
  deckId: string;
  /** sha256 hex of the deck csv content. */
  deckHash: string;
}

/**
 * Derive a deck id from a `decks/initial` csv filename: the leading numeric token (`01_dragapult.csv`
 * → `01`), falling back to the extension-less basename when there is no numeric prefix. Keeping the
 * short numeric id is what makes contestant labels read as `matsu:01`.
 */
export function deckIdFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  const m = base.match(/^(\d+)/);
  return m ? m[1] : base;
}

/**
 * Enumerate `decks/initial/*.csv` into `DeckRef`s sorted by deckId ascending (numeric-aware), hashing
 * each deck's content. Non-csv files (README.md, manifest.json) are ignored. This is the deck pool the
 * (tactic × deck) matrix is built from; the three sibling repos ship identical decks, so a single
 * enumeration suffices and matsu:01 / take:01 / ume:01 share the same deckHash by construction.
 */
export function enumerateDecks(decksDir: string): DeckRef[] {
  const files = fs.readdirSync(decksDir).filter((f) => f.toLowerCase().endsWith('.csv'));
  const refs: DeckRef[] = files.map((f) => ({
    deckId: deckIdFromFilename(f),
    deckHash: sha256Hex(fs.readFileSync(path.join(decksDir, f))),
  }));
  refs.sort((a, b) => a.deckId.localeCompare(b.deckId, undefined, { numeric: true }));
  return refs;
}

export interface TupleContestantOptions {
  /** The deck pool (typically `enumerateDecks(decksDir)`). */
  decks: DeckRef[];
  /** Resolve the git commit SHA for a tactic's repo (host-path-free). */
  commitForTactic: (tactic: Tactic) => string;
  /** Tactics to cross with the decks; defaults to the three {@link TACTICS}. */
  tactics?: readonly Tactic[];
}

/**
 * Expand tactics × decks into contestants. With the default 3 tactics and 25 decks this yields the
 * **75 contestants** of the full matrix, each labelled `${tactic}:${deckId}` (e.g. `matsu:01`) and
 * carrying its `tactic`, `deckId`, and the deck's `deckHash`. Ordered tactic-major / deck-minor so the
 * plan lists matsu:01…matsu:25, take:01…, ume:… — which also makes same-tactic (mirror) pairs adjacent.
 */
export function buildTupleContestants(opts: TupleContestantOptions): ContestantInput[] {
  const tactics = opts.tactics ?? TACTICS;
  const out: ContestantInput[] = [];
  for (const t of tactics) {
    const commit = opts.commitForTactic(t);
    for (const d of opts.decks) {
      out.push({
        label: `${t.tactic}:${d.deckId}`,
        kanji: t.kanji,
        repo: t.repo,
        commit,
        deckHash: d.deckHash,
        tactic: t.tactic,
        deckId: d.deckId,
      });
    }
  }
  return out;
}

/**
 * Does a contestant match one `tactic:deck` glob pattern? `*` (or empty) on either side is a wildcard,
 * so `matsu:*` matches every matsu deck, `*:01` every tactic's deck 01, `matsu:01` exactly one, and a
 * bare `*` everything. A pattern with no colon (`matsu`) matches by tactic (deck wildcard implied).
 */
export function matchContestant(c: ContestantInput, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (trimmed === '' || trimmed === '*') return true;
  const [tac, deck] = trimmed.split(':');
  const tacOk = tac === '' || tac === '*' || tac === (c.tactic ?? c.label);
  const deckOk = deck === undefined || deck === '' || deck === '*' || deck === c.deckId;
  return tacOk && deckOk;
}

/**
 * Select the subset of contestants matching a comma-separated spec of `tactic:deck` globs
 * (e.g. `matsu:*` or `matsu:01,take:07`). Order follows the input list (not the spec). `*` or an empty
 * spec selects all. Preserves each contestant at most once even if several patterns match it.
 */
export function selectContestants(all: ContestantInput[], spec: string): ContestantInput[] {
  const patterns = spec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (patterns.length === 0) return all.slice();
  return all.filter((c) => patterns.some((p) => matchContestant(c, p)));
}

// --------------------------------------------------------------------------- //
// Manifest lifecycle
// --------------------------------------------------------------------------- //

/** Build a fresh manifest for a run (all shards pending). `now` injected — no Date.now here. */
export function buildManifest(
  runId: string,
  inputs: ContestantInput[],
  config: RunConfig,
  now: string
): Manifest {
  const shards: ShardEntry[] = roundRobinShards(inputs, config).map((s) => ({
    shardId: s.shardId,
    seat0: s.seat0,
    seat1: s.seat1,
    matches: s.matches,
    seed: s.seed,
    status: 'pending',
    gamesRef: null,
    summary: null,
    completedAt: null,
  }));
  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    createdAt: now,
    updatedAt: now,
    config,
    inputs,
    shards,
    aggregate: null,
  };
}

export function manifestPath(dir: string, runId: string): string {
  return path.join(dir, `manifest.${runId}.json`);
}

/** Load a manifest if present, else null. Rejects an incompatible schema version. */
export function loadManifest(dir: string, runId: string): Manifest | null {
  const p = manifestPath(dir, runId);
  if (!fs.existsSync(p)) return null;
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
  const errors = validateManifest(parsed);
  if (errors.length > 0) {
    throw new Error(`manifest ${p} failed validation:\n  - ${errors.join('\n  - ')}`);
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(parsed.schemaVersion)) {
    throw new Error(
      `manifest schema ${parsed.schemaVersion} not supported (expected one of ${SUPPORTED_SCHEMA_VERSIONS.join(', ')})`
    );
  }
  return parsed;
}

/** Persist a manifest atomically after asserting it is clean of secrets/host info. */
export function saveManifest(dir: string, manifest: Manifest, env?: NodeJS.ProcessEnv): void {
  assertArtifactClean(manifest, env ?? process.env);
  writeFileAtomic(manifestPath(dir, manifest.runId), JSON.stringify(manifest, null, 2) + '\n');
}

export function isShardCompleted(manifest: Manifest, shardId: string): boolean {
  const entry = manifest.shards.find((s) => s.shardId === shardId);
  return !!entry && entry.status === 'completed';
}

/** Reduce a shard's raw games into the small tally kept in the manifest. */
export function summarizeGames(games: GameRecord[], seat0: string, seat1: string): ShardSummary {
  const wins: Record<string, number> = { [seat0]: 0, [seat1]: 0 };
  const faults: Record<string, number> = { [seat0]: 0, [seat1]: 0 };
  for (const g of games) {
    if (g.winner === seat0 || g.winner === seat1) {
      wins[g.winner] = (wins[g.winner] ?? 0) + 1;
    }
    if (g.fault) {
      // The loser faulted; charge the fault to whoever is NOT the winner.
      const loser = g.winner === seat0 ? seat1 : seat0;
      faults[loser] = (faults[loser] ?? 0) + 1;
    }
  }
  return { matches: games.length, wins, faults };
}

/**
 * Record a completed shard's result into the manifest: persist raw games to the object store, keep the
 * checksum ref + tally, mark completed. REJECTS re-recording an already-completed shard — this is the
 * duplicate-execution / duplicate-aggregation guard. Returns a NEW manifest (does not mutate input).
 */
export function recordShardResult(
  manifest: Manifest,
  shardId: string,
  result: ShardResult,
  store: ObjectStore,
  now: string
): Manifest {
  const idx = manifest.shards.findIndex((s) => s.shardId === shardId);
  if (idx < 0) throw new Error(`unknown shard: ${shardId}`);
  const entry = manifest.shards[idx];
  if (entry.status === 'completed') {
    throw new Error(`shard ${shardId} already completed; refusing to re-run/re-aggregate`);
  }
  const key = `${manifest.runId}/${shardId}.games.jsonl`;
  const body = result.games.map((g) => JSON.stringify(g)).join('\n') + '\n';
  const gamesRef = store.put(key, body);
  const summary = summarizeGames(result.games, entry.seat0, entry.seat1);
  const shards = manifest.shards.slice();
  shards[idx] = { ...entry, status: 'completed', gamesRef, summary, completedAt: now };
  const next: Manifest = { ...manifest, shards, updatedAt: now };
  next.aggregate = computeAggregate(next);
  return next;
}

// --------------------------------------------------------------------------- //
// Aggregation
// --------------------------------------------------------------------------- //

/** Wilson score 95% CI for a binomial proportion. z=1.96. */
export function wilson95(wins: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { low: (centre - margin) / denom, high: (centre + margin) / denom };
}

/**
 * Aggregate all COMPLETED shards' tallies into standings. Each completed shard contributes exactly once
 * (a shard can only be completed once), so this is inherently duplicate-safe.
 */
export function computeAggregate(manifest: Manifest): Aggregate {
  const wins: Record<string, number> = {};
  const matches: Record<string, number> = {};
  const faults: Record<string, number> = {};
  const kanji: Record<string, string> = {};
  for (const inp of manifest.inputs) {
    wins[inp.label] = 0;
    matches[inp.label] = 0;
    faults[inp.label] = 0;
    kanji[inp.label] = inp.kanji;
  }
  let totalMatches = 0;
  let totalFaults = 0;
  for (const s of manifest.shards) {
    if (s.status !== 'completed' || !s.summary) continue;
    totalMatches += s.summary.matches;
    for (const label of [s.seat0, s.seat1]) {
      matches[label] = (matches[label] ?? 0) + s.summary.matches;
      wins[label] = (wins[label] ?? 0) + (s.summary.wins[label] ?? 0);
      const f = s.summary.faults[label] ?? 0;
      faults[label] = (faults[label] ?? 0) + f;
      totalFaults += f;
    }
  }
  const standings: StandingsRow[] = manifest.inputs
    .map((inp) => {
      const n = matches[inp.label] ?? 0;
      const w = wins[inp.label] ?? 0;
      const ci = wilson95(w, n);
      return {
        label: inp.label,
        kanji: inp.kanji,
        matches: n,
        wins: w,
        losses: n - w,
        faults: faults[inp.label] ?? 0,
        winRate: n === 0 ? 0 : w / n,
        ciLow: ci.low,
        ciHigh: ci.high,
      };
    })
    .sort((a, b) => b.winRate - a.winRate);
  return { totalMatches, totalFaults, standings };
}

// --------------------------------------------------------------------------- //
// Orchestration — the single resumable driver.
// --------------------------------------------------------------------------- //

export interface RunOptions {
  dir: string;
  runId: string;
  inputs: ContestantInput[];
  config: RunConfig;
  store: ObjectStore;
  runner: ShardRunner;
  /** Injected clock — returns an ISO timestamp. Keeps the module deterministic/testable. */
  now: () => string;
  /** Optional per-shard progress callback. */
  onShard?: (shardId: string, action: 'skip' | 'run') => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run (or RESUME) the round-robin. If a manifest for `runId` already exists it is loaded and only
 * pending shards run — completed shards are skipped (never re-run, never re-aggregated). Each shard is
 * persisted atomically right after it finishes, so an interruption at any point leaves a valid manifest
 * that the next invocation resumes from. Returns the final manifest.
 */
export async function runRoundRobin(opts: RunOptions): Promise<Manifest> {
  const { dir, runId, inputs, config, store, runner, now, onShard } = opts;
  let manifest = loadManifest(dir, runId);
  if (!manifest) {
    manifest = buildManifest(runId, inputs, config, now());
    saveManifest(dir, manifest, opts.env);
  }
  const specs = roundRobinShards(manifest.inputs, manifest.config);
  for (const spec of specs) {
    if (isShardCompleted(manifest, spec.shardId)) {
      onShard?.(spec.shardId, 'skip');
      continue;
    }
    onShard?.(spec.shardId, 'run');
    const result = await runner(spec, manifest.inputs);
    manifest = recordShardResult(manifest, spec.shardId, result, store, now());
    saveManifest(dir, manifest, opts.env);
  }
  return manifest;
}

/** Durable state path for the two-phase total-battle driver. */
export function totalBattleStatePath(dir: string, runId: string): string {
  return path.join(dir, `total-battle.${runId}.json`);
}

/**
 * Run (or resume) a cheap all-contestant screen followed by a high-sample top-K confirmation.
 * Each phase uses the normal atomic manifest/object pipeline, so interruption resumes at the first
 * unfinished shard and completed work can neither be rerun nor double-counted.
 */
export async function runTotalBattle(opts: TotalBattleOptions): Promise<{
  state: TotalBattleState;
  screen: Manifest;
  confirm: Manifest;
}> {
  if (opts.inputs.length < 2) throw new Error('total-battle requires at least 2 contestants');
  if (!Number.isInteger(opts.keepTop) || opts.keepTop < 2 || opts.keepTop > opts.inputs.length) {
    throw new Error(`keepTop must be an integer from 2 to ${opts.inputs.length}`);
  }
  const stateFile = totalBattleStatePath(opts.dir, opts.runId);
  let state: TotalBattleState = fs.existsSync(stateFile)
    ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as TotalBattleState)
    : {
        schemaVersion: 'ptcg-total-battle/v1',
        runId: opts.runId,
        phase: 'screen',
        screenRunId: `${opts.runId}-screen`,
        confirmRunId: `${opts.runId}-confirm`,
        keepTop: opts.keepTop,
        selectedLabels: [],
      };
  if (state.runId !== opts.runId || state.keepTop !== opts.keepTop) {
    throw new Error('existing total-battle state does not match run-id/keep-top');
  }
  const common = { deckMode: opts.deckMode, chunksPerOrientation: opts.chunksPerOrientation };
  const screen = await runRoundRobin({
    dir: opts.dir,
    runId: state.screenRunId,
    inputs: opts.inputs,
    config: { ...common, matchesPerShard: opts.screenMatches, seed: opts.seed },
    store: opts.store,
    runner: opts.runner,
    now: opts.now,
    onShard: (id, action) => opts.onShard?.('screen', id, action),
  });
  if (state.selectedLabels.length === 0) {
    state.selectedLabels = screen
      .aggregate!.standings.slice(0, opts.keepTop)
      .map((row) => row.label);
    state.phase = 'confirm';
    writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + '\n');
  }
  const selected = state.selectedLabels.map((label) => {
    const input = opts.inputs.find((candidate) => candidate.label === label);
    if (!input) throw new Error(`selected contestant missing from inputs: ${label}`);
    return input;
  });
  const confirm = await runRoundRobin({
    dir: opts.dir,
    runId: state.confirmRunId,
    inputs: selected,
    config: { ...common, matchesPerShard: opts.confirmMatches, seed: opts.seed + 1_000_000 },
    store: opts.store,
    runner: opts.runner,
    now: opts.now,
    onShard: (id, action) => opts.onShard?.('confirm', id, action),
  });
  state.phase = 'completed';
  writeFileAtomic(stateFile, JSON.stringify(state, null, 2) + '\n');
  return { state, screen, confirm };
}

// --------------------------------------------------------------------------- //
// Schema validation
// --------------------------------------------------------------------------- //

/** Validate a parsed manifest's shape. Returns a list of problems (empty = valid). */
export function validateManifest(obj: unknown): string[] {
  const errors: string[] = [];
  const push = (m: string) => errors.push(m);
  if (!obj || typeof obj !== 'object') return ['manifest is not an object'];
  const m = obj as Record<string, unknown>;
  if (typeof m.schemaVersion !== 'string') push('schemaVersion must be a string');
  if (typeof m.runId !== 'string' || !m.runId) push('runId must be a non-empty string');
  if (typeof m.createdAt !== 'string') push('createdAt must be a string');
  if (typeof m.updatedAt !== 'string') push('updatedAt must be a string');
  const cfg = m.config as Record<string, unknown> | undefined;
  if (!cfg || typeof cfg !== 'object') {
    push('config must be an object');
  } else {
    if (typeof cfg.matchesPerShard !== 'number' || cfg.matchesPerShard <= 0)
      push('config.matchesPerShard must be a positive number');
    if (typeof cfg.seed !== 'number') push('config.seed must be a number');
    if (typeof cfg.deckMode !== 'string') push('config.deckMode must be a string');
    if (typeof cfg.chunksPerOrientation !== 'number')
      push('config.chunksPerOrientation must be a number');
  }
  if (!Array.isArray(m.inputs) || m.inputs.length === 0) {
    push('inputs must be a non-empty array');
  } else {
    m.inputs.forEach((inp, i) => {
      const c = inp as Record<string, unknown>;
      if (typeof c.label !== 'string') push(`inputs[${i}].label must be a string`);
      if (typeof c.commit !== 'string' || !c.commit)
        push(`inputs[${i}].commit must be a non-empty string`);
      if (typeof c.deckHash !== 'string' || !c.deckHash)
        push(`inputs[${i}].deckHash must be a non-empty string`);
    });
  }
  if (!Array.isArray(m.shards)) {
    push('shards must be an array');
  } else {
    const seen = new Set<string>();
    m.shards.forEach((s, i) => {
      const e = s as Record<string, unknown>;
      if (typeof e.shardId !== 'string') {
        push(`shards[${i}].shardId must be a string`);
      } else if (seen.has(e.shardId)) {
        push(`duplicate shardId: ${e.shardId}`);
      } else {
        seen.add(e.shardId);
      }
      if (e.status !== 'pending' && e.status !== 'completed')
        push(`shards[${i}].status must be pending|completed`);
      if (e.status === 'completed') {
        if (!e.gamesRef || typeof e.gamesRef !== 'object')
          push(`shards[${i}] completed but missing gamesRef`);
        else {
          const ref = e.gamesRef as Record<string, unknown>;
          if (typeof ref.checksum !== 'string' || typeof ref.size !== 'number')
            push(`shards[${i}].gamesRef must have checksum + size`);
        }
        if (!e.summary || typeof e.summary !== 'object')
          push(`shards[${i}] completed but missing summary`);
      }
    });
  }
  return errors;
}
