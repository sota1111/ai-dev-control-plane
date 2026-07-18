export type PipelineReviewOutcome = 'completed' | 'incomplete';

export function pipelineReviewComment(outcome: PipelineReviewOutcome): string {
  if (outcome === 'completed') {
    return `## 自動処理が完了しました

この Issue の処理と検証が完了したため、確認待ちの **In Review** に移行しました。内容を確認してください。`;
  }

  return `## 自動処理が一巡しました

この Issue のパイプラインが一巡し、自動では完了状態に到達しなかったため **In Review** に移行しました（無限再処理の防止）。内容を確認し、続行が必要なら Todo/In Progress に戻してください。`;
}
