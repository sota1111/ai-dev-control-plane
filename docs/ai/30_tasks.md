# Tasks — SOT-1559（git worktree 並列隔離 / loop engineering レバー3）

Decomposition: **不要** — 既に親 SOT-1556 から分解された子 Issue。単一 feature（worktree 隔離＋ロック粒度低下）で
対象ファイル群が密結合、impl+tests+docs が 1 PR にまとまる。親は work unit を本 Issue とする。
Task type: **IMPLEMENT**（PR → merge → In Review）。
Repository: `/workspaces/ai-dev-control-plane`。
Branch: feat/sot-1556-loop-engineering-improvements（親と同一 feature ブランチ）。

## タスク一覧

### 1. git worktree ベースの作業ディレクトリ隔離
- [ ] 各 lane/issue に `git worktree add ../wt/<issue-id> <branch>` で専用作業ツリーを付与。
- [ ] 完了/失敗時に `git worktree remove` でクリーンアップ（変更なしなら自動削除）。
- [ ] `src/lib/laneNotifier.ts`（detach 実行）と `run_codex.sh`/`run_antigravity.sh` の lane_path を worktree ベースに配線。
- [ ] worktree add/remove ライフサイクル（変更なし自動削除）の単体テスト。

### 2. ロック粒度を repo → worktree(branch) 単位に下げる
- [ ] `src/lib/runnerLock.ts`: ロックキーを repo → worktree パスに拡張。
- [ ] 異 issue/branch は並列可、同一 branch は従来通り直列（衝突しない）を保証。
- [ ] 単体テスト: 異 branch 並列可 / 同 branch 直列。

### 3. 段階導入 + ドキュメント更新
- [ ] read-only 調査 lane を先に worktree 化（低リスク）→ 単一 repo 内複数 issue の実装 lane へ拡大。
- [ ] `CLAUDE.md` 並列方針節の「same repo/branch は serial」を branch 単位に緩和して更新。

## 検証（Quality Gate）
- [ ] npm run lint / typecheck / test green。

## 受け入れ条件
`docs/ai/40_acceptance.md` 参照。

## Next Action: READY_FOR_REVIEW（実装ロールへ）
