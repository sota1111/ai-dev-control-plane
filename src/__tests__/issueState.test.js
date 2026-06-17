const { isTerminalState } = require('../lib/issueState');

describe('isTerminalState', () => {
  test('returns true for terminal types', () => {
    expect(isTerminalState({ type: 'completed' })).toBe(true);
    expect(isTerminalState({ type: 'canceled' })).toBe(true);
    expect(isTerminalState({ type: 'duplicate' })).toBe(true);
  });

  test('returns true for terminal names', () => {
    expect(isTerminalState({ name: 'Done' })).toBe(true);
    expect(isTerminalState({ name: 'Canceled' })).toBe(true);
    expect(isTerminalState({ name: 'Cancelled' })).toBe(true);
    expect(isTerminalState({ name: 'Duplicate' })).toBe(true);
  });

  test('returns false for active states', () => {
    expect(isTerminalState({ type: 'started', name: 'In Progress' })).toBe(false);
    expect(isTerminalState({ type: 'unstarted', name: 'Todo' })).toBe(false);
    expect(isTerminalState({ type: 'backlog', name: 'Backlog' })).toBe(false);
  });

  test('is null-safe and handles empty objects', () => {
    expect(isTerminalState(null)).toBe(false);
    expect(isTerminalState(undefined)).toBe(false);
    expect(isTerminalState({})).toBe(false);
    expect(isTerminalState({ type: '', name: '' })).toBe(false);
  });

  test('is case-sensitive and requires exact match', () => {
    // state.type matches
    expect(isTerminalState({ type: 'Completed' })).toBe(false);
    expect(isTerminalState({ type: 'CANCELED' })).toBe(false);
    
    // state.name matches
    expect(isTerminalState({ name: 'done' })).toBe(false);
    expect(isTerminalState({ name: 'CANCELED' })).toBe(false);
  });

  test('works with combined type and name', () => {
    expect(isTerminalState({ type: 'completed', name: 'Done' })).toBe(true);
    expect(isTerminalState({ type: 'backlog', name: 'Done' })).toBe(true);
    expect(isTerminalState({ type: 'completed', name: 'Backlog' })).toBe(true);
  });
});
