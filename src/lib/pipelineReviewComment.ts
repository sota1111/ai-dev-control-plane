export type PipelineReviewOutcome = 'completed' | 'completed-no-pr' | 'incomplete';

export function pipelineReviewComment(outcome: PipelineReviewOutcome): string {
  if (outcome === 'completed') {
    return `## 自動処理が完了しました

この Issue の処理と検証が完了したため、確認待ちの **In Review** に移行しました。内容を確認してください。`;
  }

  if (outcome === 'completed-no-pr') {
    return `## 自動処理が確認待ちに移行しました

この Issue は実行すべき子 Issue が残っていない PR 非対象の終端（PLAN・REVIEW・no-op）に到達したため **In Review** に移行しました。実装・検証の完了を意味する通知ではありません。`;
  }

  return `## 自動処理が一巡しました

この Issue には未完了の作業があるため **In Progress** のまま維持します。停止理由または次に実行する内容を確認し、自動処理を継続します。`;
}
