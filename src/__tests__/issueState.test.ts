import { isTerminalState, isHoldState } from '../lib/issueState.js';

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

describe('isHoldState', () => {
  test('returns true for In Review (case-insensitive), which shares type "started"', () => {
    expect(isHoldState({ type: 'started', name: 'In Review' })).toBe(true);
    expect(isHoldState({ name: 'in review' })).toBe(true);
    expect(isHoldState({ name: 'IN REVIEW' })).toBe(true);
  });

  test('returns false for actionable and terminal states', () => {
    expect(isHoldState({ type: 'started', name: 'In Progress' })).toBe(false);
    expect(isHoldState({ type: 'unstarted', name: 'Todo' })).toBe(false);
    expect(isHoldState({ type: 'completed', name: 'Done' })).toBe(false);
  });

  test('is null-safe', () => {
    expect(isHoldState(null)).toBe(false);
    expect(isHoldState(undefined)).toBe(false);
    expect(isHoldState({})).toBe(false);
  });
});
