import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-lineage experiment ledger (design/README.md §48 実験台帳).
 *
 * Each target repository owns a machine-readable JSONL ledger of every improvement axis it has
 * tried: `docs/ai/experiment_ledger.jsonl` (one JSON object per line). The improvement-cycle issue
 * body embeds a digest of it, so axis history survives worker/session changes and rejected axes are
 * not silently retried. The solo worker appends an entry per axis it evaluates (see
 * prompts/roles/solo.md); this module only reads/summarizes.
 */

export type ExperimentResult = 'promoted' | 'rejected' | 'inconclusive';

export interface ExperimentLedgerEntry {
  /** ISO timestamp when the entry was recorded. */
  recordedAt: string;
  /** Improvement axis, short and stable (e.g. "deck-meta-reallocation", "value-net-mcts"). */
  axis: string;
  result: ExperimentResult;
  /** Improvement-cycle number the axis was tried in. */
  cycle?: number;
  /** What was expected. */
  hypothesis?: string;
  /** Screen/confirm scores, seeds, LB refs — enough to judge a retry proposal. */
  evidence?: string;
  notes?: string;
}

export function defaultExperimentLedgerPath(repoPath: string): string {
  return path.join(repoPath, 'docs', 'ai', 'experiment_ledger.jsonl');
}

/** Tolerant JSONL read: skips unparseable lines and entries without an axis/result. */
export function readExperimentLedger(file: string): ExperimentLedgerEntry[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry.axis !== 'string' || !entry.axis) return [];
          if (!['promoted', 'rejected', 'inconclusive'].includes(entry.result)) return [];
          return [entry as ExperimentLedgerEntry];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Markdown digest for the improvement-cycle issue body. Groups by axis (an axis's LATEST result
 * wins, so a later promotion supersedes an earlier rejection) and lists rejected axes explicitly
 * as a no-retry contract.
 */
export function summarizeExperimentLedger(entries: ExperimentLedgerEntry[]): string {
  if (entries.length === 0) {
    return '(実験台帳なし — 初回サイクル、または未整備。今回から docs/ai/experiment_ledger.jsonl へ記録すること)';
  }
  const byAxis = new Map<string, ExperimentLedgerEntry>();
  for (const entry of entries) {
    const prev = byAxis.get(entry.axis);
    if (!prev || Date.parse(entry.recordedAt || '') >= Date.parse(prev.recordedAt || '')) {
      byAxis.set(entry.axis, entry);
    }
  }
  const promoted: string[] = [];
  const rejected: string[] = [];
  const inconclusive: string[] = [];
  for (const [axis, entry] of byAxis) {
    const line = entry.evidence ? `${axis} — ${entry.evidence}` : axis;
    if (entry.result === 'promoted') promoted.push(line);
    else if (entry.result === 'rejected') rejected.push(line);
    else inconclusive.push(line);
  }
  const section = (title: string, items: string[]): string =>
    items.length > 0 ? `${title}\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  return [
    `試行済み軸: ${byAxis.size}（昇格 ${promoted.length} / 非昇格 ${rejected.length} / 不確定 ${inconclusive.length}）`,
    section('昇格済み:', promoted),
    section('非昇格（新しい根拠なしの再試行は禁止）:', rejected),
    section('不確定（再評価可）:', inconclusive),
  ].filter(Boolean).join('\n');
}
