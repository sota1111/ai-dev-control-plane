import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateLeague,
  createLeagueCheckpoint,
  loadLeagueCheckpoint,
  renderLeagueMarkdown,
  resumeLeague,
  saveLeagueCheckpoint,
  wilson95,
  writeLeagueReports,
  type LeagueMatchEvent,
} from '../lib/ptcgLeagueReport.js';

const event = (
  matchId: string,
  first: string,
  second: string,
  outcome: LeagueMatchEvent['outcome']
): LeagueMatchEvent => ({
  matchId,
  first,
  second,
  outcome,
  thinkTimeMs: { first: 10, second: 20 },
});

describe('resumable league reporting', () => {
  it('checkpoints each match and resumes without duplicate or missing matches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-report-'));
    const file = path.join(dir, 'checkpoint.json');
    const plan = ['m1', 'm2', 'm3'];
    saveLeagueCheckpoint(file, {
      ...createLeagueCheckpoint('league', plan),
      events: [event('m1', 'a', 'b', 'first')],
    });
    const executed: string[] = [];
    const resumed = await resumeLeague(file, 'league', plan, async (id) => {
      executed.push(id);
      return event(id, 'a', 'b', id === 'm2' ? 'second' : 'draw');
    });
    expect(executed).toEqual(['m2', 'm3']);
    expect(loadLeagueCheckpoint(file)).toEqual(resumed);
    await resumeLeague(file, 'league', plan, async () => {
      throw new Error('must not rerun');
    });
    expect(aggregateLeague(resumed)).toMatchObject({
      duplicateMatchIds: [],
      missingMatchIds: [],
      unknownMatchIds: [],
    });
  });

  it('reproduces known Wilson, seat, fault, unfinished and think-time fixtures', () => {
    const checkpoint = createLeagueCheckpoint('fixture', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    checkpoint.events = [
      { ...event('m1', 'a', 'b', 'first'), thinkTimeMs: { first: 10, second: 30 } },
      { ...event('m2', 'b', 'a', 'second'), thinkTimeMs: { first: 20, second: 14 } },
      event('m3', 'a', 'b', 'second'),
      event('m4', 'b', 'a', 'first'),
      {
        ...event('m5', 'a', 'b', 'fault'),
        fault: { seat: 'second', kind: 'timeout', code: 'TIMEOUT' },
      },
      event('m6', 'b', 'a', 'unfinished'),
    ];
    const report = aggregateLeague(checkpoint);
    expect(wilson95(2, 4)?.low).toBeCloseTo(0.150036, 6);
    expect(wilson95(2, 4)?.high).toBeCloseTo(0.849964, 6);
    expect(report.totals).toEqual({ decided: 4, draws: 0, faults: 1, unfinished: 1 });
    expect(report.matchups[0]).toMatchObject({
      wins: { first: 2, second: 2 },
      decided: 4,
      firstWinRate: 0.5,
      firstSeatAdvantage: 0,
      faults: 1,
      unfinished: 1,
      thinkTimeMs: { firstAverage: 14, secondAverage: 18.333333333333332 },
    });
    expect(renderLeagueMarkdown(report)).toContain('Wilson 95%');
  });

  it('detects duplicate, missing and unknown ids and writes deterministic JSON/Markdown', () => {
    const checkpoint = createLeagueCheckpoint('audit', ['m1', 'm2']);
    checkpoint.events = [
      event('m1', 'a', 'b', 'draw'),
      event('m1', 'a', 'b', 'draw'),
      event('extra', 'a', 'b', 'draw'),
    ];
    const report = aggregateLeague(checkpoint);
    expect(report).toMatchObject({
      duplicateMatchIds: ['m1'],
      missingMatchIds: ['m2'],
      unknownMatchIds: ['extra'],
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-output-'));
    writeLeagueReports(dir, report);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))).toEqual(report);
    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf8')).toContain('Duplicates: m1');
  });
});
