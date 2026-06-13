const { classifyIssue } = require('../lib/issueClassifier');

describe('classifyIssue', () => {
  test('[IMPLEMENT] prefix → IMPLEMENT/gemini', () => {
    const r = classifyIssue({ id: '1', title: '[IMPLEMENT] SOT-100 - ○○実装' });
    expect(r.type).toBe('IMPLEMENT');
    expect(r.worker).toBe('gemini');
  });

  test('[DEBUG] prefix → DEBUG/codex', () => {
    const r = classifyIssue({ id: '2', title: '[DEBUG] SOT-100 - テスト検証' });
    expect(r.type).toBe('DEBUG');
    expect(r.worker).toBe('codex');
  });

  test('[PLAN] prefix → PLAN/claude-code', () => {
    const r = classifyIssue({ id: '3', title: '[PLAN] SOT-100 - 設計' });
    expect(r.type).toBe('PLAN');
    expect(r.worker).toBe('claude-code');
  });

  test('control-plane keyword (usage-limit) → PLAN/claude-code', () => {
    const r = classifyIssue({ id: '4', title: 'usage-limitラベル処理の改善', description: '' });
    expect(r.type).toBe('PLAN');
    expect(r.worker).toBe('claude-code');
  });

  test('multiple repo URLs → PLAN/claude-code', () => {
    const r = classifyIssue({
      id: '5',
      title: '全リポジトリにdeployスクリプト追加',
      description: 'https://github.com/sota1111/repo-a\nhttps://github.com/sota1111/repo-b\nhttps://github.com/sota1111/repo-c'
    });
    expect(r.type).toBe('PLAN');
    expect(r.worker).toBe('claude-code');
  });

  test('bug label → DEBUG/codex', () => {
    const r = classifyIssue({ id: '6', title: 'ログが出ない', labels: ['bug'] });
    expect(r.type).toBe('DEBUG');
    expect(r.worker).toBe('codex');
  });

  test('secret/permission keyword → SECURITY/codex', () => {
    const r = classifyIssue({ id: '7', title: 'Secret Manager対応', description: 'credential管理' });
    expect(r.type).toBe('SECURITY');
    expect(r.worker).toBe('codex');
  });

  test('README mention → DOC/codex', () => {
    const r = classifyIssue({ id: '8', title: 'README更新' });
    expect(r.type).toBe('DOC');
    expect(r.worker).toBe('codex');
  });

  test('default → IMPLEMENT/gemini', () => {
    const r = classifyIssue({ id: '9', title: '新機能追加', description: '画面を追加する' });
    expect(r.type).toBe('IMPLEMENT');
    expect(r.worker).toBe('gemini');
  });

  test('result has reason string', () => {
    const r = classifyIssue({ id: '10', title: '[FIX] バグ修正' });
    expect(typeof r.reason).toBe('string');
    expect(r.reason.length).toBeGreaterThan(0);
  });
  test('task confirmation keyword → REVIEW/codex before webhook planning', () => {
    const r = classifyIssue({ id: '11', title: 'webhook完了時のタスク確認', description: '' });
    expect(r.type).toBe('REVIEW');
    expect(r.worker).toBe('codex');
  });

});
