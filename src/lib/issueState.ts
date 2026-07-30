/**
 * Linear issue の「終端状態（terminal state）」判定を一元化する。
 */

interface State {
  type?: string;
  name?: string;
}

export type IssueMeaningState =
  | 'actionable'
  | 'dependency_wait'
  | 'human_wait'
  | 'auth_unhealthy'
  | 'terminal';

export function classifyIssueMeaningState(
  state: State | null | undefined,
  opts: { archived?: boolean; hasUnresolvedBlockers?: boolean; authUnhealthy?: boolean } = {}
): IssueMeaningState {
  if (opts.archived || isTerminalState(state)) return 'terminal';
  if (opts.authUnhealthy) return 'auth_unhealthy';
  if (opts.hasUnresolvedBlockers) return 'dependency_wait';
  const name = (state?.name || '').toLowerCase();
  if (name === 'in review' || name === 'blocked' || name === 'on hold') return 'human_wait';
  return 'actionable';
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
 *
 * SOT-1560: サーキットブレーカー発火で停止した Issue は「On Hold」へ遷移させる。On Hold も
 * 自動実行の対象外（hold）として扱い、reaper / recover の再スキャンが同一 Issue を再実行しない
 * ようにする（再実行ループの停止）。
 */
export function isHoldState(state: State | null | undefined): boolean {
  const name = (state?.name || '').toLowerCase();
  return name === 'in review' || name === 'on hold';
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
