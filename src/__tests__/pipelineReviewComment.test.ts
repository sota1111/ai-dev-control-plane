import { pipelineReviewComment } from '../lib/pipelineReviewComment.js';

describe('pipelineReviewComment', () => {
  test('describes a successful pipeline as completed', () => {
    const comment = pipelineReviewComment('completed');

    expect(comment).toContain('自動処理が完了しました');
    expect(comment).toContain('処理と検証が完了したため');
    expect(comment).not.toContain('完了状態に到達しなかった');
  });

  test('keeps an incomplete pipeline active without claiming completion', () => {
    const comment = pipelineReviewComment('incomplete');

    expect(comment).toContain('自動処理が一巡しました');
    expect(comment).toContain('未完了の作業');
    expect(comment).toContain('In Progress');
    expect(comment).not.toContain('In Review');
  });

  test('does not claim implementation completion for a no-PR terminal', () => {
    const comment = pipelineReviewComment('completed-no-pr');

    expect(comment).toContain('PR 非対象の終端');
    expect(comment).toContain('実装・検証の完了を意味する通知ではありません');
    expect(comment).not.toContain('分解');
    expect(comment).not.toContain('処理と検証が完了したため');
  });
});
