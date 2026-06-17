/**
 * Linear issue の「終端状態（terminal state）」判定を一元化する。
 * 終端 = completed / canceled / duplicate（state.type）または
 *        Done / Canceled / Cancelled / Duplicate（state.name）。
 * 注: これは「成功完了」判定（verifyTaskCompletion）とは別セマンティクス。
 */
function isTerminalState(state) {
  return ['completed', 'canceled', 'duplicate'].includes(state?.type)
    || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name);
}

module.exports = { isTerminalState };
