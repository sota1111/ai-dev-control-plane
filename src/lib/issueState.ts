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
