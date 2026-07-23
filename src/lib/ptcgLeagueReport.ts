import fs from 'node:fs';
import path from 'node:path';

export const LEAGUE_CHECKPOINT_SCHEMA = 'ptcg-league-checkpoint/v1' as const;

export type LeagueOutcome = 'first' | 'second' | 'draw' | 'fault' | 'unfinished';

export interface LeagueMatchEvent {
  matchId: string;
  first: string;
  second: string;
  outcome: LeagueOutcome;
  fault?: { seat: 'first' | 'second'; kind: string; code: string };
  thinkTimeMs?: { first: number; second: number };
  /** Full real-process match duration, used by runtime budget audits. */
  durationMs?: number;
  /** Non-invasive real-runtime phase telemetry. Older checkpoints omit it. */
  timingMs?: {
    processStartup: { first: number; second: number };
    request: { first: number; second: number };
    inference: { first: number; second: number };
    engine: number;
  };
}

export interface LeagueCheckpoint {
  schemaVersion: typeof LEAGUE_CHECKPOINT_SCHEMA;
  leagueId: string;
  plannedMatchIds: string[];
  events: LeagueMatchEvent[];
}

export interface WilsonInterval {
  low: number;
  high: number;
}
export interface MatchupRow {
  first: string;
  second: string;
  wins: { first: number; second: number };
  draws: number;
  faults: number;
  unfinished: number;
  decided: number;
  firstWinRate: number | null;
  firstWinWilson95: WilsonInterval | null;
  firstSeatAdvantage: number | null;
  thinkTimeMs: { firstAverage: number | null; secondAverage: number | null };
}

export interface LeagueReport {
  schemaVersion: 'ptcg-league-report/v1';
  leagueId: string;
  planned: number;
  recorded: number;
  duplicateMatchIds: string[];
  missingMatchIds: string[];
  unknownMatchIds: string[];
  totals: { decided: number; draws: number; faults: number; unfinished: number };
  matchups: MatchupRow[];
}

function atomicWrite(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}

function assertCheckpoint(value: LeagueCheckpoint): void {
  if (value.schemaVersion !== LEAGUE_CHECKPOINT_SCHEMA)
    throw new Error('unsupported checkpoint schema');
  if (!value.leagueId) throw new Error('checkpoint leagueId is required');
  if (new Set(value.plannedMatchIds).size !== value.plannedMatchIds.length)
    throw new Error('checkpoint contains duplicate planned match ids');
}

export function createLeagueCheckpoint(
  leagueId: string,
  plannedMatchIds: string[]
): LeagueCheckpoint {
  const checkpoint: LeagueCheckpoint = {
    schemaVersion: LEAGUE_CHECKPOINT_SCHEMA,
    leagueId,
    plannedMatchIds: [...plannedMatchIds],
    events: [],
  };
  assertCheckpoint(checkpoint);
  return checkpoint;
}

export function loadLeagueCheckpoint(file: string): LeagueCheckpoint {
  const checkpoint = JSON.parse(fs.readFileSync(file, 'utf8')) as LeagueCheckpoint;
  assertCheckpoint(checkpoint);
  return checkpoint;
}

export function saveLeagueCheckpoint(file: string, checkpoint: LeagueCheckpoint): void {
  assertCheckpoint(checkpoint);
  atomicWrite(file, `${JSON.stringify(checkpoint, null, 2)}\n`);
}

/** Executes only missing matches and checkpoints atomically after every completed match. */
export async function resumeLeague(
  file: string,
  leagueId: string,
  plannedMatchIds: string[],
  runMatch: (matchId: string) => Promise<LeagueMatchEvent>
): Promise<LeagueCheckpoint> {
  const checkpoint = fs.existsSync(file)
    ? loadLeagueCheckpoint(file)
    : createLeagueCheckpoint(leagueId, plannedMatchIds);
  if (
    checkpoint.leagueId !== leagueId ||
    JSON.stringify(checkpoint.plannedMatchIds) !== JSON.stringify(plannedMatchIds)
  )
    throw new Error('checkpoint does not match league plan');
  const completed = new Set(checkpoint.events.map((event) => event.matchId));
  for (const matchId of plannedMatchIds) {
    if (completed.has(matchId)) continue;
    const event = await runMatch(matchId);
    if (event.matchId !== matchId)
      throw new Error(`runner returned unexpected match id: ${event.matchId}`);
    checkpoint.events.push(event);
    completed.add(matchId);
    saveLeagueCheckpoint(file, checkpoint);
  }
  return checkpoint;
}

export function wilson95(wins: number, total: number): WilsonInterval | null {
  if (total === 0) return null;
  const z = 1.96;
  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: center - margin, high: center + margin };
}

