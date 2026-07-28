export type PipelineReviewOutcome = 'completed' | 'completed-no-pr' | 'incomplete';

export function pipelineReviewComment(outcome: PipelineReviewOutcome): string {
  if (outcome === 'completed') {
    return `## 自動処理が完了しました

この Issue の処理と検証が完了したため、確認待ちの **In Review** に移行しました。内容を確認してください。`;
  }

  if (outcome === 'completed-no-pr') {
    return `## 自動処理が確認待ちに移行しました

この Issue は PR を作成しない終端（PLAN・REVIEW・分解・no-op のいずれか）に到達したため **In Review** に移行しました。実装・検証の完了を意味する通知ではありません。分解された場合は、子 Issue の完了後に親 Issue を改めて確認してください。`;
  }

  return `## 自動処理が一巡しました

この Issue のパイプラインが一巡し、自動では完了状態に到達しなかったため **In Review** に移行しました（無限再処理の防止）。内容を確認し、続行が必要なら Todo/In Progress に戻してください。`;
}
