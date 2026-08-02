import fs from 'node:fs';
import path from 'node:path';
import type { KaggleSubmissionRow } from './kaggleImproveMaterial.js';
import type { ImprovementCompetition, ImprovementTarget } from './kaggleImprovement.js';

export interface ScoreProgressionEntry {
  observedAt: string;
  competition: string;
  kaggleCompetition: string;
  repo: string;
  lineage: 'claude' | 'gpt';
  submissionDate: string;
  publicScore: number;
  privateScore?: number;
  fileName?: string;
  description?: string;
  approach: string;
  fingerprint: string;
}
export interface PlateauResult {
  plateau: boolean;
  consecutiveNonImproving: number;
  threshold: number;
  latestScore?: number;
  bestScore?: number;
  approach?: string;
  reason?: string;
}

function finiteScore(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const score = Number(value);
  return Number.isFinite(score) ? score : undefined;
}

function normalizeApproach(row: KaggleSubmissionRow): string {
  return (row.description || row.fileName || 'unknown')
    .toLowerCase()
    .replace(/\b(?:cycle|round|第)\s*\d+\b/gi, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function targetForRow(
  competition: ImprovementCompetition,
  row: KaggleSubmissionRow
): ImprovementTarget | undefined {
  const haystack = `${row.description || ''} ${row.fileName || ''}`.toLowerCase();
  return competition.targets.find((target) => haystack.includes(target.repo.toLowerCase()));
}

export function progressionEntriesFromRows(
  competition: ImprovementCompetition,
  rows: KaggleSubmissionRow[],
  observedAt = new Date().toISOString()
): ScoreProgressionEntry[] {
  const entries: ScoreProgressionEntry[] = [];
  for (const row of rows) {
    if ((row.status || '').toLowerCase() !== 'complete') continue;
    const publicScore = finiteScore(row.publicScore);
    const target = targetForRow(competition, row);
    if (publicScore === undefined || !target || !row.date) continue;
    const approach = normalizeApproach(row);
    const fingerprint = [
      competition.key,
      target.repo,
      row.date,
      row.fileName || '',
      publicScore,
    ].join('|');
    entries.push({
      observedAt,
      competition: competition.key,
      kaggleCompetition: competition.kaggleCompetition,
      repo: target.repo,
      lineage: target.lineage,
      submissionDate: row.date,
      publicScore,
      ...(finiteScore(row.privateScore) !== undefined
        ? { privateScore: finiteScore(row.privateScore) }
        : {}),
      ...(row.fileName ? { fileName: row.fileName } : {}),
      ...(row.description ? { description: row.description } : {}),
      approach,
      fingerprint,
    });
  }
  return entries;
}

export function readScoreProgression(file: string): ScoreProgressionEntry[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as ScoreProgressionEntry;
          return entry && typeof entry.fingerprint === 'string' ? [entry] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function appendNewScoreProgression(
  file: string,
  entries: ScoreProgressionEntry[]
): number {
  const known = new Set(readScoreProgression(file).map((entry) => entry.fingerprint));
  const fresh = entries.filter((entry) => !known.has(entry.fingerprint));
  if (fresh.length === 0) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return fresh.length;
}

// --- Leaderboard rank tracking (design/README.md §42 Leaderboard フィードバック) -----------------
// The primary KPI is the leaderboard rank, not the local score. Rank is computed from the public
// leaderboard listing (best-effort: the Kaggle CLI lists the top of the leaderboard; when our score
// is below the listed range the rank is unknown — reported as 圏外 with the gap to the top score).

export type ScoreDirection = 'max' | 'min';

export interface LeaderboardStanding {
  /** 1-based public rank; null when our score is outside the listed (top-N) range. */
  rank: number | null;
  /** Number of leaderboard rows the standing was computed against. */
  totalListed: number;
  topScore?: number;
  gapToTop?: number;
}

export function computePublicRank(
  leaderboardScores: number[],
  ourScore: number,
  direction: ScoreDirection = 'max'
): LeaderboardStanding {
  const scores = leaderboardScores.filter((s) => Number.isFinite(s));
  if (scores.length === 0 || !Number.isFinite(ourScore)) {
    return { rank: null, totalListed: scores.length };
  }
  const better = (a: number, b: number): boolean => (direction === 'max' ? a > b : a < b);
  const topScore = scores.reduce((best, s) => (better(s, best) ? s : best), scores[0]);
  const worstListed = scores.reduce((worst, s) => (better(worst, s) ? s : worst), scores[0]);
  const gapToTop = Math.abs(topScore - ourScore);
  if (better(worstListed, ourScore)) {
    // Below every listed row: the listing is typically truncated (top-N), so the true rank is unknown.
    return { rank: null, totalListed: scores.length, topScore, gapToTop };
  }
  const rank = 1 + scores.filter((s) => better(s, ourScore)).length;
  return { rank, totalListed: scores.length, topScore, gapToTop };
}

export interface LeaderboardRankEntry {
  observedAt: string;
  competition: string;
  kaggleCompetition: string;
  repo: string;
  lineage: 'claude' | 'gpt';
  bestPublicScore: number;
  rank: number | null;
  totalListed: number;
  topScore?: number;
  gapToTop?: number;
  /** Dedup key: one observation per repo per UTC day. */
  fingerprint: string;
}

export function readLeaderboardRankHistory(file: string): LeaderboardRankEntry[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as LeaderboardRankEntry;
          return entry && typeof entry.fingerprint === 'string' ? [entry] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Idempotent append: at most one rank observation per repo per UTC day. */
export function appendLeaderboardRank(
  file: string,
  entries: LeaderboardRankEntry[]
): number {
  const known = new Set(readLeaderboardRankHistory(file).map((entry) => entry.fingerprint));
  const fresh = entries.filter((entry) => !known.has(entry.fingerprint));
  if (fresh.length === 0) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, fresh.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return fresh.length;
}

export function leaderboardRankFingerprint(
  competitionKey: string,
  repo: string,
  observedAt: string
): string {
  return [competitionKey, repo, observedAt.slice(0, 10)].join('|');
}

export function detectScorePlateau(
  entries: ScoreProgressionEntry[],
  repo: string,
  threshold = 3
): PlateauResult {
  const ordered = entries
    .filter((entry) => entry.repo === repo)
    .sort((a, b) => Date.parse(a.submissionDate) - Date.parse(b.submissionDate));
  if (ordered.length === 0) {
    return { plateau: false, consecutiveNonImproving: 0, threshold };
  }

  let best = Number.NEGATIVE_INFINITY;
  let streak = 0;
  let streakApproach = '';
  for (const entry of ordered) {
    if (entry.publicScore > best) {
      best = entry.publicScore;
      streak = 0;
      streakApproach = entry.approach;
      continue;
    }
    if (entry.approach !== streakApproach) {
      streak = 1;
      streakApproach = entry.approach;
    } else {
      streak += 1;
    }
  }
  const latest = ordered[ordered.length - 1];
  const plateau = streak >= threshold;
  return {
    plateau,
    consecutiveNonImproving: streak,
    threshold,
    latestScore: latest.publicScore,
    bestScore: best,
    approach: streakApproach,
    ...(plateau
      ? {
          reason:
            `plateau escalation: ${repo} has ${streak} consecutive non-improving ` +
            `public scores with the same approach "${streakApproach}" ` +
            `(latest=${latest.publicScore}, best=${best}, threshold=${threshold})`,
        }
      : {}),
  };
}
