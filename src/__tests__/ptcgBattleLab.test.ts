// SOT-1713: tests for the resumable 松竹梅 round-robin artifact pipeline (src/lib/ptcgBattleLab.ts).
//
// Covers the full 検証内容: fixture preflight → battle → artifact integration, and the
// interruption / resume / duplicate-rejection / atomicity / schema-validation / redaction paths.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTESTANTS,
  LocalObjectStore,
  SCHEMA_VERSION,
  TACTICS,
  assertArtifactClean,
  buildManifest,
  buildTupleContestants,
  deckIdFromFilename,
  enumerateDecks,
  findArtifactLeaks,
  isShardCompleted,
  loadManifest,
  manifestPath,
  matchContestant,
  recordShardResult,
  roundRobinShards,
  runRoundRobin,
  runTotalBattle,
  saveManifest,
  selectContestants,
  sha256Hex,
  summarizeGames,
  validateManifest,
  wilson95,
  writeFileAtomic,
  type ContestantInput,
  type GameRecord,
  type RunConfig,
  type ShardRunner,
  type ShardSpec,
} from '../lib/ptcgBattleLab.js';

const NOW = '2026-07-18T06:00:00.000Z';
const CONFIG: RunConfig = {
  matchesPerShard: 10,
  seed: 42,
  deckMode: 'own',
  chunksPerOrientation: 1,
};

function inputs(): ContestantInput[] {
  return CONTESTANTS.map((c, i) => ({
    label: c.label,
    kanji: c.kanji,
    repo: c.repo,
    commit: `commit${i}${'a'.repeat(38)}`,
    deckHash: sha256Hex(`deck-${c.label}`),
  }));
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ptcg-lab-'));
}

/** Deterministic runner: seat0 always wins the first `seat0Wins` matches, remainder to seat1. */
function fixedRunner(seat0WinsCount: number, faultEvery = 0): ShardRunner {
  return async (shard: ShardSpec) => {
    const games: GameRecord[] = [];
    for (let i = 0; i < shard.matches; i++) {
      const winner = i < seat0WinsCount ? shard.seat0 : shard.seat1;
      games.push({
        shardId: shard.shardId,
        matchIndex: i,
        seat0: shard.seat0,
        seat1: shard.seat1,
        winner,
        fault: faultEvery > 0 && i % faultEvery === 0,
      });
    }
    return { games };
  };
}

describe('roundRobinShards — 先後入替 round-robin', () => {
  it('produces every pair in both seat orientations, with unique ids', () => {
    const shards = roundRobinShards(inputs(), CONFIG);
    // 3 contestants → 3 pairs × 2 orientations = 6 shards.
    expect(shards).toHaveLength(6);
    const ids = shards.map((s) => s.shardId).sort();
    expect(ids).toEqual(
      [
        'matsu-vs-take',
        'take-vs-matsu',
        'matsu-vs-ume',
        'ume-vs-matsu',
        'take-vs-ume',
        'ume-vs-take',
      ].sort()
    );
    // Every shard has distinct seats and the configured match count.
    for (const s of shards) {
      expect(s.seat0).not.toEqual(s.seat1);
      expect(s.matches).toBe(CONFIG.matchesPerShard);
    }
    // Both orientations of a pair exist (seat swap).
    expect(shards.find((s) => s.seat0 === 'matsu' && s.seat1 === 'take')).toBeTruthy();
    expect(shards.find((s) => s.seat0 === 'take' && s.seat1 === 'matsu')).toBeTruthy();
  });

  it('multiplies shards by chunksPerOrientation with distinct seeds', () => {
    const shards = roundRobinShards(inputs(), { ...CONFIG, chunksPerOrientation: 3 });
    expect(shards).toHaveLength(18);
    const seeds = new Set(shards.map((s) => s.seed));
    expect(seeds.size).toBe(18); // all seeds distinct
    expect(shards.some((s) => s.shardId === 'matsu-vs-take#0')).toBe(true);
    expect(shards.some((s) => s.shardId === 'matsu-vs-take#2')).toBe(true);
  });
});