export function aggregateLeague(checkpoint: LeagueCheckpoint): LeagueReport {
  assertCheckpoint(checkpoint);
  const counts = new Map<string, number>();
  checkpoint.events.forEach((event) =>
    counts.set(event.matchId, (counts.get(event.matchId) ?? 0) + 1)
  );
  const planned = new Set(checkpoint.plannedMatchIds);
  const duplicateMatchIds = [...counts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const missingMatchIds = checkpoint.plannedMatchIds.filter((id) => !counts.has(id));
  const unknownMatchIds = [...counts.keys()].filter((id) => !planned.has(id)).sort();
  const groups = new Map<string, LeagueMatchEvent[]>();
  for (const event of checkpoint.events) {
    const agents = [event.first, event.second].sort();
    const key = `${agents[0]}\u0000${agents[1]}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  const totals = { decided: 0, draws: 0, faults: 0, unfinished: 0 };
  const matchups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, events]) => {
      const [first, second] = [events[0].first, events[0].second].sort();
      let firstWins = 0,
        secondWins = 0,
        draws = 0,
        faults = 0,
        unfinished = 0;
      let firstSeatWins = 0,
        firstSeatDecided = 0,
        secondSeatWins = 0,
        secondSeatDecided = 0;
      let firstThink = 0,
        firstThinkN = 0,
        secondThink = 0,
        secondThinkN = 0;
      for (const event of events) {
        if (event.thinkTimeMs) {
          firstThink += event.first === first ? event.thinkTimeMs.first : event.thinkTimeMs.second;
          secondThink +=
            event.first === second ? event.thinkTimeMs.first : event.thinkTimeMs.second;
          firstThinkN++;
          secondThinkN++;
        }
        if (event.outcome === 'fault') {
          faults++;
          continue;
        }
        if (event.outcome === 'unfinished') {
          unfinished++;
          continue;
        }
        if (event.outcome === 'draw') {
          draws++;
          continue;
        }
        const winner = event.outcome === 'first' ? event.first : event.second;
        if (winner === first) firstWins++;
        else secondWins++;
        if (event.first === first) {
          firstSeatDecided++;
          if (winner === first) firstSeatWins++;
        } else {
          secondSeatDecided++;
          if (winner === first) secondSeatWins++;
        }
      }
      const decided = firstWins + secondWins;
      totals.decided += decided;
      totals.draws += draws;
      totals.faults += faults;
      totals.unfinished += unfinished;
      return {
        first,
        second,
        wins: { first: firstWins, second: secondWins },
        draws,
        faults,
        unfinished,
        decided,
        firstWinRate: decided ? firstWins / decided : null,
        firstWinWilson95: wilson95(firstWins, decided),
        firstSeatAdvantage:
          firstSeatDecided && secondSeatDecided
            ? firstSeatWins / firstSeatDecided - secondSeatWins / secondSeatDecided
            : null,
        thinkTimeMs: {
          firstAverage: firstThinkN ? firstThink / firstThinkN : null,
          secondAverage: secondThinkN ? secondThink / secondThinkN : null,
        },
      } satisfies MatchupRow;
    });
  return {
    schemaVersion: 'ptcg-league-report/v1',
    leagueId: checkpoint.leagueId,
    planned: checkpoint.plannedMatchIds.length,
    recorded: checkpoint.events.length,
    duplicateMatchIds,
    missingMatchIds,
    unknownMatchIds,
    totals,
    matchups,
  };
}

export function renderLeagueMarkdown(report: LeagueReport): string {
  const f = (value: number | null) => (value === null ? '—' : value.toFixed(3));
  const lines = [
    `# League report: ${report.leagueId}`,
    '',
    `Planned ${report.planned}; recorded ${report.recorded}; decided ${report.totals.decided}; draws ${report.totals.draws}; faults ${report.totals.faults}; unfinished ${report.totals.unfinished}.`,
    '',
    `Missing: ${report.missingMatchIds.join(', ') || 'none'}  `,
    `Duplicates: ${report.duplicateMatchIds.join(', ') || 'none'}  `,
    `Unknown: ${report.unknownMatchIds.join(', ') || 'none'}`,
    '',
    '| matchup | W-L | win rate | Wilson 95% | seat advantage | faults | unfinished | think-time ms |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of report.matchups)
    lines.push(
      `| ${row.first} vs ${row.second} | ${row.wins.first}-${row.wins.second} | ${f(row.firstWinRate)} | ${row.firstWinWilson95 ? `${f(row.firstWinWilson95.low)}–${f(row.firstWinWilson95.high)}` : '—'} | ${f(row.firstSeatAdvantage)} | ${row.faults} | ${row.unfinished} | ${f(row.thinkTimeMs.firstAverage)} / ${f(row.thinkTimeMs.secondAverage)} |`
    );
  return `${lines.join('\n')}\n`;
}

export function writeLeagueReports(directory: string, report: LeagueReport): void {
  atomicWrite(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(path.join(directory, 'report.md'), renderLeagueMarkdown(report));
}
