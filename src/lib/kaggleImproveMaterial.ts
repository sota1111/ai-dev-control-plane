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
import type { GuardSignals, ImprovementMaterial, Lineage, OracleDriftSignal, StagnationForensics, SubmissionPolicy, TargetsRegistry } from './kaggleImprovement.js';
import { getCompetition, resolveCompetitionPhase } from './kaggleImprovement.js';
import {
  computeTargetPriority,
  type CompetitionCandidate,
  type PriorityWeights,
} from './resourceAllocation.js';
import { findOpenImproveCycleParent, linearQuery } from './linearApi.js';
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
import type { ExperimentLedgerEntry } from './experimentLedger.js';

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

/** submission 行の date（"YYYY-MM-DD HH:MM:SS(.fff)"）を epoch ms に。解釈不能なら null。 */
function submissionRowEpochMs(row: KaggleSubmissionRow): number | null {
  if (!row.date) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(row.date)
    ? `${row.date.replace(' ', 'T').replace(/(\.\d+)?$/, '')}Z`
    : /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      ? `${row.date}T00:00:00Z`
      : row.date;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 「本日の提出予算」ダイジェスト（日次枠効率化）。改善ゲート＋spacing/reserve を worker が適用する材料。
 * 提出が枠を消費した行 = ERROR/CANCELLED 以外（shell の TOTAL_TODAY と同じ扱い）。純粋関数（now を注入）。
 */
export function buildSubmissionBudgetDigest(
  rows: KaggleSubmissionRow[],
  cap: number,
  policy: SubmissionPolicy | undefined,
  nowMs: number
): string {
  const reserve = Math.max(0, policy?.dailyReserve ?? 0);
  const minIntervalMin = Math.max(0, policy?.minIntervalMin ?? 0);
  const effectiveCap = Math.max(1, cap - reserve);
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
  const consuming = rows.filter((r) => {
    const s = (r.status || '').toUpperCase();
    return !s.includes('ERROR') && !s.includes('CANCEL');
  });
  const todayCount = consuming.filter((r) => (r.date || '').slice(0, 10) === todayUtc).length;
  const remaining = Math.max(0, cap - todayCount);
  const loopRemaining = Math.max(0, effectiveCap - todayCount);
  const epochs = consuming
    .map(submissionRowEpochMs)
    .filter((v): v is number => typeof v === 'number');
  const lastMs = epochs.length ? Math.max(...epochs) : null;
  const sinceMin = lastMs != null ? Math.floor((nowMs - lastMs) / 60000) : null;
  const spacingOk = minIntervalMin === 0 || sinceMin == null || sinceMin >= minIntervalMin;
  const lastStr =
    lastMs != null ? `${new Date(lastMs).toISOString().replace('T', ' ').slice(0, 19)}Z（${sinceMin}分前）` : 'なし';
  const spacingOkNow = spacingOk;
  const spacingLine =
    minIntervalMin > 0
      ? `- spacing: 最小間隔 ${minIntervalMin}分 / 直近提出 ${lastStr} → ${spacingOkNow ? '提出可（間隔OK）' : `**あと約${Math.max(0, minIntervalMin - (sinceMin ?? 0))}分は見送り**`}`
      : `- spacing: 無効（最小間隔0）/ 直近提出 ${lastStr}`;
  // 日次プローブ枠（プラトー打破）: 一定時間提出が無く枠が残り spacing もOKなら、改善ゲート未達でも
  // 「性質の異なる gap-closing/hedge 候補」を1件提出してLBを探る due を出す。
  const probeAfterHours = Math.max(0, policy?.probeAfterHours ?? 0);
  const sinceHours = sinceMin != null ? sinceMin / 60 : null;
  const probeDue =
    probeAfterHours > 0 &&
    loopRemaining > 0 &&
    spacingOkNow &&
    (sinceHours == null || sinceHours >= probeAfterHours);
  const probeLine = probeDue
    ? `- 🔎 **プローブ提出 due**: 直近提出 ${lastStr} が ${probeAfterHours}h 以上前で実効枠 ${loopRemaining} 残。` +
      ` 改善ゲート未達でも **前回提出と別 artifact の gap-closing/hedge 候補を1件提出**し LB を探ること` +
      `（public LB 首位との差が大きい間は plateau=天井ではない。公開上位ノート/baseline 移植で gap を埋める）。`
    : probeAfterHours > 0
      ? `- プローブ枠: due でない（直近提出 ${lastStr} / 閾値 ${probeAfterHours}h / 実効枠 ${loopRemaining}）`
      : '';
  return [
    `- 本日(UTC ${todayUtc})の消費枠: ${todayCount}/${cap}（残 ${remaining}）`,
    `- 自動ループ実効枠: ${loopRemaining} 残（cap ${cap} − reserve ${reserve}；reserve は終盤の強い候補用に温存）`,
    spacingLine,
    ...(probeLine ? [probeLine] : []),
    `- 提出判断: **leak-free CV が前回*提出*をノイズ幅超えで上回った時のみ**（＝改善ゲート）。ただし上記プローブ枠が` +
      ` due の時、または public LB に明確な伸びしろがある時は、gap-closing 候補を作って枠を使い LB を動かすことを優先。`,
  ].join('\n');
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

/* ============================================================================
 * SOT-2745: oracle-drift シグナル算出（proxy飽和 × 真KPI停滞を history から決定論的に）
 * ==========================================================================
 * SIGNATE rank-26 post-mortem（自作gold一致 net proxy を99まで上げたが真値精度88.5%停滞・機構が
 * re-anchor しなかった）の再発防止。engine primitive（detectOracleDrift / buildOracleDriftBanner）は
 * PR #391 で導入済み。ここは材料収集が `proxySaturated` / `trueKpiStagnant` / `stagnantCycles` を
 * 実データ history から供給する wiring（供給が無い間バナーは inert）。 */

/** proxy(ローカル指標: leak-free CV / gold net)の直近改善が「頭打ち」とみなす既定の最小改善幅（方向つき絶対値）。 */
export const DEFAULT_PROXY_SATURATION_MIN_IMPROVEMENT = 0.005;
/** 真の一次KPI(実LB順位)が「有意に動いた」とみなす既定の最小改善幅（順位=1つ以上上げる）。未満は停滞。 */
export const DEFAULT_TRUE_KPI_MIN_IMPROVEMENT = 1;

/**
 * cv_report_history.jsonl の各行から leak-free CV スコア系列（古い→新しい順）を抽出する。行は
 * `{score: number, ...}` を受け付け、`score` を持たない/不正な行は握りつぶす（parseCvGapHistory と同源の履歴）。
 */
export function parseCvScoreHistory(content: string): number[] {
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
    if (obj && typeof obj === 'object' && typeof obj.score === 'number' && Number.isFinite(obj.score)) {
      out.push(obj.score);
    }
  }
  return out;
}

/** 方向つき改善幅。max=大きいほど良い(cur-prev)、min=小さいほど良い(prev-cur)。正=改善。 */
function directionalGain(prev: number, cur: number, direction: 'max' | 'min'): number {
  return direction === 'max' ? cur - prev : prev - cur;
}

/** computeOracleDriftSignal に渡す1系列（proxy / 真KPI）。 */
export interface OracleDriftSeries {
  /** 時系列（古い→新しい順）の数値。 */
  series: number[];
  /** 良い方向（max=大きいほど良い / min=小さいほど良い。順位は min）。 */
  direction: 'max' | 'min';
  /** これ未満の方向つき改善は「動いていない（飽和/停滞）」とみなす閾値。 */
  minImprovement: number;
  /** 表示名（本文の detail 用。例 "leak-free CV" / "public LB 順位"）。 */
  name?: string;
}

/**
 * proxy(ローカル指標)系列と真の一次KPI系列から oracle-drift シグナルを**決定論的に**算出する（SOT-2745）。
 *  - 両系列の末尾を揃え、隣接ステップごとに「proxy改善 < proxy.minImprovement（頭打ち）」かつ
 *    「真KPI改善 < trueKpi.minImprovement（停滞）」を **drift ステップ** とみなす。
 *  - 末尾から連続する drift ステップ数を `stagnantCycles` に載せる（detectOracleDrift が閾値と突き合わせる）。
 *  - `proxySaturated` / `trueKpiStagnant` は直近ステップの各条件（両方 true のときだけ最新が drift）。
 *  - **どちらかの系列が 2 点未満（履歴欠落）なら signal を立てない（undefined）** = silent-safe（従来挙動）。
 *    片方だけの飽和/停滞は signal は立つが detectOracleDrift 側で `none`（＝バナー不発火）になる。
 */
export function computeOracleDriftSignal(
  proxy: OracleDriftSeries,
  trueKpi: OracleDriftSeries
): OracleDriftSignal | undefined {
  const p = (proxy?.series || []).filter((n) => Number.isFinite(n));
  const t = (trueKpi?.series || []).filter((n) => Number.isFinite(n));
  // 履歴欠落 → fail-safe に signal を立てない（silent-safe）。
  if (p.length < 2 || t.length < 2) return undefined;

  // 両系列の末尾を揃えてステップ単位で drift 判定する（両 history はサイクルごとに append される）。
  const n = Math.min(p.length, t.length);
  const pTail = p.slice(p.length - n);
  const tTail = t.slice(t.length - n);
  const driftSteps: boolean[] = [];
  for (let i = 1; i < n; i++) {
    const proxyStalled = directionalGain(pTail[i - 1], pTail[i], proxy.direction) < proxy.minImprovement;
    const trueStalled = directionalGain(tTail[i - 1], tTail[i], trueKpi.direction) < trueKpi.minImprovement;
    driftSteps.push(proxyStalled && trueStalled);
  }
  // 末尾から連続する drift ステップ数。
  let stagnantCycles = 0;
  for (let i = driftSteps.length - 1; i >= 0; i--) {
    if (driftSteps[i]) stagnantCycles++;
    else break;
  }
  const proxySaturated = directionalGain(pTail[n - 2], pTail[n - 1], proxy.direction) < proxy.minImprovement;
  const trueKpiStagnant = directionalGain(tTail[n - 2], tTail[n - 1], trueKpi.direction) < trueKpi.minImprovement;

  const fmt = (arr: number[]) => arr.map((v) => round4(v)).join(' → ');
  const detail =
    `proxy(${proxy.name || 'ローカル指標'})=${fmt(pTail)} / ` +
    `真KPI(${trueKpi.name || '一次KPI'})=${fmt(tTail)} — ` +
    `proxy飽和×真KPI停滞の連続=${stagnantCycles}サイクル`;

  return {
    ...(proxy.name ? { proxyKpiName: proxy.name } : {}),
    proxySaturated,
    ...(trueKpi.name ? { trueKpiName: trueKpi.name } : {}),
    trueKpiStagnant,
    stagnantCycles,
    detail,
  };
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
/** 外部知識の"採用"を試みた軸（研究含む）を識別する（内部oracle/policy改善とは区別）。 */
const EXTERNAL_ADOPT_AXIS_RE =
  /external[- ]?(solution|knowledge)|top[- ]?solution|wholesale|role[- ]?a['’]?\b|public[- ]?(agent|baseline|notebook|solution)|frontier|上位解|公開(ノート|agent|baseline)|丸ごと採用|移植/i;
/**
 * 親の集約/提出判定など「サイクル境界の帳簿エントリ」を識別して採用試行カウントから除外する
 * （"external-knowledge parent aggregation and submission" 等を採用と誤カウントしない）。
 */
const PARENT_BOOKKEEPING_AXIS_RE =
  /\bparent\b.*(aggregation|resume|submission|decision|integration)|(aggregation|resume|integration).*\bparent\b|親.*(集約|再開|統合|提出判定)|axis selection|decomposition/i;
/** 「丸ごと採用（役割A'・土台差し替え）」軸を識別する。 */
const WHOLESALE_AXIS_RE = /wholesale|role[- ]?a['’]|丸ごと採用|independent foundation/i;
/**
 * 「可搬性の検証そのもの」を目的にした軸を識別する（採用軸に含まれる形容詞 "portable" では発火しない）。
 * 例: "portability re-verification of top notebooks" / "可搬性の再検証"。
 */
const PORTABILITY_VERIFY_AXIS_RE =
  /portability[- ]?(re[- ]?)?(verif|check|audit|assessment|recheck)|可搬性(の)?(再)?(検証|検討|監査|確認)/i;
/** 「非可搬（天井）」の結論を示す語。 */
const NONPORTABLE_EVIDENCE_RE = /non[- ]?portable|非可搬|GPU|weights|天井|ceiling/i;

/**
 * サイクル内自己監査（恒久対策・design §5）: experiment_ledger.jsonl から停滞の「型」を決定論的に算出する。
 * LLM判断ゼロ＝監査可能。buildCorrectiveDirectiveBanner（kaggleImprovement）がこの結果から是正指示を注入する。
 * 空配列（台帳なし）は undefined（後方互換＝バナー非発火）。
 */
export function computeStagnationForensics(
  entries: ExperimentLedgerEntry[]
): StagnationForensics | undefined {
  if (!entries || entries.length === 0) return undefined;
  const latestCycle = entries.reduce(
    (m, e) => (typeof e.cycle === 'number' && e.cycle > m ? e.cycle : m),
    0
  );
  const promotedEver = entries.some((e) => e.result === 'promoted');
  const lastPromotedCycle = entries.reduce(
    (m, e) => (e.result === 'promoted' && typeof e.cycle === 'number' && e.cycle > m ? e.cycle : m),
    -1
  );
  const cyclesSinceLastPromotion = lastPromotedCycle < 0 ? latestCycle : latestCycle - lastPromotedCycle;
  // paradigm 移行の着手記録（型E の directive が axis に "paradigm" を含めて記録させる）。
  const paradigmAttempted = entries.some((e) => /paradigm/i.test(e.axis));

  let externalAdoptAttempts = 0;
  let externalAdoptPromoted = 0;
  let externalAdoptInconclusive = 0;
  for (const e of entries) {
    if (!EXTERNAL_ADOPT_AXIS_RE.test(e.axis)) continue;
    // 親集約/提出判定/軸選定などの帳簿エントリは「採用の試行」ではないので除外する。
    if (PARENT_BOOKKEEPING_AXIS_RE.test(e.axis)) continue;
    externalAdoptAttempts++;
    if (e.result === 'promoted') externalAdoptPromoted++;
    else if (e.result === 'inconclusive') externalAdoptInconclusive++;
  }

  // 丸ごと採用軸の「最新の確定結果（promoted/rejected）」。inconclusive は確定でないので never のまま。
  let wholesaleAdoptOutcome: 'promoted' | 'rejected' | 'never' = 'never';
  let latestWholesaleTs = -Infinity;
  for (const e of entries) {
    if (!WHOLESALE_AXIS_RE.test(e.axis)) continue;
    if (e.result !== 'promoted' && e.result !== 'rejected') continue;
    const ts = Date.parse(e.recordedAt || '') || 0;
    if (ts >= latestWholesaleTs) {
      latestWholesaleTs = ts;
      wholesaleAdoptOutcome = e.result;
    }
  }

  const portabilityVerifiedNonPortable = entries.some(
    (e) =>
      PORTABILITY_VERIFY_AXIS_RE.test(e.axis) &&
      NONPORTABLE_EVIDENCE_RE.test(`${e.axis} ${e.evidence || ''} ${e.hypothesis || ''}`)
  );

  return {
    latestCycle,
    promotedEver,
    cyclesSinceLastPromotion,
    paradigmAttempted,
    externalAdoptAttempts,
    externalAdoptPromoted,
    externalAdoptInconclusive,
    wholesaleAdoptOutcome,
    portabilityVerifiedNonPortable,
  };
}

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

/** `kaggle kernels list --sort-by scoreDescending --csv` の1行（列 ref,title,author,lastRunTime,totalVotes）。 */
export interface PublicKernelRow {
  ref: string;
  title: string;
  votes?: number;
}

/**
 * `kaggle kernels list --competition <slug> --sort-by scoreDescending --csv` の出力をパースする。
 * Kaggle CLI は**数値スコアを列に出さない**ため、返るのは「スコア降順の並び（上位＝高得点）」＋ref/title/votes。
 */
export function parseTopPublicKernels(csv: string): PublicKernelRow[] {
  const lines = (csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => /(^|,)ref(,|$)/i.test(l) && /title/i.test(l));
  if (headerIdx < 0) return [];
  const header = splitCsvLine(lines[headerIdx]).map((h) => h.trim().toLowerCase());
  const iRef = header.indexOf('ref');
  const iTitle = header.indexOf('title');
  const iVotes = header.indexOf('totalvotes');
  const out: PublicKernelRow[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cols = splitCsvLine(line);
    const ref = (cols[iRef] || '').trim();
    if (!ref) continue;
    const votesRaw = iVotes >= 0 ? Number((cols[iVotes] || '').trim()) : NaN;
    out.push({
      ref,
      title: (cols[iTitle] || '').trim(),
      ...(Number.isFinite(votesRaw) ? { votes: votesRaw } : {}),
    });
  }
  return out;
}

/** タイトル/ref に public メトリクスhack・過学習の匂いがあるか（過学習ガードの目印）。 */
function looksLikePublicOverfit(k: PublicKernelRow): boolean {
  return /metric[\s_-]*hack|public[\s_-]*holdout|\bleak|overfit|magic|lb[\s_-]*probe/i.test(
    `${k.ref} ${k.title}`
  );
}

/**
 * 高得点公開ノート（スコア降順・上位N）を **手法参照用**にダイジェスト化する。数値スコアは非公開のため
 * 「並び＝高得点順」であること、および **public 過学習を避ける参照方針**を明記する（ユーザ要望）。
 */
export function buildPublicNotebooksDigest(
  kernels: PublicKernelRow[],
  opts: { limit?: number } = {}
): string | undefined {
  const limit = opts.limit ?? 8;
  const top = kernels.slice(0, limit);
  if (top.length === 0) return undefined;
  const listed = top
    .map((k, i) => {
      const hack = looksLikePublicOverfit(k) ? ' ⚠public過学習の疑い(hack/holdout/leak)' : '';
      const votes = typeof k.votes === 'number' ? `, ▲${k.votes}` : '';
      return `${i + 1}. \`${k.ref}\` — ${k.title || '(no title)'}${votes}${hack}`;
    })
    .join('\n');
  return [
    listed,
    '',
    '**参照方針（public スコア過学習を避ける）**:',
    '- 参照するのは **手法**（アーキ/前処理/特徴量/後処理/**CV設計**）であって public スコアへ合わせ込むためではない。' +
      '一次KPIは **leak-free CV**（public は二次 sanity）。自分の public/LB順位との差は上記「検証階層」を参照。',
    '- ⚠ 付きノートは **public メトリクス hack / public holdout / leak** の可能性（public高↔private崩壊）。' +
      '手法の genuine 性を吟味し、hack 系は移植しない（または性質の異なる hedge としてのみ扱う）。',
    '- 移植候補は必ず **leak-free CV / robust 分布で検証**してから昇格。最終2枠は **CV最良×性質の異なる hedge** で' +
      '分散（public best 一辺倒は禁止・rogii 過学習全滅の再発防止）。',
  ].join('\n');
}

/** 高得点公開ノートをコンペ単位で1回取得（best-effort・失敗時 undefined）。 */
function collectTopPublicKernels(slug: string, log: (m: string) => void): PublicKernelRow[] {
  if (!slug) return [];
  try {
    const out = execFileSync(
      'kaggle',
      ['kernels', 'list', '--competition', slug, '--sort-by', 'scoreDescending', '--page-size', '12', '--csv'],
      { encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return parseTopPublicKernels(out);
  } catch (err: any) {
    log(`kaggle kernels list failed for ${slug}: ${err?.message || err}`);
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

/** 申し送りコメントの本文へ載せる最大文字数（材料は生 digest だが Issue 本文の肥大は避ける）。 */
const HANDOFF_MAX_CHARS = 1600;

/**
 * 前回サイクル親Issue（同 project・auto-improve ラベルの最新 Issue）の申し送りコメントを返す。
 * `## 申し送り` を含む最新コメントの本文（先頭 HANDOFF_MAX_CHARS 文字）。無ければ undefined。
 * signate Sonnet サイクルの申し送りループの移植 — 前任の判断・閉じた軸・次の軸候補を次サイクルへ渡す。
 */
async function latestCycleHandoff(project: string, label: string): Promise<string | undefined> {
  const data: any = await linearQuery(
    `query($name: String!, $label: String!) {
      issues(filter: {
        project: { name: { eq: $name } },
        labels: { name: { eq: $label } }
      }, first: 20) {
        nodes {
          identifier
          createdAt
          comments(first: 50) { nodes { body createdAt } }
        }
      }
    }`,
    { name: project, label }
  );
  const nodes: any[] = data?.issues?.nodes ?? [];
  if (nodes.length === 0) return undefined;
  const latestIssue = nodes.reduce((best, n) => {
    const bm = best?.createdAt ? Date.parse(best.createdAt) : -1;
    const nm = n?.createdAt ? Date.parse(n.createdAt) : -1;
    return nm > bm ? n : best;
  }, nodes[0]);
  const comments: any[] = latestIssue?.comments?.nodes ?? [];
  const handoffs = comments
    .filter((c) => typeof c?.body === 'string' && c.body.includes('## 申し送り'))
    .sort((a, b) => Date.parse(a?.createdAt ?? 0) - Date.parse(b?.createdAt ?? 0));
  const latest = handoffs.length > 0 ? handoffs[handoffs.length - 1] : null;
  if (!latest) return undefined;
  const body: string = latest.body.trim();
  const clipped = body.length > HANDOFF_MAX_CHARS ? `${body.slice(0, HANDOFF_MAX_CHARS)}\n…(截断)` : body;
  return `（${latestIssue.identifier} より）\n${clipped}`;
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
  // 高得点公開ノート（スコア降順・手法参照用）: コンペ単位で1回取得し全ターゲットの material へ配る。
  const publicNotebooksDigest =
    opts.kaggle === false
      ? undefined
      : buildPublicNotebooksDigest(collectTopPublicKernels(comp.kaggleCompetition, log));
  const leaderboardRankPath = opts.leaderboardRankPath
    || path.join(__dirname, '..', '..', 'docs', 'ai', 'kaggle', 'leaderboard-rank.jsonl');
  const targetsRoot = opts.targetsRoot || '/workspaces';
  const observedAt = new Date().toISOString();

  // failure-log も1回だけ読む。
  const failureContent = readFailureLog(opts.failureLogPath, log);

  // 系統間 divergence（#5）: 各系統の台帳 digest を控え、後段で相手系統の材料として供給する。
  const ledgerDigestByLineage: Partial<Record<Lineage, { repo: string; digest: string }>> = {};

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
    // guard 4: 前サイクル未完了。完了駆動ループでは In Review 親（子実装待ち／統合・提出フェーズ）も
    // 未完了として数える（旧JST枠が隠していた重複起票窓を塞ぐ）。失敗時は安全側で false（＝ブロックしない）。
    let hasUnfinishedCycle = false;
    try {
      hasUnfinishedCycle = !!(await findOpenImproveCycleParent(t.project, label));
    } catch (err: any) {
      log(`findOpenImproveCycleParent failed for ${t.project}: ${err?.message || err}`);
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
    // SOT-2520: 構造化 direction（本文が declining を文字列 sniff せず判定するため）。
    let rankTrendDirection: RankTrend['direction'] | undefined;
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
          rankTrendDirection = rt.direction;
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
    // サイクル内自己監査（恒久対策）: 同じ台帳から停滞の型を決定論的に算出する。
    let stagnationForensics: StagnationForensics | undefined;
    try {
      const ledgerPath = defaultExperimentLedgerPath(path.join(targetsRoot, t.repo));
      const entries = readExperimentLedger(ledgerPath);
      if (entries.length > 0) experimentLedgerDigest = summarizeExperimentLedger(entries);
      stagnationForensics = computeStagnationForensics(entries);
    } catch (err: any) {
      log(`experiment ledger read failed for ${t.repo}: ${err?.message || err}`);
    }
    if (experimentLedgerDigest) ledgerDigestByLineage[t.lineage] = { repo: t.repo, digest: experimentLedgerDigest };

    // SOT-2745: oracle-drift シグナル。proxy(leak-free CV)飽和 × 真の一次KPI(実LB順位)停滞を
    // history から決定論的に算出し material.oracleDrift へ供給する（両立が閾値サイクル続くと本文が
    // detectOracleDrift/buildOracleDriftBanner 経由で再アンカー指令へ切り替わる）。全て best-effort。
    let oracleDrift: OracleDriftSignal | undefined;
    try {
      const repoDir = path.join(targetsRoot, t.repo);
      const cvReportRel = comp.validation.cvReportPath || DEFAULT_CV_REPORT_PATH;
      // proxy 系列: cv_report_history.jsonl の leak-free CV score 時系列（無ければ空=下で silent-safe）。
      const cvHistoryPath = path.join(repoDir, cvReportRel.replace(/\.json$/i, '_history.jsonl'));
      let proxySeries: number[] = [];
      try {
        proxySeries = parseCvScoreHistory(fs.readFileSync(cvHistoryPath, 'utf8'));
      } catch {
        /* CV履歴なし → proxySeries 空のまま。両系列2点未満なら signal は立たない。 */
      }
      // 真の一次KPI 系列: 実LB順位履歴（古い→新しい・repo別）。圏外(null)は totalListed+1 の最悪順位として扱う。
      const rankSeries = readLeaderboardRankHistory(leaderboardRankPath)
        .filter((h) => h.repo === t.repo)
        .map((h) =>
          h.rank !== null && Number.isFinite(h.rank)
            ? h.rank
            : h.totalListed
              ? h.totalListed + 1
              : undefined
        )
        .filter((n): n is number => typeof n === 'number');
      oracleDrift = computeOracleDriftSignal(
        {
          series: proxySeries,
          direction: comp.scoreDirection,
          minImprovement:
            comp.validation.oracleDriftProxyMinImprovement ?? DEFAULT_PROXY_SATURATION_MIN_IMPROVEMENT,
          name: 'leak-free CV',
        },
        {
          series: rankSeries,
          direction: 'min',
          minImprovement:
            comp.validation.oracleDriftTrueKpiMinImprovement ?? DEFAULT_TRUE_KPI_MIN_IMPROVEMENT,
          name: 'public LB 順位',
        }
      );
    } catch (err: any) {
      log(`oracle-drift signal computation failed for ${t.repo}: ${err?.message || err}`);
    }

    // 前回サイクル親Issueの申し送りコメント（best-effort・signate教訓の移植）。
    let previousCycleHandoff: string | undefined;
    try {
      previousCycleHandoff = await latestCycleHandoff(t.project, label);
    } catch (err: any) {
      log(`cycle handoff collection failed for ${t.project}: ${err?.message || err}`);
    }

    // 日次提出予算ダイジェスト（改善ゲート＋spacing/reserve の材料）。best-effort。
    let submissionBudget: string | undefined;
    try {
      submissionBudget = buildSubmissionBudgetDigest(
        targetSubmissionRows,
        comp.dailySubmissionCap,
        registry.submissionPolicy,
        Date.now()
      );
    } catch (err: any) {
      log(`submission budget digest failed for ${t.repo}: ${err?.message || err}`);
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
      ...(previousCycleHandoff ? { previousCycleHandoff } : {}),
      submissionHealth: submissionHealth.status,
      ...(submissionHealth.reason ? { submissionHealthReason: submissionHealth.reason } : {}),
      ...(submissionHealth.consecutiveBroken > 0
        ? { submissionHealthConsecutive: submissionHealth.consecutiveBroken }
        : {}),
      ...(rankTrendSummary ? { rankTrend: rankTrendSummary } : {}),
      ...(rankTrendDirection ? { rankTrendDirection } : {}),
      ...(oracleDrift ? { oracleDrift } : {}),
      ...(submissionBudget ? { submissionBudget } : {}),
      ...(publicNotebooksDigest ? { publicNotebooksDigest } : {}),
      ...(stagnationForensics ? { stagnationForensics } : {}),
    };
  }

  // 系統間 divergence（#5）: 相手系統（同一コンペの逆側 lineage）の台帳 digest を各 material に供給する。
  for (const t of comp.targets) {
    const other: Lineage = t.lineage === 'claude' ? 'gpt' : 'claude';
    const counterpart = ledgerDigestByLineage[other];
    if (counterpart && material[t.project]) {
      material[t.project].counterpartLedgerDigest =
        `（${other} 系統 / repo: ${counterpart.repo}）\n${counterpart.digest}`;
    }
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
        hasOpenCycle = !!(await findOpenImproveCycleParent(t.project, label));
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
