/**
 * Linear issue の「終端状態（terminal state）」判定を一元化する。
 */

interface State {
  type?: string;
  name?: string;
}

export function isTerminalState(state: State | null | undefined): boolean {
  return ['completed', 'canceled', 'duplicate'].includes(state?.type || '')
    || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name || '');
}

/**
 * 自動実行の対象外とする「保留（hold）状態」かどうかを判定する。
 *
 * 「In Review」は人間のレビュー/選択待ちで停止している状態であり（PLAN完了・親Issue完了・
 * 人手で保留にしたケース）、type は In Progress と同じ "started" になる。そのため type だけでは
 * 区別できず、reaper や bootstrap scan が actionable とみなして繰り返し再実行してしまう。
 * 名前で In Review を保留状態として明示的に除外する。
 */
export function isHoldState(state: State | null | undefined): boolean {
  return (state?.name || '').toLowerCase() === 'in review';
}

/**
 * 子Issueが「作業として完了」しているかを判定する（親Issueのファイナライズ用）。
 *
 * このハーネスでは実装系の子Issueは PR マージ後も自動 Done にはせず「In Review」(hold 状態) で
 * 止める運用のため、terminal（Done/Canceled/Duplicate）だけを完了とみなすと、全子Issueが In Review
 * に到達しても親Issueが Todo/In Progress のまま残ってしまう（SOT-1551）。よって完了判定は
 * terminal に加えて In Review（hold）も完了として扱う。
 */
export function isChildComplete(state: State | null | undefined): boolean {
  return isTerminalState(state) || isHoldState(state);
}
