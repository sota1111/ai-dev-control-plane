/**
 * Linear issue の「終端状態（terminal state）」判定を一元化する。
 */
export {};

interface State {
  type?: string;
  name?: string;
}

function isTerminalState(state: State | null | undefined): boolean {
  return ['completed', 'canceled', 'duplicate'].includes(state?.type || '')
    || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name || '');
}

module.exports = { isTerminalState };
