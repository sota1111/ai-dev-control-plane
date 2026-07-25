# SOT-1913 — なぜ子Issueが「依存順に自動実装」されなかったのか（根本原因と恒久対策）

- issue: SOT-1913（親・PLAN）/ 子 SOT-1932 → {SOT-1933, SOT-1934} → SOT-1935
- 症状: 「実装を開始してください」の後、依存順の先頭 SOT-1932 だけが実装・マージされ、残り
  （SOT-1933/1934/1935）は自動では実装されず In Review に留まった。人間から「残りを依存順に実装し、
  依存順に実装できなかった理由を分析して次から実装できるようにせよ」との指示。

## 根本原因

**子Issueが意図的に「In Review」にパークされていたため、そもそもパイプラインの自動処理対象に入らず、
依存順ソート機構が働く余地が無かった。**

パイプラインの Issue 選択は In Review を2層で自動対象外にする:

1. **スキャン層** — `src/lib/linearApi.ts` `fetchActiveIssues()` は
   `state: { type: { in: ["unstarted","started"] }, name: { nin: ["In Review"] } }` で In Review を
   除外する。reaper / bootstrap スキャンはこれを使って active Issue を enqueue するので、In Review の
   Issue は**そもそも取得されずキューに入らない**。
2. **デキュー層** — 仮にキューに入っても `getIssueExecutionEligibility()` が In Review を hold state と
   みなし、`removeFromQueue` してから ineligible を返す。

一方で **依存順(blockedBy)の処理機構は既に存在する**:
`src/lib/queueOrdering.ts` の `sortQueueByPriority()` は enqueue 時に blockedByIssueIds を
Kahn のアルゴリズムでトポロジカルソートし、`selectNextReadyIndex()` はデキュー時にブロッカーが
まだキューに居る依存側をスキップする。**ただしこれはキューに載った Todo/In Progress の Issue にしか
効かない。**

したがって、分解した子Issueを全て In Review にパークすると、キューに入らないため
topological ソートが発火せず、「依存順に自動実装」されない。SOT-1932 だけが進んだのは、solo worker が
依存順の先頭を手動で実装しただけで、依存順の自動走行が起きたわけではない。

## なぜ In Review にパークしたか

SOT-1913 は PLAN 親で、人間回答1「有効化時期＝計画段階、後に決定」を尊重し、子を自動キューに入れない
ために In Review パークで登録した（設計 v3/v4）。この「安全のためのパーク」が、皮肉にも「依存順の
自動実装」を不可能にしていた。

## 恒久対策（次から依存順に実装できるように）

**自動実装させたい子Issueは Todo で登録し、依存を `blockedBy` で連結する（In Review にパークしない）。**
既存の `queueOrdering` の topological ソートがブロッカー完了まで依存側を保留し、依存順に処理する。

- 「計画段階だから自動起動させたくない」を満たしたい場合は、Issue を In Review にパークするのではなく、
  **システム全体の kill switch（default OFF）で止める**（本件なら `KAGGLE_IMPROVE_ENABLED` +
  `registry.enabled`）。個々の子Issueの status をパークに使うと依存順自動実装が壊れる。
- cron が起案する親Issue、およびそれを分解した実装子Issueは **Todo + blockedBy** で作る
  （`createDraftIssue` は Todo で作成する）。運用ルールは `docs/kaggle-improvement-cycle.md` にも明記。
- 既存メモリ `child-issue-initial-status-todo`（新規子Issueの初期 Status は Todo）を、
  「PLAN 子でも自動実装対象なら In Review パークではなく Todo+blockedBy、無効化は system kill switch で」
  に拡張して昇格。

## 参照

- スキャン除外: `src/lib/linearApi.ts` `fetchActiveIssues`（`name: { nin: ["In Review"] }`）/
  `getIssueExecutionEligibility`（hold state）
- 依存順機構: `src/lib/queueOrdering.ts` `sortQueueByPriority` / `selectNextReadyIndex`
- 設計/運用: `docs/ai/linear/SOT-1913.md` / `docs/kaggle-improvement-cycle.md`
</content>
