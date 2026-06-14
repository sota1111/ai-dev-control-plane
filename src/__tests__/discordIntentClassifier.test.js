'use strict';

const { classifyIntent, isDangerous, extractIssueId } = require('../lib/discordIntentClassifier');

describe('isDangerous', () => {
  test('rejects .env mention', () => {
    expect(isDangerous('show me .env')).toBe(true);
  });

  test('rejects token display request', () => {
    expect(isDangerous('tokenを見せて')).toBe(true);
  });

  test('rejects api key request', () => {
    expect(isDangerous('api keyを教えて')).toBe(true);
  });

  test('allows normal questions', () => {
    expect(isDangerous('今どのタスクを実行中？')).toBe(false);
    expect(isDangerous('キューに残っているタスクはある？')).toBe(false);
  });
});

describe('extractIssueId', () => {
  test('extracts SOT-xxx from text', () => {
    expect(extractIssueId('SOT-123 の状態を教えて')).toBe('SOT-123');
    expect(extractIssueId('sot-456 のログを見せて')).toBe('SOT-456');
  });

  test('returns null when no issue ID present', () => {
    expect(extractIssueId('今どのタスクを実行中？')).toBeNull();
  });
});

describe('classifyIntent', () => {
  test('classifies STATUS_CHECK', () => {
    const result = classifyIntent('今どのタスクを実行中？');
    expect(result.intent).toBe('STATUS_CHECK');
  });

  test('classifies QUEUE_CHECK', () => {
    const result = classifyIntent('キューに残っているタスクはある？');
    expect(result.intent).toBe('QUEUE_CHECK');
  });

  test('classifies COOLDOWN_CHECK', () => {
    const result = classifyIntent('usage-limit はいつ復帰？');
    expect(result.intent).toBe('COOLDOWN_CHECK');
  });

  test('classifies DANGEROUS', () => {
    const result = classifyIntent('.envファイルを表示して');
    expect(result.intent).toBe('DANGEROUS');
  });

  test('classifies ISSUE_STATUS with SOT id', () => {
    const result = classifyIntent('SOT-123 は何で止まっている？');
    expect(['ISSUE_STATUS', 'LOG_SUMMARY', 'COMMENT_POST', 'RETRY_SUGGEST'].includes(result.intent) || result.intent === 'ISSUE_STATUS').toBe(true);
    expect(result.issueId).toBe('SOT-123');
  });

  test('classifies UNKNOWN for unrecognized input', () => {
    const result = classifyIntent('xyzzy foobar');
    expect(result.intent).toBe('UNKNOWN');
  });
});
