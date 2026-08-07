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

    // LB順位サマリ + 順位履歴（best-effort）。ローカル評価は代理指標、順位が一次KPI。
    let leaderboardSummary: string | undefined;
    try {
      const direction = comp.scoreDirection;
      // 自分の best public score を submission 履歴の生行から直接取る（score-progression.jsonl は
      // `[repo:...]` 帰属マーカーが無いと空になり順位を出せないため、そこに依存しない）。生行から
      // 取れない場合のみ score-progression にフォールバックする。
      const repoScores = progression
        .filter((entry) => entry.repo === t.repo)
        .map((entry) => entry.publicScore);
      const progressionBest = repoScores.length > 0
        ? repoScores.reduce((best, s) =>
            (direction === 'max' ? s > best : s < best) ? s : best, repoScores[0])
        : undefined;
      const bestPublicScore =
        bestPublicScoreFromRows(targetSubmissionRows, direction) ?? progressionBest;
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
      ...(experimentLedgerDigest ? { experimentLedgerDigest } : {}),
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
