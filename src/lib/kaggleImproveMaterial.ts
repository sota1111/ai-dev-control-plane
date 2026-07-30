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
import { getCompetition } from './kaggleImprovement.js';
import { findOpenAutoImproveIssue, linearQuery } from './linearApi.js';
import {
  appendNewScoreProgression,
  detectScorePlateau,
  progressionEntriesFromRows,
  readScoreProgression,
} from './kaggleScoreProgression.js';

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

function collectSubmissionRows(slug: string, log: (m: string) => void): KaggleSubmissionRow[] {
  if (!slug) return [];
  try {
    const out = execFileSync('kaggle', ['competitions', 'submissions', slug, '--csv'], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseKaggleSubmissionsCsv(out);
  } catch (err: any) {
    log(`kaggle submissions failed for ${slug}: ${err?.message || err}`);
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

  // 前回提出はコンペ単位（同一 kaggle slug）なので1回だけ収集して両ターゲットで共有する。
  const submissionRows = opts.kaggle === false
    ? []
    : collectSubmissionRows(comp.kaggleCompetition, log);
  const previousSubmission = formatPreviousSubmission(submissionRows);
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

  // failure-log も1回だけ読む。
  const failureContent = readFailureLog(opts.failureLogPath, log);

  for (const t of comp.targets) {
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
      hasNewMaterial = r.hasNewMaterial;
    } catch (err: any) {
      log(`recent-issues collection failed for ${t.project}: ${err?.message || err}`);
    }

    const failureKpiExcerpt = failureContent
      ? filterFailureLog(failureContent, [t.repo, comp.key])
      : undefined;

    const plateau = detectScorePlateau(progression, t.repo, opts.plateauThreshold ?? 3);
    signals[t.project] = {
      hasUnfinishedCycle,
      hasNewMaterial,
      ...(plateau.plateau && plateau.reason ? { plateauReason: plateau.reason } : {}),
    };
    material[t.project] = { previousSubmission, recentIssuesDigest: digest, failureKpiExcerpt };
  }

  return { signals, material };
}
