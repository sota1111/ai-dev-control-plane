import { pipelineReviewComment } from '../lib/pipelineReviewComment.js';

describe('pipelineReviewComment', () => {
  test('describes a successful pipeline as completed', () => {
    const comment = pipelineReviewComment('completed');

    expect(comment).toContain('自動処理が完了しました');
    expect(comment).toContain('処理と検証が完了したため');
    expect(comment).not.toContain('完了状態に到達しなかった');
  });

  test('preserves the loop-breaker guidance for an incomplete pipeline', () => {
    const comment = pipelineReviewComment('incomplete');

    expect(comment).toContain('自動処理が一巡しました');
    expect(comment).toContain('完了状態に到達しなかった');
    expect(comment).toContain('無限再処理の防止');
  });

  test('does not claim implementation completion for a no-PR terminal', () => {
    const comment = pipelineReviewComment('completed-no-pr');

    expect(comment).toContain('PR を作成しない終端');
    expect(comment).toContain('実装・検証の完了を意味する通知ではありません');
    expect(comment).toContain('子 Issue の完了後');
    expect(comment).not.toContain('処理と検証が完了したため');
  });
});