describe('runTotalBattle — staged screen → confirm', () => {
  function matrixInputs(): ContestantInput[] {
    return Array.from({ length: 75 }, (_, i) => ({
      label: `matsu:${String(i + 1).padStart(2, '0')}`,
      kanji: `松/${i + 1}`,
      repo: 'ptcg-agent-matsu',
      commit: 'a'.repeat(40),
      deckHash: sha256Hex(`deck-${i + 1}`),
      tactic: 'matsu',
      deckId: String(i + 1).padStart(2, '0'),
    }));
  }

  it('screens all 75 at small N, confirms only top-K at high N, and resumes without duplicates', async () => {
    const dir = tmpDir();
    const all = matrixInputs();
    const store = new LocalObjectStore(path.join(dir, 'obj'));
    const screenIds = new Set<string>();
    const confirmIds = new Set<string>();
    const runner: ShardRunner = async (shard) => {
      const games = Array.from(
        { length: shard.matches },
        (_, matchIndex): GameRecord => ({
          shardId: shard.shardId,
          matchIndex,
          seat0: shard.seat0,
          seat1: shard.seat1,
          winner:
            Number(shard.seat0.split(':')[1]) < Number(shard.seat1.split(':')[1])
              ? shard.seat0
              : shard.seat1,
          fault: false,
        })
      );
      return { games };
    };
    const opts = {
      dir,
      runId: 'total',
      inputs: all,
      screenMatches: 1,
      confirmMatches: 7,
      keepTop: 5,
      seed: 10,
      chunksPerOrientation: 1,
      deckMode: 'matrix',
      store,
      runner,
      now: () => NOW,
      onShard: (phase: 'screen' | 'confirm', id: string, action: 'run' | 'skip') => {
        if (action === 'run') (phase === 'screen' ? screenIds : confirmIds).add(id);
      },
    };
    const first = await runTotalBattle(opts);
    expect(first.screen.inputs).toHaveLength(75);
    expect(first.screen.shards).toHaveLength(75 * 74);
    expect(first.screen.shards.every((s) => s.matches === 1)).toBe(true);
    expect(first.confirm.inputs).toHaveLength(5);
    expect(first.confirm.shards).toHaveLength(5 * 4);
    expect(first.confirm.shards.every((s) => s.matches === 7)).toBe(true);
    expect(first.state.selectedLabels).toHaveLength(5);
    expect(screenIds.size).toBe(75 * 74);
    expect(confirmIds.size).toBe(5 * 4);

    screenIds.clear();
    confirmIds.clear();
    const resumed = await runTotalBattle(opts);
    expect(screenIds.size).toBe(0);
    expect(confirmIds.size).toBe(0);
    expect(resumed.confirm.aggregate).toEqual(first.confirm.aggregate);
  });
});

