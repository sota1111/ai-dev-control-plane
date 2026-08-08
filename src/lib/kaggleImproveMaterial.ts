/**
 * SOT-1913/SOT-1933 材料自動収集 — 改善サイクル cron が起案Issue本文へ埋め込む「入力材料」と、
 * 新材料/前サイクル未完了の各ガードシグナルを、決定的（LLM非呼出）に収集する。
 *
 * 背景（バグ）: これまで cron(`scripts/ai/kaggle_improvement_cycle.sh`)は runner-cli へ
 * `--material` / `--signals` を渡しておらず、`buildIssueBody` が常に空プレースホルダ
 * （"(前回提出の記録なし…)" / "(新規の完了Issueなし)" / "(該当なし)"）を出力し、かつ
 * 新材料ガード・前サイクル未完了ガードも既定 fail-open で実質無効化されていた。本モジュールが
 * その「cronが自動収集」の実体。
 *
 * 収集元（全て best-effort。失敗時は当該フィールドを undefined／シグナルを安全側に倒し、cron は
 * 従来どおり継続する。**決して throw しない**）:
 *  - 前回提出結果  : Kaggle CLI `kaggle competitions submissions <slug> --csv`（コンペ単位で1回）
 *  - 完了Issueダイジェスト + hasNewMaterial : Linear（project の completed を前回サイクル以降で判定）
 *  - hasUnfinishedCycle : `findOpenAutoImproveIssue`（既存）
 *  - failure/KPI 抜粋 : `docs/ai/failure-log.md` を repo名/コンペkey でフィルタ
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { GuardSignals, ImprovementMaterial, TargetsRegistry } from './kaggleImprovement.js';
import { getCompetition, resolveCompetitionPhase } from './kaggleImprovement.js';
import {
  computeTargetPriority,
  type CompetitionCandidate,
  type PriorityWeights,
} from './resourceAllocation.js';
import { findOpenAutoImproveIssue, linearQuery } from './linearApi.js';
import {
  appendNewScoreProgression,
  appendLeaderboardRank,
  computePublicRank,
  detectScorePlateau,
  leaderboardRankFingerprint,
  progressionEntriesFromRows,
  readLeaderboardRankHistory,
  readScoreProgression,
  type LeaderboardRankEntry,
} from './kaggleScoreProgression.js';
import {
  defaultExperimentLedgerPath,
  readExperimentLedger,
  summarizeExperimentLedger,
} from './experimentLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** collectImproveContext の返り値。planImprovementCycle の signals/material にそのまま渡せる。 */
export interface CollectedContext {
  signals: Record<string, GuardSignals>;
  material: Record<string, ImprovementMaterial>;
}

/* ============================================================================
 * 純関数ヘルパー（単体テスト対象）
 * ========================================================================== */

/** `kaggle competitions submissions --csv` の1行を表す（列はヘッダ名で解決）。 */
export interface KaggleSubmissionRow {
  fileName?: string;
  date?: string;
  description?: string;
  status?: string;
  publicScore?: string;
  privateScore?: string;
}

/**
 * Kaggle のコンペ履歴を1つの repo/lineage に帰属させる。
 * 新形式の `[repo:...]` を優先し、移行前のメッセージに含まれる repo 名も受け付ける。
 * 帰属を確認できない履歴は別 lineage の改善Issueを誤起案しないため除外する。
 *
 * `singleTarget`（コンペに target が1つだけ）のときは、その Kaggle コンペへの提出は必ず
 * その唯一の repo に属する。よって帰属マーカーの無い提出（control-plane 経由でなく直接
 * `kaggle competitions submit` した提出など）も採用する。ただし別 repo が明示された
 * `[repo:other]` の履歴（移行前の別 lineage 提出）は誤帰属を避けるため除外する。
 */
export function submissionRowsForRepo(
  rows: KaggleSubmissionRow[],
  repo: string,
  opts: { singleTarget?: boolean } = {}
): KaggleSubmissionRow[] {
  const expected = repo.trim().toLowerCase();
  if (!expected) return [];
  return rows.filter((row) => {
    const description = (row.description || '').toLowerCase();
    if (description.includes(`[repo:${expected}]`) || description.includes(expected)) {
      return true;
    }
    if (opts.singleTarget) {
      // 単一 target: 別 repo が明示されていない限り、この唯一の repo に帰属させる。
      const otherRepoMarked = /\[repo:([a-z0-9-]+)\]/.exec(description);
      return !otherRepoMarked || otherRepoMarked[1] === expected;
    }
    return false;
  });
}

/** CSV の1行を quote 対応で分割する（description に "," を含む場合に対応）。 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else { inQuote = false; }
      } else { cur += ch; }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * `kaggle competitions submissions <slug> --csv` の出力をパースする。ヘッダ名で列を解決するので
 * 列順の変化に耐える。CSV 前後に混じる警告行等は無視する（ヘッダらしき行を起点にする）。
 */
export function parseKaggleSubmissionsCsv(csv: string): KaggleSubmissionRow[] {
  const lines = (csv || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  // ヘッダ行 = "fileName" と "date"（または "status"）を含む最初の行。
  const headerIdx = lines.findIndex((l) => {
    const lower = l.toLowerCase();
    return lower.includes('date') && (lower.includes('filename') || lower.includes('status') || lower.includes('publicscore'));
  });
  if (headerIdx < 0) return [];
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const col = {
    fileName: idx('fileName'),
    date: idx('date'),
    description: idx('description'),
    status: idx('status'),
    publicScore: idx('publicScore'),
    privateScore: idx('privateScore'),
  };
  const rows: KaggleSubmissionRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const get = (c: number) => (c >= 0 && c < cells.length ? cells[c].trim() : undefined) || undefined;
    const row: KaggleSubmissionRow = {
      fileName: get(col.fileName),
      date: get(col.date),
      description: get(col.description),
      status: get(col.status),
      publicScore: get(col.publicScore),
      privateScore: get(col.privateScore),
    };
    if (row.fileName || row.date || row.status || row.publicScore) rows.push(row);
  }
  return rows;
}

/**
 * `kaggle competitions leaderboard <slug> --show --csv` の出力から score 列を数値配列で返す。
 * ヘッダ名で列を解決し、CSV 前後の警告行は無視する（design §42 LB順位が一次KPI）。
 */
