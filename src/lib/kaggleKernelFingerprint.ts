/**
 * SOT-2517 — Kaggle code-competition 提出 dedup の同一性単位を「実行される計算」にする。
 *
 * 背景: 提出 dedup の fingerprint が可視 `submission.csv` の sha256 だと、Code コンペで可視出力を全上書き
 * する層（例: 定数 CSV に差し替えるフォールバック）があると、hidden の挙動が変わっても同一 fingerprint に
 * なる。これにより (a) 新レバー提出が dedup で誤って弾かれる、(b) byte 同一を根拠にレバーを誤 CLOSE する
 * （rogii cycle11「blend inert」実事故）——が起きる。
 *
 * ここでは fingerprint を **kernel ソース（notebook の code cells の連結）+ pinned dataset ソース一覧 +
 * kernel version** の sha256 とする純粋関数を提供する。可視出力 CSV は同一性判定に一切使わない。
 * 旧 `sha256:`（可視 artifact hash）とは prefix `kernel:sha256:` で区別し、提出履歴での混在を安全にする。
 *
 * I/O は持たない（notebook JSON の読み込みは呼び出し側 = runner-cli / bash が行う）ので単体テスト可能。
 */

import { createHash } from 'node:crypto';

/** kernel-source fingerprint の prefix（旧 `sha256:` 可視 artifact hash と区別する）。 */
export const KERNEL_FINGERPRINT_PREFIX = 'kernel:sha256:';

/** ハッシュ対象にする Jupyter cell の最小形（他フィールドは同一性に影響させない）。 */
interface NotebookCell {
  cell_type?: unknown;
  source?: unknown;
}

/** Jupyter の `source`（string | string[]）を1つの文字列へ正規化する。 */
function cellSourceToString(source: unknown): string {
  if (Array.isArray(source)) {
    return source.map((line) => (typeof line === 'string' ? line : '')).join('');
  }
  return typeof source === 'string' ? source : '';
}

/**
 * notebook JSON から「実行されるコード」を抽出する: `code` cell の source のみを順に連結する。
 * outputs / execution_count / markdown・raw cell は結果に影響しない。改行を `\n` に、行末空白を除去して
 * 見た目だけの再保存で同一性が変わらないようにする。cell 境界には code に出現し得ない NUL 区切りを挟み、
 * 2つの cell が連結で別レイアウトへ化けて衝突するのを防ぐ。
 */
export function extractNotebookCodeSource(notebookJson: unknown): string {
  const cells =
    notebookJson &&
    typeof notebookJson === 'object' &&
    Array.isArray((notebookJson as { cells?: unknown }).cells)
      ? ((notebookJson as { cells: NotebookCell[] }).cells)
      : [];
  const codeChunks: string[] = [];
  for (const cell of cells) {
    if (!cell || cell.cell_type !== 'code') continue;
    const normalized = cellSourceToString(cell.source)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/g, ''))
      .join('\n');
    codeChunks.push(normalized);
  }
  return codeChunks.join('\n\u0000\n');
}

/** computeKernelFingerprint の入力。 */
export interface KernelFingerprintInput {
  /** notebook JSON（.ipynb の内容）。codeSource を直接渡さないときに使う。 */
  notebookJson?: unknown;
  /** 抽出済みの code source（notebookJson の代わりに直接渡す場合）。 */
  codeSource?: string;
  /** pinned な Kaggle dataset ソース（例 "user/dataset"）。順序非依存。 */
  datasetSources?: readonly string[];
  /** immutable な Kaggle kernel version。 */
  version?: number | string | null;
}

/**
 * Kaggle code-competition kernel 提出の「実行される計算」の同一性を計算する:
 * sha256( code cells + ソート・重複排除した dataset ソース + kernel version )。
 * 可視出力 CSV は意図的に同一性へ含めない（可視を上書きする層が別 kernel を同一 fingerprint に潰すのを防ぐ）。
 * 返り値は `kernel:sha256:<hex>`。
 */
export function computeKernelFingerprint(input: KernelFingerprintInput): string {
  const code = input.codeSource ?? extractNotebookCodeSource(input.notebookJson);
  const datasets = [
    ...new Set((input.datasetSources ?? []).map((d) => String(d).trim()).filter(Boolean)),
  ].sort();
  const version =
    input.version === undefined || input.version === null ? '' : String(input.version);
  const canonical = JSON.stringify({ code, datasets, version });
  return `${KERNEL_FINGERPRINT_PREFIX}${createHash('sha256').update(canonical).digest('hex')}`;
}

/** fingerprint 文字列が kernel-source fingerprint（新フォーマット）かどうか。 */
export function isKernelFingerprint(fingerprint: string | null | undefined): boolean {
  return typeof fingerprint === 'string' && fingerprint.startsWith(KERNEL_FINGERPRINT_PREFIX);
}
