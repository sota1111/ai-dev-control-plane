import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MATSU_CROSS_PLAY_OPPONENTS,
  evaluateMatsuGame,
  validateMatsuStabilityProfile,
  wilson95,
  type MatsuStabilityProfile,
} from '../lib/ptcgMatsuStability.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'ptcg_matsu_stability.json'), 'utf8')
) as MatsuStabilityProfile;

describe('Matsu stability profile', () => {
  test('records a distinct conservative, resumable profile within budget', () => {
    expect(validateMatsuStabilityProfile(profile)).toEqual([]);
    expect(profile.archetype.distinctFrom).toEqual(
      expect.arrayContaining(['take:adaptive-tempo', 'ume:high-variance-pressure'])
    );
    expect(profile.exploration.budgetHours).toBeLessThanOrEqual(8);
  });

  test('is deterministic, seat-reversed, and safe for four heterogeneous opponents', () => {
    const games = MATSU_CROSS_PLAY_OPPONENTS.flatMap((opponent) =>
      ['first', 'second'].map((seat) =>
        evaluateMatsuGame(profile, 'candidate', opponent, 184800, seat as 'first' | 'second')
      )
    );
    expect(games).toHaveLength(8);
    expect(new Set(games.map((game) => game.opponent))).toEqual(
      new Set(MATSU_CROSS_PLAY_OPPONENTS)
    );
    expect(games.every((game) => !game.fault && !game.unfinished && !game.illegalAction)).toBe(
      true
    );
    expect(evaluateMatsuGame(profile, 'candidate', 'sol', 184800, 'first')).toEqual(games[0]);
  });

  test('candidate A/B Wilson lower bound exceeds 50%', () => {
    const games = Array.from({ length: profile.exploration.seedCount }, (_, offset) =>
      ['first', 'second'].map((seat) =>
        evaluateMatsuGame(
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