export function parseKaggleLeaderboardScores(csv: string): number[] {
  const lines = (csv || '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const headerIdx = lines.findIndex((l) => {
    const lower = l.toLowerCase();
    return lower.includes('score') && (lower.includes('teamid') || lower.includes('teamname'));
  });
  if (headerIdx < 0) return [];
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());
  const scoreCol = header.indexOf('score');
  if (scoreCol < 0) return [];
  const scores: number[] = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const score = Number((cells[scoreCol] ?? '').trim());
    if (Number.isFinite(score)) scores.push(score);
  }
  return scores;
}

/**
 * 最新（先頭）から最大 maxRows 件を人間可読な箇条書きに整形。1件も無ければ undefined。
 * kaggle CLI は最新提出を先頭に出力するため、そのまま先頭から採る。
 */
export function formatPreviousSubmission(rows: KaggleSubmissionRow[], maxRows = 3): string | undefined {
  if (!rows || rows.length === 0) return undefined;
  const lines = rows.slice(0, Math.max(1, maxRows)).map((r) => {
    const parts: string[] = [];
    parts.push(r.date || '(date不明)');
    if (r.status) parts.push(`status=${r.status}`);
    if (r.publicScore) parts.push(`public=${r.publicScore}`);
    if (r.privateScore) parts.push(`private=${r.privateScore}`);
    if (r.fileName) parts.push(`file=${r.fileName}`);
    return `- ${parts.join(' ')}`;
  });
  return lines.join('\n');
}

/** 前回の改善Issue作成後に確定した、スコア付きKaggle結果があるか。 */
export function hasScoredSubmissionSince(
  rows: KaggleSubmissionRow[],
  sinceIso: string | null
): boolean {
  if (sinceIso === null) return rows.some(isCompletedScoredSubmission);
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return rows.some(isCompletedScoredSubmission);
  return rows.some((row) => {
    if (!isCompletedScoredSubmission(row) || !row.date) return false;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.date)
      ? `${row.date.replace(' ', 'T')}Z`
      : row.date;
    const submittedMs = Date.parse(normalized);
    return !Number.isNaN(submittedMs) && submittedMs > sinceMs;
  });
}

/**
 * 前回の改善Issue作成後に新しいKaggle提出があるか。
 * 定期枠の間隔を待機時間として扱うため、PENDINGも次の改善サイクルの新材料に含める。
 */
export function hasSubmissionSince(
  rows: KaggleSubmissionRow[],
  sinceIso: string | null
): boolean {
  if (sinceIso === null) return rows.length > 0;
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) return rows.length > 0;
  return rows.some((row) => {
    if (!row.date) return false;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(row.date)
      ? `${row.date.replace(' ', 'T')}Z`
      : row.date;
    const submittedMs = Date.parse(normalized);
    return !Number.isNaN(submittedMs) && submittedMs > sinceMs;
  });
}

function isCompletedScoredSubmission(row: KaggleSubmissionRow): boolean {
  const status = (row.status || '').toUpperCase();
  return status.endsWith('COMPLETE') && row.publicScore !== undefined;
}

/**
 * 自分の best public score を submission 履歴の生行から直接取る（design §42 LB順位が一次KPI）。
 * score-progression.jsonl は `[repo:...]` 帰属マーカー付きの完了提出が拾えないと空になり、順位計算が
 * 出せない。ここでは COMPLETE かつ数値スコアを持つ行から、方向（max/min）に応じた最良値を返す。
 * 1件も無ければ undefined。
 */
export function bestPublicScoreFromRows(
  rows: KaggleSubmissionRow[],
  direction: 'max' | 'min' = 'max'
): number | undefined {
  let best: number | undefined;
  for (const row of rows) {
    if (!isCompletedScoredSubmission(row)) continue;
    const score = Number(row.publicScore);
    if (!Number.isFinite(score)) continue;
    if (best === undefined || (direction === 'max' ? score > best : score < best)) {
      best = score;
    }
  }
  return best;
}

/* ============================================================================
 * SOT-2518 P8: 提出アウトカム preflight（submissionHealth = broken 検出）
 * ========================================================================== */

/** 直近提出が壊れている（有効スコアを得ていない）と判定する既定の連続回数（SOT-2518 P8）。 */
export const SUBMISSION_BROKEN_CONSECUTIVE = 3;

/** 1提出行の状態。healthy=COMPLETE かつ非ゼロ有効スコア / unhealthy=ERROR・0.000・未スコア / pending=採点待ち等。 */
export type SubmissionRowState = 'healthy' | 'unhealthy' | 'pending';

/**
 * 1提出行を healthy / unhealthy / pending に分類する。
 *  - status に PENDING を含む・status 空 → pending（判定材料にしない）。
 *  - status に ERROR / FAIL を含む → unhealthy。
 *  - status が COMPLETE で終わる → publicScore が欠落/非数値/0 なら unhealthy（0.000/未スコア＝LB非掲載相当）、
 *    非ゼロ有効スコアなら healthy。
 *  - それ以外の未知 status → pending（安全側。broken を誤って立てない）。
 */
export function submissionRowState(row: KaggleSubmissionRow): SubmissionRowState {
  const status = (row.status || '').trim().toUpperCase();
  if (!status || status.includes('PENDING')) return 'pending';
  if (status.includes('ERROR') || status.includes('FAIL')) return 'unhealthy';
  if (status.endsWith('COMPLETE')) {
    if (row.publicScore === undefined || row.publicScore.trim() === '') return 'unhealthy';
    const score = Number(row.publicScore);
    if (!Number.isFinite(score) || score === 0) return 'unhealthy';
    return 'healthy';
  }
  return 'pending';
}

/** detectSubmissionHealth の結果。 */
export interface SubmissionHealth {
  status: 'ok' | 'broken' | 'unknown';
  /** 最新（先頭）から連続する unhealthy の件数。 */
  consecutiveBroken: number;
  /** 人間向け理由（本文に載せる）。ok のときは undefined。 */
  reason?: string;
}

/**
 * 提出履歴（最新が先頭）の健全性を判定する（SOT-2518 P8）。pending 行は無視し、非 pending 行を
 * 先頭から見る:
 *  - 先頭から連続する unhealthy が `consecutive`（既定3）以上 → `broken`（提出パイプライン破損の疑い）。
 *  - 先頭の非 pending が healthy → `ok`。
 *  - 非 pending 行が無い（全て採点待ち等）→ `unknown`。
 *  - それ以外（連続 unhealthy が閾値未満で healthy が続く）→ `unknown`（まだ broken ではない）。
 */
