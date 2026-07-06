# 受け入れ条件 — SOT-1559

git worktree による並列隔離でロック粒度を repo → worktree(branch) に下げる（loop engineering レバー3）。
親: SOT-1556 ループエンジニアリングの性能向上。実装順序: 親指示により **2 番目**（1 → 3 → 2、レバー1=SOT-1558 の後）。

## 受け入れ条件（親Issue由来）

- [ ] lane/issue が専用 git worktree で実行され、完了/失敗時にクリーンアップされる
      （`git worktree add ../wt/<issue-id> <branch>` → 完了・失敗時 `git worktree remove`、変更なしなら自動削除）
- [ ] ロックが repo 全体でなく worktree(branch) 単位になり、異 branch は並列できる
      （`runnerLock.ts` のロックキーを repo → worktree パスに拡張）
- [ ] 同一 branch は従来通り直列（衝突しない）
- [ ] CLAUDE.md の並列方針（「same repo/branch は serial」）が branch 単位に更新される

## 検証内容

- `runnerLock.ts` の worktree 単位ロックキー単体テスト（異 branch 並列可 / 同 branch 直列）
- worktree add/remove ライフサイクル（変更なし自動削除）のテスト
- lint / typecheck / test green
