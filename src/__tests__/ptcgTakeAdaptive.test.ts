import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TAKE_CROSS_PLAY_OPPONENTS,
  evaluateTakeGame,
  validateTakeAdaptiveProfile,
  wilson95,
  type TakeAdaptiveProfile,
} from '../lib/ptcgTakeAdaptive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'ptcg_take_adaptive.json'), 'utf8')
) as TakeAdaptiveProfile;

describe('Take adaptive profile', () => {
  test('records a distinct balanced, resumable profile within budget', () => {
    expect(validateTakeAdaptiveProfile(profile)).toEqual([]);
    expect(profile.archetype.distinctFrom).toEqual(
      expect.arrayContaining(['matsu:stability-control', 'ume:high-variance-pressure'])
    );
    expect(profile.weaknessTargets).toEqual(expect.arrayContaining(['sol', 'debate', 'ume']));
    expect(profile.exploration.budgetHours).toBeLessThanOrEqual(8);
  });

  test('is deterministic, seat-reversed, and safe for four heterogeneous opponents', () => {
    const games = TAKE_CROSS_PLAY_OPPONENTS.flatMap((opponent) =>
      ['first', 'second'].map((seat) =>
        evaluateTakeGame(profile, 'candidate', opponent, 184900, seat as 'first' | 'second')
      )
    );
    expect(games).toHaveLength(8);
    expect(new Set(games.map((game) => game.opponent))).toEqual(new Set(TAKE_CROSS_PLAY_OPPONENTS));
    expect(games.every((game) => !game.fault && !game.unfinished && !game.illegalAction)).toBe(
      true
    );
    expect(evaluateTakeGame(profile, 'candidate', 'sol', 184900, 'first')).toEqual(games[0]);
  });

  test('candidate A/B Wilson lower bound exceeds 50%', () => {
    const games = Array.from({ length: profile.exploration.seedCount }, (_, offset) =>
      ['first', 'second'].map((seat) =>
        evaluateTakeGame(
          profile,
          'candidate',
          'baseline',
          profile.exploration.seedStart + offset,
          seat as 'first' | 'second'
        )
      )
    ).flat();
    const wins = games.filter((game) => game.outcome === 'win').length;
    expect(wilson95(wins, games.length).low).toBeGreaterThan(0.5);
  });
});