export function detectSubmissionHealth(
  rows: KaggleSubmissionRow[],
  consecutive = SUBMISSION_BROKEN_CONSECUTIVE
): SubmissionHealth {
  let consecutiveBroken = 0;
  let sawNonPending = false;
  for (const row of rows) {
    const state = submissionRowState(row);
    if (state === 'pending') continue;
    sawNonPending = true;
    if (state === 'unhealthy') {
      consecutiveBroken += 1;
    } else {
      break; // 先頭の非 pending が healthy → これ以上さかのぼらない
    }
  }
  if (!sawNonPending) {
    return { status: 'unknown', consecutiveBroken: 0, reason: 'スコア確定済みの提出がまだ無い（採点待ち/履歴なし）' };
  }
  if (consecutiveBroken >= consecutive) {
    return {
      status: 'broken',
      consecutiveBroken,
      reason: `直近 ${consecutiveBroken} 回連続で有効スコア無し（ERROR/0.000/未スコア）— 提出パイプラインが壊れている疑い。新規改善軸より提出復旧を最優先にする`,
    };
  }
  if (consecutiveBroken === 0) {
    return { status: 'ok', consecutiveBroken: 0 };
  }
  return {
    status: 'unknown',
    consecutiveBroken,
    reason: `直近 ${consecutiveBroken} 回が無効提出（broken 閾値 ${consecutive} 未満）`,
  };
}

/* ============================================================================
 * SOT-2518 P9: 実LB順位トレンド（相対/rating コンペの「維持=後退」検知）
 * ========================================================================== */

/** 順位トレンド算出に渡す1観測（rank は 圏外＝null）。 */
export interface RankObservation {
  rank: number | null;
  totalListed?: number;
  observedAt?: string;
}

/** computeRankTrend の結果。 */
export interface RankTrend {
  direction: 'improving' | 'declining' | 'flat' | 'new' | 'unknown';
  summary: string;
}

/** rank を「小さいほど良い」順序値に正規化する（圏外=null は最悪＝Infinity）。 */
function rankValue(rank: number | null): number {
  return rank === null || !Number.isFinite(rank) ? Number.POSITIVE_INFINITY : rank;
}

function formatRank(o: RankObservation): string {
  if (o.rank === null || !Number.isFinite(o.rank)) {
    return o.totalListed ? `圏外(top${o.totalListed})` : '圏外';
  }
  return `${o.rank}位`;
}

/**
 * 実LB順位の時系列（古い→新しい順）からトレンドを算出する（SOT-2518 P9）。順位は小さいほど良い。
 *  - 0件 → unknown。1件 → new（現在順位のみ）。
 *  - 最新が最古より悪い（順位が大きい/圏外化）→ declining（⚠ 低下傾向）。
 *  - 最新が最古より良い → improving。等しい → flat。
 * relative_rating コンペでは declining が「維持=後退」の一次シグナルになる。
 */
export function computeRankTrend(history: RankObservation[]): RankTrend {
  const obs = (history || []).filter((o) => o && (o.rank === null || typeof o.rank === 'number'));
  if (obs.length === 0) return { direction: 'unknown', summary: '順位観測なし' };
  const path = obs.map(formatRank).join(' → ');
  if (obs.length === 1) {
    return { direction: 'new', summary: `順位トレンド(新規観測): ${path}` };
  }
  const firstV = rankValue(obs[0].rank);
  const lastV = rankValue(obs[obs.length - 1].rank);
  const base = `順位トレンド(直近${obs.length}観測): ${path}`;
  if (lastV > firstV) {
    return {
      direction: 'declining',
      summary: `${base} — ⚠ 低下傾向（field が上げてきている可能性。相対競技では維持=後退を疑え）`,
    };
  }
  if (lastV < firstV) {
    return { direction: 'improving', summary: `${base} — 上昇傾向` };
  }
  return { direction: 'flat', summary: `${base} — 横ばい` };
}

/* ============================================================================
 * SOT-2514: leak-free CV レポート → cvSummary / CV↔public gap / 参照実装スコア警告
 * ========================================================================== */

/** target repo 内 cv_report.json の既定相対パス。 */
export const DEFAULT_CV_REPORT_PATH = 'docs/ai/cv_report.json';

/** CV↔public 相対乖離で `⚠ 乖離警告` を出す既定閾値（相対 10%、SOT-2514）。 */
export const CV_PUBLIC_GAP_RELATIVE_WARN = 0.1;

/** 自 best public が参照 public を「有意に上回った」と判定する既定相対マージン（2%、SOT-2514・P5）。 */
export const REFERENCE_OVERFIT_RELATIVE_MARGIN = 0.02;

/** entity_unit が行単位CV（リーク源）を示す語。エンティティ単位hold-out必須（playbook P1）。 */
const ROW_LEVEL_UNIT_TOKENS = [
  'row',
  'record',
  'sample',
  'instance',
  'index',
  '行',
  'レコード',
  'サンプル',
];

/**
 * target repo の cv_report.json のスキーマ（エンティティ単位 hold-out 必須）。
 * `{cv_scheme, entity_unit, folds, score, per_entity_scores?}`。
 */
export interface CvReport {
  cvScheme: string;
  entityUnit: string;
  folds: number;
  score: number;
  perEntityScores?: number[];
}

