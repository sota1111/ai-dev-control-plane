import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UME_CROSS_PLAY_OPPONENTS,
  evaluateUmeGame,
  validateUmeAggressiveProfile,
  wilson95,
  type UmeAggressiveProfile,
} from '../lib/ptcgUmeAggressive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const profile = JSON.parse(
  fs.readFileSync(path.join(root, 'config', 'ptcg_ume_aggressive.json'), 'utf8')
) as UmeAggressiveProfile;

describe('Ume aggressive profile', () => {
  test('records a distinct aggressive, resumable profile within budget', () => {
    expect(validateUmeAggressiveProfile(profile)).toEqual([]);
    expect(profile.archetype.distinctFrom).toEqual(
      expect.arrayContaining(['matsu:stability-control', 'take:adaptive-tempo'])
    );
    expect(profile.weaknessTargets).toEqual(
      expect.arrayContaining(['sol', 'debate', 'fable', 'zero'])
    );
    expect(profile.exploration.budgetHours).toBeLessThanOrEqual(8);
  });

  test('is deterministic, seat-reversed, and safe for four heterogeneous opponents', () => {
    const games = UME_CROSS_PLAY_OPPONENTS.flatMap((opponent) =>
      ['first', 'second'].map((seat) =>
        evaluateUmeGame(profile, 'candidate', opponent, 185000, seat as 'first' | 'second')
      )
    );
    expect(games).toHaveLength(8);
    expect(new Set(games.map((game) => game.opponent))).toEqual(new Set(UME_CROSS_PLAY_OPPONENTS));
    expect(games.every((game) => !game.fault && !game.unfinished && !game.illegalAction)).toBe(
      true
    );
    expect(evaluateUmeGame(profile, 'candidate', 'sol', 185000, 'first')).toEqual(games[0]);
  });

  test('candidate A/B Wilson lower bound exceeds 50%', () => {
    const games = Array.from({ length: profile.exploration.seedCount }, (_, offset) =>
      ['first', 'second'].map((seat) =>
        evaluateUmeGame(
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
