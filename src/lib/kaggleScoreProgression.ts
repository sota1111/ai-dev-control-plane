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