/** parseCvReport / readCvReport の結果。violation があれば cvSummary としてそのまま供給する警告文。 */
export interface CvReportResult {
  report?: CvReport;
  /** スキーマ不正/行単位CV 等の「CV契約違反」警告文。 */
  violation?: string;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * cv_report.json の生 JSON を検証する（snake/camel 両受け）。**throw しない**。
 *  - オブジェクトでない / 必須フィールド欠落・型不正 → CV契約違反 warning。
 *  - entity_unit が行単位（row/record/…）→ CV契約違反 warning（リーク源）。
 *  - 正常 → report を返す。
 */
export function parseCvReport(raw: unknown): CvReportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      violation:
        'CV契約違反: cv_report.json が JSON オブジェクトでない。最初の子Issueで leak-free CV（エンティティ単位hold-out）を整備する(playbook P1)',
    };
  }
  const o = raw as Record<string, unknown>;
  const cvScheme = o.cv_scheme ?? o.cvScheme;
  const entityUnit = o.entity_unit ?? o.entityUnit;
  const folds = o.folds;
  const score = o.score;
  const perEntityRaw = o.per_entity_scores ?? o.perEntityScores;

  const missing: string[] = [];
  if (typeof cvScheme !== 'string' || !cvScheme.trim()) missing.push('cv_scheme');
  if (typeof entityUnit !== 'string' || !entityUnit.trim()) missing.push('entity_unit');
  if (typeof folds !== 'number' || !Number.isFinite(folds) || folds < 1) missing.push('folds');
  if (typeof score !== 'number' || !Number.isFinite(score)) missing.push('score');
  if (missing.length > 0) {
    return {
      violation: `CV契約違反: cv_report.json のスキーマが不正（欠落/型不正: ${missing.join(', ')}）。エンティティ単位hold-outの leak-free CV を整備する(playbook P1)`,
    };
  }

  const unitLower = (entityUnit as string).trim().toLowerCase();
  if (ROW_LEVEL_UNIT_TOKENS.some((tok) => unitLower === tok || unitLower.includes(tok))) {
    return {
      violation: `CV契約違反: entity_unit="${(entityUnit as string).trim()}" は行単位CVの疑い。同一エンティティが train/val に跨ってリークする。坑井/ユーザー/系列などエンティティ単位の hold-out にする(playbook P1)`,
    };
  }

  const report: CvReport = {
    cvScheme: (cvScheme as string).trim(),
    entityUnit: (entityUnit as string).trim(),
    folds: folds as number,
    score: score as number,
  };
  if (
    Array.isArray(perEntityRaw) &&
    perEntityRaw.length > 0 &&
    perEntityRaw.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    report.perEntityScores = perEntityRaw as number[];
  }
  return { report };
}

/**
 * cv_report.json を読む（best-effort・**throw しない**）。無ければ `{}`（→ 本文は SOT-2513 fail-safe
 * 経路に落ちる）。読めたが不正なら violation を返す。
 */
export function readCvReport(
  file: string,
  log: (m: string) => void = () => {
    /* noop */
  }
): CvReportResult {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    log(`cv_report read skipped (${file}): ${err?.message || err}`);
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err: any) {
    log(`cv_report parse failed (${file}): ${err?.message || err}`);
    return {
      violation:
        'CV契約違反: cv_report.json が不正なJSON。leak-free CV（エンティティ単位hold-out）を整備し直す(playbook P1)',
    };
  }
  return parseCvReport(json);
}

/** 正常な CvReport → 人間可読の cvSummary（本文の「一次 leak-free CV」行に載る）。 */
export function formatCvSummary(report: CvReport): string {
  const parts = [
    `CV score ${report.score} (${report.cvScheme} / ${report.entityUnit}単位hold-out / ${report.folds}-fold)`,
  ];
  const arr = report.perEntityScores;
  if (arr && arr.length > 0) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    parts.push(
      `per-entity(${arr.length}): mean ${round4(mean)} / range [${round4(min)}, ${round4(max)}]（重い裾は playbook P3 頑健受容で診断）`
    );
  }
  return parts.join('\n');
}

/** CV↔public の乖離量。relative = |cv - public| / max(|public|, ε)。 */
export interface CvPublicGap {
  cvScore: number;
  publicScore: number;
  absolute: number;
  relative: number;
}

export function computeCvPublicGap(cvScore: number, publicScore: number): CvPublicGap {
  const absolute = Math.abs(cvScore - publicScore);
  const denom = Math.max(Math.abs(publicScore), 1e-9);
  return { cvScore, publicScore, absolute, relative: absolute / denom };
}

/** CV↔public gap の本文サマリ。CV最良 / public最良 / 相対乖離% を明示し、悲観側(CV)を信じる旨を添える。 */
export function formatCvPublicGapSummary(gap: CvPublicGap): string {
  const pct = (gap.relative * 100).toFixed(1);
  return `CV最良 ${gap.cvScore} / public最良 ${gap.publicScore} / 相対乖離 ${pct}%（絶対差 ${round4(gap.absolute)}）— 乖離時は悲観側(CV)を信じ、public 追い禁止(playbook P2)`;
}

/**
 * 参照実装/公開NBの公称 public を自 best public が有意に上回ったら過学習疑い警告（playbook P5）。
 * direction=max は「大きいほど良い」、min は「小さいほど良い」。上回っていなければ undefined。
 */
export function referenceOverfitWarning(
  bestPublic: number,
  referencePublic: number,
  direction: 'max' | 'min' = 'max',
  margin = REFERENCE_OVERFIT_RELATIVE_MARGIN
): string | undefined {
  if (!Number.isFinite(bestPublic) || !Number.isFinite(referencePublic)) return undefined;
  const denom = Math.max(Math.abs(referencePublic), 1e-9);
  const rel = (bestPublic - referencePublic) / denom; // >0: best が ref を上回る（max 方向）
  const beats = direction === 'max' ? rel > margin : -rel > margin;
  if (!beats) return undefined;
  const pct = (Math.abs(rel) * 100).toFixed(1);
  return `⚠ 過学習疑い(playbook P5): 自 best public ${bestPublic} が参照 public ${referencePublic} を ${pct}% 上回っている。忠実な移植は参照近傍に着地するはず。この上振れは後付け較正の過学習を疑い、必ず leak-free CV で裏取りする`;
}

/**
 * gap 履歴（時系列の相対乖離）から推移 digest を作る。拡大傾向なら「汎化リスク増大」を含める。
 * 2点未満なら undefined（推移を語れない）。
 */
export function formatCvGapTrend(relativeGaps: number[]): string | undefined {
  const gaps = relativeGaps.filter((g) => Number.isFinite(g));
  if (gaps.length < 2) return undefined;
  const trend = gaps.map((g) => `${(g * 100).toFixed(1)}%`).join(' → ');
  const widening = gaps[gaps.length - 1] > gaps[0];
  return widening
    ? `gap 推移(相対): ${trend} — ⚠ 乖離が拡大傾向。汎化リスク増大、CV再アンカリング/汎化ギャップ診断を優先(playbook P2)`
    : `gap 推移(相対): ${trend}`;
}

/**
 * cv_report_history.jsonl の各行から相対 gap を抽出する。行は `{relativeGap}` か
 * `{score, publicScore}` を受け付け、不正行は握りつぶす。
 */