describe('writeFileAtomic', () => {
  it('writes content and leaves no temp file behind', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'sub', 'a.json');
    writeFileAtomic(f, 'hello');
    expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    const leftovers = fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('LocalObjectStore', () => {
  it('put returns checksum/size and get verifies them', () => {
    const store = new LocalObjectStore(tmpDir());
    const ref = store.put('run/x.jsonl', 'line1\nline2\n');
    expect(ref.checksum).toBe(sha256Hex('line1\nline2\n'));
    expect(ref.size).toBe(Buffer.byteLength('line1\nline2\n'));
    expect(store.get('run/x.jsonl', ref).toString('utf8')).toBe('line1\nline2\n');
  });

  it('get throws on checksum mismatch', () => {
    const store = new LocalObjectStore(tmpDir());
    const ref = store.put('k', 'data');
    expect(() => store.get('k', { ...ref, checksum: 'deadbeef' })).toThrow(/checksum mismatch/);
  });

  it('rejects keys that escape the store root', () => {
    const store = new LocalObjectStore(tmpDir());
    expect(() => store.put('../escape', 'x')).toThrow(/escapes store root/);
  });
});

describe('redaction — no secret / host info in artifacts', () => {
  it('flags host-specific absolute paths', () => {
    const leaks = findArtifactLeaks({ note: '/workspaces/ptcg-agent-matsu/deck.csv' }, {});
    expect(leaks.some((l) => l.includes('absolute/host path'))).toBe(true);
  });

  it('flags token-like strings', () => {
    const leaks = findArtifactLeaks({ t: 'ghp_' + 'a'.repeat(30) }, {});
    expect(leaks.some((l) => l.includes('secret-like token'))).toBe(true);
  });

  it('flags embedded sensitive env values', () => {
    const env = { GITHUB_TOKEN: 'supersecretvalue123' };
    const leaks = findArtifactLeaks({ embedded: 'supersecretvalue123' }, env);
    expect(leaks.some((l) => l.includes('sensitive env value'))).toBe(true);
  });

  it('passes a clean artifact (repo names + hashes only)', () => {
    expect(
      findArtifactLeaks({ repo: 'ptcg-agent-matsu', commit: 'abc123', deckHash: 'ff00' }, {})
    ).toEqual([]);
    expect(() => assertArtifactClean({ repo: 'ptcg-agent-take' }, {})).not.toThrow();
  });

  it('saveManifest refuses to persist a manifest that leaks a host path', () => {
    const dir = tmpDir();
    const m = buildManifest('r1', inputs(), CONFIG, NOW);
    (m.inputs[0] as unknown as { repo: string }).repo = '/workspaces/ptcg-agent-matsu';
    expect(() => saveManifest(dir, m, {})).toThrow(/disallowed content/);
  });
});

describe('manifest lifecycle + schema validation', () => {
  it('builds a manifest with all shards pending and the current schema version', () => {
    const m = buildManifest('r1', inputs(), CONFIG, NOW);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.shards).toHaveLength(6);
    expect(m.shards.every((s) => s.status === 'pending')).toBe(true);
    expect(validateManifest(m)).toEqual([]);
  });

  it('round-trips through save/load atomically', () => {
    const dir = tmpDir();
    const m = buildManifest('r1', inputs(), CONFIG, NOW);
    saveManifest(dir, m, {});
    expect(fs.existsSync(manifestPath(dir, 'r1'))).toBe(true);
    const loaded = loadManifest(dir, 'r1');
    expect(loaded).toEqual(m);
  });

  it('loadManifest rejects an incompatible schema version', () => {
    const dir = tmpDir();
    const m = buildManifest('r1', inputs(), CONFIG, NOW);
    m.schemaVersion = 'ptcg-battle-lab/v0';
    writeFileAtomic(manifestPath(dir, 'r1'), JSON.stringify(m));
    expect(() => loadManifest(dir, 'r1')).toThrow(/schema/);
  });

  it('validateManifest catches structural problems', () => {
    expect(validateManifest(null)).toContain('manifest is not an object');
    const bad = buildManifest('r1', inputs(), CONFIG, NOW);
    bad.shards[0].shardId = bad.shards[1].shardId; // duplicate id
    expect(validateManifest(bad).some((e) => e.includes('duplicate shardId'))).toBe(true);
  });

  it('flags a completed shard missing its gamesRef/summary', () => {
    const m = buildManifest('r1', inputs(), CONFIG, NOW);
    m.shards[0].status = 'completed';
    const errs = validateManifest(m);
    expect(errs.some((e) => e.includes('missing gamesRef'))).toBe(true);
    expect(errs.some((e) => e.includes('missing summary'))).toBe(true);
  });
});

describe('summarizeGames + aggregation', () => {
  it('tallies wins and faults per contestant', () => {
    const games = fixedRunnerGames('matsu', 'take', 10, 7, 5); // seat0=matsu wins 7, fault every 5
    const summary = summarizeGames(games, 'matsu', 'take');
    expect(summary.matches).toBe(10);
    expect(summary.wins.matsu).toBe(7);
    expect(summary.wins.take).toBe(3);
    // faults every 5th match (indices 0,5) charged to that match's loser.
    expect(summary.faults.matsu + summary.faults.take).toBe(2);
  });

  it('aggregates each completed shard exactly once', async () => {
    const dir = tmpDir();
    const store = new LocalObjectStore(path.join(dir, 'obj'));
    const m = await runRoundRobin({
      dir,
      runId: 'agg',
      inputs: inputs(),
      config: CONFIG,
      store,
      runner: fixedRunner(6),
      now: () => NOW,
    });
    const agg = m.aggregate!;
    // 6 shards × 10 matches, each match counts for its two seats → total seat-matches = 6*10.
    expect(agg.totalMatches).toBe(60);
    // Each contestant plays in 4 shards (2 opponents × 2 orientations) → 40 matches each.
    for (const row of agg.standings) {
      expect(row.matches).toBe(40);
      expect(row.wins + row.losses).toBe(40);
    }
    // Standings sorted by winRate desc.
    expect(agg.standings[0].winRate).toBeGreaterThanOrEqual(agg.standings[1].winRate);
  });
});

describe('wilson95', () => {
  it('returns [0,0] for n=0 and a bounded interval otherwise', () => {
    expect(wilson95(0, 0)).toEqual({ low: 0, high: 0 });
    const ci = wilson95(50, 100);
    expect(ci.low).toBeGreaterThan(0.39);
    expect(ci.high).toBeLessThan(0.61);
  });
});

describe('recordShardResult — duplicate rejection', () => {
  it('refuses to record an already-completed shard', () => {
    const store = new LocalObjectStore(path.join(tmpDir(), 'obj'));
    let m = buildManifest('dup', inputs(), CONFIG, NOW);
    const shardId = m.shards[0].shardId;
    const games = fixedRunnerGames(m.shards[0].seat0, m.shards[0].seat1, 10, 5, 0);
    m = recordShardResult(m, shardId, { games }, store, NOW);
    expect(isShardCompleted(m, shardId)).toBe(true);
    expect(() => recordShardResult(m, shardId, { games }, store, NOW)).toThrow(
      /already completed; refusing/
    );
  });
});

describe('interruption + resume', () => {
  it('resumes after an interruption without re-running or double-counting completed shards', async () => {
    const dir = tmpDir();
    const store = new LocalObjectStore(path.join(dir, 'obj'));
    const runId = 'resume1';

    // First attempt: runner throws on the 3rd shard to simulate an interruption.
    const ranFirst: string[] = [];
    let n = 0;
    const flaky: ShardRunner = async (shard) => {
      if (n++ === 2) throw new Error('boom (interrupted)');
      ranFirst.push(shard.shardId);
      return fixedRunner(6)(shard, inputs());
    };
    await expect(
      runRoundRobin({
        dir,
        runId,
        inputs: inputs(),
        config: CONFIG,
        store,
        runner: flaky,
        now: () => NOW,
      })
    ).rejects.toThrow(/boom/);

    // The on-disk manifest is valid and has exactly the 2 completed shards.
    const mid = loadManifest(dir, runId)!;
    expect(validateManifest(mid)).toEqual([]);
    const completedMid = mid.shards.filter((s) => s.status === 'completed').map((s) => s.shardId);
    expect(completedMid.sort()).toEqual(ranFirst.sort());
    expect(completedMid).toHaveLength(2);

    // Second attempt: a runner that FAILS if asked to re-run an already-completed shard.
    const ranSecond: string[] = [];
    const strict: ShardRunner = async (shard) => {
      if (completedMid.includes(shard.shardId)) {
        throw new Error(`re-ran completed shard ${shard.shardId}`);
      }
      ranSecond.push(shard.shardId);
      return fixedRunner(6)(shard, inputs());
    };
    const final = await runRoundRobin({
      dir,
      runId,
      inputs: inputs(),
      config: CONFIG,
      store,
      runner: strict,
      now: () => NOW,
    });

    // All 6 shards completed; the second attempt only ran the 4 remaining shards.
    expect(final.shards.every((s) => s.status === 'completed')).toBe(true);
    expect(ranSecond).toHaveLength(4);
    expect(ranSecond.some((id) => completedMid.includes(id))).toBe(false);

    // No double-counting: each contestant still shows exactly 40 matches.
    for (const row of final.aggregate!.standings) {
      expect(row.matches).toBe(40);
    }
  });

  it('a fresh run and a resumed run yield the same aggregate (idempotent completion)', async () => {
    const cfg = { ...CONFIG, matchesPerShard: 8 };
    // Fresh, uninterrupted.
    const dirA = tmpDir();
    const a = await runRoundRobin({
      dir: dirA,
      runId: 'A',
      inputs: inputs(),
      config: cfg,
      store: new LocalObjectStore(path.join(dirA, 'obj')),
      runner: fixedRunner(5),
      now: () => NOW,
    });
    // Resumed: run once (completes), then invoke again — should skip everything and be identical.
    const dirB = tmpDir();
    const opts = {
      dir: dirB,
      runId: 'B',
      inputs: inputs(),
      config: cfg,
      store: new LocalObjectStore(path.join(dirB, 'obj')),
      runner: fixedRunner(5),
      now: () => NOW,
    };
    await runRoundRobin(opts);
    const skips: string[] = [];
    const b = await runRoundRobin({
      ...opts,
      onShard: (id, act) => act === 'skip' && skips.push(id),
    });
    expect(skips).toHaveLength(6); // all skipped on the second invocation
    expect(b.aggregate!.standings.map((s) => [s.label, s.wins, s.matches])).toEqual(
      a.aggregate!.standings.map((s) => [s.label, s.wins, s.matches])
    );
  });
});

/** Create a fixture decks/initial dir with `n` numbered csvs plus non-deck files (README/manifest). */
function fixtureDecksDir(n: number): string {
  const dir = tmpDir();
  for (let i = 1; i <= n; i++) {
    const id = String(i).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${id}_deck_${id}.csv`), `card-${id},4\n`);
  }
  // Non-csv files must be ignored by enumeration.
  fs.writeFileSync(path.join(dir, 'README.md'), '# decks');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  return dir;
}

describe('(tactic × deck) contestant model — SOT-1715', () => {
  it('deckIdFromFilename takes the numeric prefix, else the basename', () => {
    expect(deckIdFromFilename('01_dragapult.csv')).toBe('01');
    expect(deckIdFromFilename('25_mega_lopunny_ex.csv')).toBe('25');
    expect(deckIdFromFilename('/abs/path/07_foo.csv')).toBe('07');
    expect(deckIdFromFilename('custom.csv')).toBe('custom');
  });

  it('enumerateDecks lists only *.csv, sorted numerically, with content hashes', () => {
    const dir = fixtureDecksDir(25);
    const decks = enumerateDecks(dir);
    expect(decks).toHaveLength(25); // README.md / manifest.json ignored
    expect(decks.map((d) => d.deckId)).toEqual(
      Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(2, '0'))
    );
    expect(decks[0].deckHash).toBe(sha256Hex('card-01,4\n'));
  });

  it('buildTupleContestants expands 3 tactics × 25 decks into 75 labelled contestants', () => {
    const decks = enumerateDecks(fixtureDecksDir(25));
    const contestants = buildTupleContestants({
      decks,
      commitForTactic: (t) => `commit-${t.tactic}`,
    });
    expect(contestants).toHaveLength(75);
    // First 25 are matsu (tactic-major ordering), each carrying tactic + deckId + deckHash.
    expect(contestants[0]).toMatchObject({
      label: 'matsu:01',
      tactic: 'matsu',
      kanji: '松',
      deckId: '01',
    });
    expect(contestants[24].label).toBe('matsu:25');
    expect(contestants[25]).toMatchObject({ label: 'take:01', tactic: 'take', kanji: '竹' });
    expect(contestants[74]).toMatchObject({ label: 'ume:25', tactic: 'ume', kanji: '梅' });
    // matsu:01 / take:01 / ume:01 share the same deck → same deckHash.
    const deck01 = contestants.filter((c) => c.deckId === '01').map((c) => c.deckHash);
    expect(new Set(deck01).size).toBe(1);
    expect(contestants.every((c) => c.commit === `commit-${c.tactic}`)).toBe(true);
  });

  it('roundRobinShards over 75 contestants yields C(75,2)*2 shards including same-tactic mirrors', () => {
    const decks = enumerateDecks(fixtureDecksDir(25));
    const contestants = buildTupleContestants({ decks, commitForTactic: () => 'c'.repeat(40) });
    const shards = roundRobinShards(contestants, CONFIG);
    // C(75,2) unordered pairs × 2 seat orientations.
    expect(shards).toHaveLength(((75 * 74) / 2) * 2);
    const ids = new Set(shards.map((s) => s.shardId));
    expect(ids.size).toBe(shards.length); // all shard ids unique
    // Same-tactic mirror shard (different deck) is present in both orientations.
    expect(ids.has('matsu:01-vs-matsu:02')).toBe(true);
    expect(ids.has('matsu:02-vs-matsu:01')).toBe(true);
    // Cross-tactic shard present too.
    expect(ids.has('matsu:01-vs-take:01')).toBe(true);
  });

  it('the built matrix aggregates end-to-end through the fixture runner (mirror shards included)', async () => {
    const decks = enumerateDecks(fixtureDecksDir(3)); // keep it small: 3 tactics × 3 decks = 9 contestants
    const contestants = buildTupleContestants({ decks, commitForTactic: () => 'c'.repeat(40) });
    expect(contestants).toHaveLength(9);
    const dir = tmpDir();
    const m = await runRoundRobin({
      dir,
      runId: 'matrix',
      inputs: contestants,
      config: { ...CONFIG, matchesPerShard: 4 },
      store: new LocalObjectStore(path.join(dir, 'obj')),
      runner: fixedRunner(3),
      now: () => NOW,
    });
    expect(m.shards).toHaveLength(((9 * 8) / 2) * 2);
    expect(m.shards.every((s) => s.status === 'completed')).toBe(true);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    // A same-tactic mirror shard actually ran and produced a summary.
    const mirror = m.shards.find((s) => s.shardId === 'matsu:01-vs-matsu:02');
    expect(mirror?.summary?.matches).toBe(4);
    // Every contestant is represented in the standings.
    expect(m.aggregate!.standings).toHaveLength(9);
  });
});

describe('selectContestants — subset globs', () => {
  const decks = enumerateDecks(fixtureDecksDir(25));
  const all = buildTupleContestants({
    decks,
    commitForTactic: (t) => `c-${t.tactic}`.padEnd(8, 'x'),
  });

  it('matches a single tactic wildcard', () => {
    const matsu = selectContestants(all, 'matsu:*');
    expect(matsu).toHaveLength(25);
    expect(matsu.every((c) => c.tactic === 'matsu')).toBe(true);
  });

  it('matches an explicit comma list', () => {
    const picked = selectContestants(all, 'matsu:01,take:07');
    expect(picked.map((c) => c.label)).toEqual(['matsu:01', 'take:07']);
  });

  it('matches a single exact label and a deck wildcard across tactics', () => {
    expect(selectContestants(all, 'ume:25').map((c) => c.label)).toEqual(['ume:25']);
    const deck01 = selectContestants(all, '*:01');
    expect(deck01.map((c) => c.label)).toEqual(['matsu:01', 'take:01', 'ume:01']);
  });

  it('* / empty spec selects everyone; unknown selects none; no duplicates when patterns overlap', () => {
    expect(selectContestants(all, '*')).toHaveLength(75);
    expect(selectContestants(all, '')).toHaveLength(75);
    expect(selectContestants(all, 'nope:99')).toHaveLength(0);
    // Overlapping patterns (matsu:* also covers matsu:01) must not double-list a contestant.
    expect(selectContestants(all, 'matsu:*,matsu:01')).toHaveLength(25);
  });

  it('matchContestant treats a bare tactic (no colon) as a tactic match', () => {
    expect(matchContestant(all[0], 'matsu')).toBe(true); // matsu:01
    expect(matchContestant(all[25], 'matsu')).toBe(false); // take:01
  });
});

describe('backward compatibility — v1 manifest is still readable (SOT-1715)', () => {
  it('TACTICS mirrors CONTESTANTS', () => {
    expect(TACTICS.map((t) => t.tactic)).toEqual(CONTESTANTS.map((c) => c.label));
    expect(TACTICS.map((t) => t.kanji)).toEqual(CONTESTANTS.map((c) => c.kanji));
  });

  it('loadManifest reads a legacy v1 own-deck manifest (inputs without tactic/deckId)', () => {
    const dir = tmpDir();
    // A v1 manifest: 3 own-deck contestants, schemaVersion pinned to v1, no tactic/deckId on inputs.
    const m = buildManifest('legacy', inputs(), CONFIG, NOW);
    m.schemaVersion = 'ptcg-battle-lab/v1';
    expect(m.inputs.every((i) => i.tactic === undefined && i.deckId === undefined)).toBe(true);
    expect(validateManifest(m)).toEqual([]);
    writeFileAtomic(manifestPath(dir, 'legacy'), JSON.stringify(m, null, 2));
    const loaded = loadManifest(dir, 'legacy');
    expect(loaded!.schemaVersion).toBe('ptcg-battle-lab/v1');
    expect(loaded!.shards).toHaveLength(6);
  });

  it('a v1 own-deck run resumes unchanged (labels/shard ids identical to before the bump)', async () => {
    const dir = tmpDir();
    const store = new LocalObjectStore(path.join(dir, 'obj'));
    // Seed a manifest at v1 on disk, then resume it — completed shards must map 1:1.
    let m = buildManifest('resumeV1', inputs(), CONFIG, NOW);
    m = recordShardResult(
      m,
      m.shards[0].shardId,
      { games: fixedRunnerGames(m.shards[0].seat0, m.shards[0].seat1, 10, 6, 0) },
      store,
      NOW
    );
    m.schemaVersion = 'ptcg-battle-lab/v1';
    writeFileAtomic(manifestPath(dir, 'resumeV1'), JSON.stringify(m, null, 2));
    const skips: string[] = [];
    const final = await runRoundRobin({
      dir,
      runId: 'resumeV1',
      inputs: inputs(),
      config: CONFIG,
      store,
      runner: fixedRunner(6),
      now: () => NOW,
      onShard: (id, act) => act === 'skip' && skips.push(id),
    });
    expect(skips).toEqual([m.shards[0].shardId]); // the pre-completed shard is skipped, not re-run
    expect(final.shards.every((s) => s.status === 'completed')).toBe(true);
  });
});

// Helper: produce raw game records directly for tally tests.
function fixedRunnerGames(
  seat0: string,
  seat1: string,
  matches: number,
  seat0Wins: number,
  faultEvery: number
): GameRecord[] {
  const games: GameRecord[] = [];
  for (let i = 0; i < matches; i++) {
    games.push({
      shardId: `${seat0}-vs-${seat1}`,
      matchIndex: i,
      seat0,
      seat1,
      winner: i < seat0Wins ? seat0 : seat1,
      fault: faultEvery > 0 && i % faultEvery === 0,
    });
  }
  return games;
}