export function parseCvGapHistory(content: string): number[] {
  const out: number[] = [];
  for (const line of (content || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    if (typeof obj.relativeGap === 'number' && Number.isFinite(obj.relativeGap)) {
      out.push(Math.abs(obj.relativeGap));
    } else if (
      typeof obj.score === 'number' &&
      Number.isFinite(obj.score) &&
      typeof obj.publicScore === 'number' &&
      Number.isFinite(obj.publicScore)
    ) {
      out.push(computeCvPublicGap(obj.score, obj.publicScore).relative);
    }
  }
  return out;
}

/**
 * failure-log.md 本文から、指定キー（repo名・コンペkey 等）を含む行だけを抜粋する。
 * 1行も一致しなければ undefined。長すぎる場合は maxLines で打ち切り、省略を明示する。
 */
export function filterFailureLog(content: string, keys: string[], maxLines = 20): string | undefined {
  if (!content) return undefined;
  const needles = keys.map((k) => k.toLowerCase()).filter((k) => k.length > 0);
  if (needles.length === 0) return undefined;
  const matched = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => {
      const lower = l.toLowerCase();
      return needles.some((n) => lower.includes(n));
    });
  if (matched.length === 0) return undefined;
  if (matched.length <= maxLines) return matched.join('\n');
  return matched.slice(0, maxLines).join('\n') + `\n… (他 ${matched.length - maxLines} 行省略)`;
}

/** buildRecentIssuesDigest 用の完了Issue表現。 */
export interface CompletedIssue {
  identifier: string;
  title: string;
  stateName?: string;
  completedAt?: string | null;
  updatedAt?: string | null;
  /** auto-improve ラベル付き（＝改善サイクルの親Issue自身）は材料から除外する。 */
  isAutoImprove?: boolean;
}

function issueTimeMs(i: CompletedIssue): number {
  const t = i.completedAt || i.updatedAt || '';
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * 完了Issue群から「前回サイクル(sinceIso)以降の新規完了」を判定し、ダイジェスト化する。
 *  - auto-improve 親Issue自身は除外。
 *  - sinceIso が null（＝この project で過去に auto-improve 親が無い＝初回）は bootstrap 扱いで
 *    hasNewMaterial=true とし、存在する完了Issueをそのままダイジェストにする。
 *  - sinceIso があれば、その時刻より後に完了した Issue のみを新材料とみなす。
 */
export function buildRecentIssuesDigest(
  issues: CompletedIssue[],
  sinceIso: string | null,
  maxItems = 8
): { digest?: string; hasNewMaterial: boolean } {
  const usable = (issues || []).filter((i) => !i.isAutoImprove);
  const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
  const hasSince = sinceIso !== null && !Number.isNaN(sinceMs);
  const fresh = hasSince ? usable.filter((i) => issueTimeMs(i) > sinceMs) : usable;
  const sorted = [...fresh].sort((a, b) => issueTimeMs(b) - issueTimeMs(a));
  const hasNewMaterial = hasSince ? sorted.length > 0 : true;
  if (sorted.length === 0) return { digest: undefined, hasNewMaterial };
  const lines = sorted.slice(0, maxItems).map((i) => {
    const when = (i.completedAt || i.updatedAt || '').slice(0, 10);
    const tail = [i.stateName, when].filter(Boolean).join(' ');
    return `- ${i.identifier} ${i.title}${tail ? ` (${tail})` : ''}`;
  });
  const more = sorted.length > maxItems ? `\n… (他 ${sorted.length - maxItems} 件)` : '';
  return { digest: lines.join('\n') + more, hasNewMaterial };
}

/* ============================================================================
 * 収集本体（Linear / Kaggle CLI / ファイル I/O を純関数ヘルパーに橋渡し）
 * ========================================================================== */

export interface KaggleSubmissionCollection {
  rows: KaggleSubmissionRow[];
  failureReason?: string;
}

/** CLIエラーをcredentialを漏らさない短いhealth signalへ正規化する。 */
export function classifyKaggleCliFailure(error: unknown): string {
  const e = error as { message?: string; stderr?: string | Buffer; code?: string };
  const detail = `${e?.stderr?.toString?.() || ''} ${e?.message || ''}`.trim();
  const lower = detail.toLowerCase();
  if (e?.code === 'ENOENT' || lower.includes('not found') || lower.includes('enoent')) {
    return 'measurement unavailable: kaggle CLI is not installed or not on PATH';
  }
  if (
    lower.includes('401')
    || lower.includes('403')
    || lower.includes('unauthorized')
    || lower.includes('authentication')
    || lower.includes('credential')
    || lower.includes('kaggle.json')
    || lower.includes('api token')
  ) {
    return 'measurement unavailable: Kaggle CLI authentication failed; verify cron credentials/API token';
  }
  return 'measurement unavailable: Kaggle submissions API failed; inspect cron log before the next cycle';
}

function collectSubmissionRows(slug: string, log: (m: string) => void): KaggleSubmissionCollection {
  if (!slug) return { rows: [] };
  try {
    const out = execFileSync('kaggle', ['competitions', 'submissions', slug, '--csv'], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { rows: parseKaggleSubmissionsCsv(out) };
  } catch (err: any) {
    log(`kaggle submissions failed for ${slug}: ${err?.message || err}`);
    return { rows: [], failureReason: classifyKaggleCliFailure(err) };
  }
}

/** 公開LBのスコア列を取得する（best-effort・コンペ単位1回）。失敗時は空配列。 */
function collectLeaderboardScores(slug: string, log: (m: string) => void): number[] {
  if (!slug) return [];
  try {
    const out = execFileSync('kaggle', ['competitions', 'leaderboard', slug, '--show', '--csv'], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return parseKaggleLeaderboardScores(out);
  } catch (err: any) {
    log(`kaggle leaderboard failed for ${slug}: ${err?.message || err}`);
    return [];
  }
}

function readFailureLog(explicitPath: string | undefined, log: (m: string) => void): string | undefined {
  const file = explicitPath || path.join(__dirname, '..', '..', 'docs', 'ai', 'failure-log.md');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err: any) {
    log(`failure-log read failed (${file}): ${err?.message || err}`);
    return undefined;
  }
}

/** その project で最後に作られた auto-improve 親Issueの createdAt（ISO）。無ければ null。 */
async function lastAutoImproveCreatedAt(project: string, label: string): Promise<string | null> {
  const data: any = await linearQuery(
    `query($name: String!, $label: String!) {
      issues(filter: {
        project: { name: { eq: $name } },
        labels: { name: { eq: $label } }
      }, first: 20) { nodes { createdAt } }
    }`,
    { name: project, label }
  );
  const nodes: any[] = data?.issues?.nodes ?? [];
  let maxMs = -1;
  let maxIso: string | null = null;
  for (const n of nodes) {
    const iso = n?.createdAt;
    const ms = iso ? Date.parse(iso) : NaN;
    if (!Number.isNaN(ms) && ms > maxMs) { maxMs = ms; maxIso = iso; }
  }
  return maxIso;
}

/** その project の完了(Done)Issueを取得する（auto-improve ラベル有無も付す）。 */
async function fetchCompletedIssues(project: string, label: string): Promise<CompletedIssue[]> {
  const data: any = await linearQuery(
    `query($name: String!) {
      issues(filter: {
        project: { name: { eq: $name } },
        state: { type: { in: ["completed"] } }
      }, first: 50) {
        nodes {
          identifier
          title
          completedAt
          updatedAt
          state { name }
          labels { nodes { name } }
        }
      }
    }`,
    { name: project }
  );
  const nodes: any[] = data?.issues?.nodes ?? [];
  return nodes.map((n) => ({
    identifier: String(n?.identifier ?? ''),
    title: String(n?.title ?? ''),
    stateName: n?.state?.name,
    completedAt: n?.completedAt ?? null,
    updatedAt: n?.updatedAt ?? null,
    isAutoImprove: Array.isArray(n?.labels?.nodes)
      && n.labels.nodes.some((l: any) => l?.name === label),
  }));
}

/**
 * 当番コンペの各ターゲット（claude/gpt）ぶんの material と guard signals を収集する。
 * 全て best-effort。個々の失敗は握りつぶし、安全側（従来の空プレースホルダ／fail-open）に倒す。
 */
export async function collectImproveContext(
  registry: TargetsRegistry,
  competitionKey: string,
  opts: {
    label?: string;
    failureLogPath?: string;
    /** false で Kaggle CLI 呼び出しを無効化（テスト・オフライン用）。既定 true。 */
    kaggle?: boolean;
    log?: (m: string) => void;
    /** score progression JSONL。既定 docs/ai/kaggle/score-progression.jsonl。 */
    scoreProgressionPath?: string;
    /** LB順位履歴 JSONL。既定 docs/ai/kaggle/leaderboard-rank.jsonl。 */
    leaderboardRankPath?: string;
    /** target repo 群の親ディレクトリ（実験台帳の解決に使う）。既定 /workspaces。 */
    targetsRoot?: string;
    /** 同一方式の連続非改善をescalateする回数。既定3。 */
    plateauThreshold?: number;
  } = {}
): Promise<CollectedContext> {
  const label = opts.label || 'auto-improve';
  const log = opts.log || (() => { /* noop */ });
  const signals: Record<string, GuardSignals> = {};
  const material: Record<string, ImprovementMaterial> = {};

  const comp = getCompetition(registry, competitionKey);
  if (!comp) return { signals, material };

  // Kaggle API はコンペ単位で1回だけ取得し、利用時に repo/lineage ごとに分離する。
  const submissionCollection = opts.kaggle === false
    ? { rows: [] }
    : collectSubmissionRows(comp.kaggleCompetition, log);
  const submissionRows = submissionCollection.rows;
  const scoreProgressionPath = opts.scoreProgressionPath
    || path.join(__dirname, '..', '..', 'docs', 'ai', 'kaggle', 'score-progression.jsonl');
  if (submissionRows.length > 0) {
    const appended = appendNewScoreProgression(
      scoreProgressionPath,
      progressionEntriesFromRows(comp, submissionRows)
    );
    if (appended > 0) log(`score progression: appended ${appended} result(s) to ${scoreProgressionPath}`);
  }
  const progression = readScoreProgression(scoreProgressionPath);

  // LB順位（一次KPI, design §42）: コンペ単位で1回だけ取得し、repo ごとに順位を計算・履歴化する。
  const leaderboardScores = opts.kaggle === false
    ? []
    : collectLeaderboardScores(comp.kaggleCompetition, log);
  const leaderboardRankPath = opts.leaderboardRankPath
    || path.join(__dirname, '..', '..', 'docs', 'ai', 'kaggle', 'leaderboard-rank.jsonl');
  const targetsRoot = opts.targetsRoot || '/workspaces';
  const observedAt = new Date().toISOString();

  // failure-log も1回だけ読む。
  const failureContent = readFailureLog(opts.failureLogPath, log);

  for (const t of comp.targets) {
    const targetSubmissionRows = submissionRowsForRepo(submissionRows, t.repo, {
      singleTarget: comp.targets.length === 1,
    });
    const previousSubmission = formatPreviousSubmission(targetSubmissionRows);
    // SOT-2518 P8: 提出健全性（broken=ERROR/0.000/未スコア連続）。本文の submit-repair 切替に使う。
    // SOT-2519: broken 判定の連続回数閾値は registry で上書き可（欠落時は既定 SUBMISSION_BROKEN_CONSECUTIVE）。
    const submissionHealth = detectSubmissionHealth(
      targetSubmissionRows,
      comp.validation.brokenSubmissionConsecutive ?? SUBMISSION_BROKEN_CONSECUTIVE
    );
    // guard 4: 前サイクル未完了。失敗時は安全側で false（＝ブロックしない）に倒す。
    let hasUnfinishedCycle = false;
    try {
      hasUnfinishedCycle = !!(await findOpenAutoImproveIssue(t.project, label));
    } catch (err: any) {
      log(`findOpenAutoImproveIssue failed for ${t.project}: ${err?.message || err}`);
    }

    // guard 5 + 完了Issueダイジェスト。失敗時は fail-open（hasNewMaterial=true, digest 無し）。
    let digest: string | undefined;
    let hasNewMaterial = true;
    try {
      const sinceIso = await lastAutoImproveCreatedAt(t.project, label);
      const issues = await fetchCompletedIssues(t.project, label);
      const r = buildRecentIssuesDigest(issues, sinceIso);
      digest = r.digest;
      hasNewMaterial = r.hasNewMaterial || hasSubmissionSince(targetSubmissionRows, sinceIso);
    } catch (err: any) {
      log(`recent-issues collection failed for ${t.project}: ${err?.message || err}`);
    }

    const failureKpiExcerpt = failureContent
      ? filterFailureLog(failureContent, [t.repo, comp.key])
      : undefined;

    const plateau = detectScorePlateau(progression, t.repo, opts.plateauThreshold ?? 3);

    // 自分の best public score を submission 履歴の生行から直接取る（score-progression.jsonl は
    // `[repo:...]` 帰属マーカーが無いと空になり順位を出せないため、そこに依存しない）。生行から
    // 取れない場合のみ score-progression にフォールバックする。LB順位・CV↔public gap の両方で使う。
    const direction = comp.scoreDirection;
    const repoScores = progression
      .filter((entry) => entry.repo === t.repo)
      .map((entry) => entry.publicScore);
    const progressionBest = repoScores.length > 0
      ? repoScores.reduce((best, s) =>
          (direction === 'max' ? s > best : s < best) ? s : best, repoScores[0])
      : undefined;
    const bestPublicScore =
      bestPublicScoreFromRows(targetSubmissionRows, direction) ?? progressionBest;

    // LB順位サマリ + 順位履歴（best-effort）。ローカル評価は代理指標、順位は二次sanity（SOT-2513）。
    let leaderboardSummary: string | undefined;
    // SOT-2518 P9: 実LB順位トレンド（低下傾向で相対 rating コンペの「維持=後退」を検知）。
    let rankTrendSummary: string | undefined;
    try {
      if (bestPublicScore !== undefined && leaderboardScores.length > 0) {
        const standing = computePublicRank(leaderboardScores, bestPublicScore, direction);
        const entry: LeaderboardRankEntry = {
          observedAt,
          competition: comp.key,
          kaggleCompetition: comp.kaggleCompetition,
          repo: t.repo,
          lineage: t.lineage,
          bestPublicScore,
          rank: standing.rank,
          totalListed: standing.totalListed,
          ...(standing.topScore !== undefined ? { topScore: standing.topScore } : {}),
          ...(standing.gapToTop !== undefined ? { gapToTop: standing.gapToTop } : {}),
          fingerprint: leaderboardRankFingerprint(comp.key, t.repo, observedAt),
        };
        appendLeaderboardRank(leaderboardRankPath, [entry]);
        const history = readLeaderboardRankHistory(leaderboardRankPath)
          .filter((h) => h.repo === t.repo)
          .slice(-5);
        const trend = history
          .map((h) => (h.rank === null ? `圏外(top${h.totalListed})` : `${h.rank}位`))
          .join(' → ');
        // 2観測以上あるときだけトレンド（維持=後退検知）を材料に供給する。
        if (history.length >= 2) {
          const rt = computeRankTrend(
            history.map((h) => ({ rank: h.rank, totalListed: h.totalListed, observedAt: h.observedAt }))
          );
          rankTrendSummary = rt.summary;
        }
        const rankLabel = standing.rank === null
          ? `圏外（表示中の top${standing.totalListed} 未満）`
          : `${standing.rank}位 / 表示${standing.totalListed}チーム`;
        leaderboardSummary = [
          `- best public score: ${bestPublicScore} (${direction === 'max' ? '高いほど良い' : '低いほど良い'})`,
          `- 現在順位(公開LB): ${rankLabel}`,
          ...(standing.topScore !== undefined
            ? [`- LB首位: ${standing.topScore}（差: ${standing.gapToTop}）`]
            : []),
          ...(trend ? [`- 順位推移(直近${history.length}観測): ${trend}`] : []),
        ].join('\n');
      }
    } catch (err: any) {
      log(`leaderboard summary failed for ${t.repo}: ${err?.message || err}`);
    }

    // SOT-2514: leak-free CV レポート → cvSummary / CV↔public gap / 参照超過(P5) / gap 推移。
    // 全て best-effort。cv_report が無ければ本文は SOT-2513 の fail-safe（「CV未整備…」）に落ちる。
    let cvSummary: string | undefined;
    let cvPublicGap: number | undefined;
    let cvPublicGapSummary: string | undefined;
    let cvPublicGapWarnThreshold: number | undefined;
    let referenceOverfitWarn: string | undefined;
    let cvPublicGapTrend: string | undefined;
    try {
      const repoDir = path.join(targetsRoot, t.repo);
      const cvReportRel = comp.validation.cvReportPath || DEFAULT_CV_REPORT_PATH;
      const cvResult = readCvReport(path.join(repoDir, cvReportRel), log);
      if (cvResult.violation) {
        // スキーマ不正/行単位CV → 契約違反警告を cvSummary に載せる（本文の一次CV行に表示）。
        cvSummary = cvResult.violation;
      } else if (cvResult.report) {
        cvSummary = formatCvSummary(cvResult.report);
        if (bestPublicScore !== undefined) {
          const gap = computeCvPublicGap(cvResult.report.score, bestPublicScore);
          cvPublicGap = gap.relative;
          cvPublicGapWarnThreshold = CV_PUBLIC_GAP_RELATIVE_WARN;
          cvPublicGapSummary = formatCvPublicGapSummary(gap);
        }
        // gap 推移（cv_report_history.jsonl があれば拡大傾向を診断）。
        const historyRel = cvReportRel.replace(/\.json$/i, '_history.jsonl');
        try {
          cvPublicGapTrend = formatCvGapTrend(
            parseCvGapHistory(fs.readFileSync(path.join(repoDir, historyRel), 'utf8'))
          );
        } catch {
          /* 履歴なし — 推移は出さない */
        }
      }
      // 参照実装 public 超過（P5）: registry validation の reference_public_score を基準にする。
      const ref = comp.validation.referencePublicScore;
      if (ref !== undefined && bestPublicScore !== undefined) {
        referenceOverfitWarn = referenceOverfitWarning(bestPublicScore, ref, direction);
      }
    } catch (err: any) {
      log(`cv report/gap collection failed for ${t.repo}: ${err?.message || err}`);
    }

    // 実験台帳ダイジェスト（design §48）: target repo の docs/ai/experiment_ledger.jsonl を読む。
    let experimentLedgerDigest: string | undefined;
    try {
      const ledgerPath = defaultExperimentLedgerPath(path.join(targetsRoot, t.repo));
      const entries = readExperimentLedger(ledgerPath);
      if (entries.length > 0) experimentLedgerDigest = summarizeExperimentLedger(entries);
    } catch (err: any) {
      log(`experiment ledger read failed for ${t.repo}: ${err?.message || err}`);
    }

    signals[t.project] = {
      hasUnfinishedCycle,
      hasNewMaterial,
      ...(submissionCollection.failureReason
        ? { measurementFailureReason: submissionCollection.failureReason }
        : {}),
      ...(plateau.plateau && plateau.reason ? { plateauReason: plateau.reason } : {}),
    };
    material[t.project] = {
      previousSubmission,
      recentIssuesDigest: digest,
      failureKpiExcerpt,
      ...(leaderboardSummary ? { leaderboardSummary } : {}),
      ...(cvSummary ? { cvSummary } : {}),
      ...(cvPublicGap !== undefined ? { cvPublicGap } : {}),
      ...(cvPublicGapWarnThreshold !== undefined ? { cvPublicGapWarnThreshold } : {}),
      ...(cvPublicGapSummary ? { cvPublicGapSummary } : {}),
      ...(referenceOverfitWarn ? { referenceOverfitWarning: referenceOverfitWarn } : {}),
      ...(cvPublicGapTrend ? { cvPublicGapTrend } : {}),
      ...(experimentLedgerDigest ? { experimentLedgerDigest } : {}),
      submissionHealth: submissionHealth.status,
      ...(submissionHealth.reason ? { submissionHealthReason: submissionHealth.reason } : {}),
      ...(submissionHealth.consecutiveBroken > 0
        ? { submissionHealthConsecutive: submissionHealth.consecutiveBroken }
        : {}),
      ...(rankTrendSummary ? { rankTrend: rankTrendSummary } : {}),
    };
  }

  return { signals, material };
}

/** collectAllocationSignals が返す per-target 詳細（自動 maintain 判定に使う）。 */
export interface AllocationTargetSignal {
  competition: string;
  repo: string;
  lineage: 'claude' | 'gpt';
  mode: 'improve' | 'maintain';
  priority: number;
  consecutiveNonImproving: number;
  recentlyPromoted: boolean;
  rank: number | null;
  eligible: boolean;
}

export interface AllocationSignals {
  candidates: CompetitionCandidate[];
  targets: AllocationTargetSignal[];
}

/**
 * 全コンペの priority シグナルを履歴ファイルだけから決定的に収集する（design §50 資源配分）。
 * Kaggle CLI / LLM は呼ばない（動的セレクタは全コンペを安価に価格付けし、勝者だけ後で material 収集
 * する）。唯一の外部呼び出しは Linear の hasOpenCycle 判定（重複起案防止）。全て best-effort。
 */
export async function collectAllocationSignals(
  registry: TargetsRegistry,
  opts: {
    label?: string;
    scoreProgressionPath?: string;
    leaderboardRankPath?: string;
    targetsRoot?: string;
    nowUtc?: string;
    weights?: PriorityWeights;
    plateauThreshold?: number;
    log?: (m: string) => void;
  } = {}
): Promise<AllocationSignals> {
  const label = opts.label || 'auto-improve';
  const log = opts.log || (() => { /* noop */ });
  const nowUtc = opts.nowUtc || new Date().toISOString();
  const threshold = opts.plateauThreshold ?? 3;
  const scoreProgressionPath = opts.scoreProgressionPath
    || path.join(__dirname, '..', '..', 'docs', 'ai', 'kaggle', 'score-progression.jsonl');
  const leaderboardRankPath = opts.leaderboardRankPath
    || path.join(__dirname, '..', '..', 'docs', 'ai', 'kaggle', 'leaderboard-rank.jsonl');
  const targetsRoot = opts.targetsRoot || '/workspaces';

  const progression = readScoreProgression(scoreProgressionPath);
  const rankHistory = readLeaderboardRankHistory(leaderboardRankPath);

  const candidates: CompetitionCandidate[] = [];
  const targets: AllocationTargetSignal[] = [];
  for (const comp of registry.competitions) {
    const phase = resolveCompetitionPhase(comp, nowUtc).phase;
    let compPriority = 0;
    let compEligible = false;
    for (const t of comp.targets) {
      const plateau = detectScorePlateau(progression, t.repo, threshold);
      // 直近の順位（repo の最新 leaderboard-rank エントリ）。
      const repoRanks = rankHistory
        .filter((h) => h.repo === t.repo)
        .sort((a, b) => Date.parse(a.observedAt || '') - Date.parse(b.observedAt || ''));
      const latestRank = repoRanks[repoRanks.length - 1];
      // recentlyPromoted: 実験台帳の最新が promoted、または直近スコアが best を更新（streak=0）。
      let ledgerPromoted = false;
      try {
        const entries = readExperimentLedger(
          defaultExperimentLedgerPath(path.join(targetsRoot, t.repo))
        );
        if (entries.length > 0) {
          const latest = entries.reduce((a, b) =>
            Date.parse(b.recordedAt || '') >= Date.parse(a.recordedAt || '') ? b : a
          );
          ledgerPromoted = latest.result === 'promoted';
        }
      } catch (err: any) {
        log(`allocation ledger read failed for ${t.repo}: ${err?.message || err}`);
      }
      const recentlyPromoted =
        ledgerPromoted ||
        (plateau.consecutiveNonImproving === 0 && plateau.latestScore !== undefined);

      let hasOpenCycle = false;
      try {
        hasOpenCycle = !!(await findOpenAutoImproveIssue(t.project, label));
      } catch (err: any) {
        log(`allocation open-cycle check failed for ${t.project}: ${err?.message || err}`);
      }

      const priority = computeTargetPriority(
        {
          mode: t.mode,
          phase,
          recentlyPromoted,
          consecutiveNonImproving: plateau.consecutiveNonImproving,
          plateauThreshold: threshold,
          rank: latestRank?.rank ?? null,
          totalListed: latestRank?.totalListed ?? 0,
        },
        opts.weights
      );
      const targetEligible = t.mode === 'improve' && phase !== 'closed' && !hasOpenCycle;
      if (targetEligible) {
        compEligible = true;
        if (priority > compPriority) compPriority = priority;
      }
      targets.push({
        competition: comp.key,
        repo: t.repo,
        lineage: t.lineage,
        mode: t.mode,
        priority,
        consecutiveNonImproving: plateau.consecutiveNonImproving,
        recentlyPromoted,
        rank: latestRank?.rank ?? null,
        eligible: targetEligible,
      });
    }
    candidates.push({ key: comp.key, priority: compPriority, eligible: compEligible });
  }
  return { candidates, targets };
}
