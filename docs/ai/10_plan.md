# Plan — SOT-1559（git worktree 並列隔離でロック粒度を repo → branch に下げる）

## 要件の解釈
親 SOT-1556（ループエンジニアリング性能向上）レバー3 の実装子 Issue。グローバルロックが全実行を直列化
する既知問題に対し、git worktree ベースの作業ディレクトリ隔離を導入してロック粒度を repo 全体 →
worktree(=branch) 単位へ下げ、multi-repo/多 issue の並列を衝突なく解く。

3 段の変更:
1. **git worktree 隔離**: 各 lane/issue に `git worktree add ../wt/<issue-id> <branch>` で専用作業ツリーを
   与え、同一 repo でも別ディレクトリで並列作業させファイル/インデックス競合を構造的に排除。完了/失敗時に
   `git worktree remove`（変更なしは自動削除）。
2. **ロック粒度低下**: `runnerLock.ts` のロックキーを repo → worktree パスに拡張。異 issue/branch は並列可、
   同一 branch は従来通り直列。
3. **段階導入 + ドキュメント**: read-only 調査 lane を先に worktree 化（低リスク）→ 単一 repo 内複数 issue の
   実装 lane へ拡大。CLAUDE.md 並列方針節の「same repo/branch は serial」を branch 単位に緩和。

- タスク種別: **IMPLEMENT**（複数ファイル・ロジック変更・単体テストを伴うコード実装）。
- 対象リポジトリ: `/workspaces/ai-dev-control-plane`（ハーネス自身）。
- ブランチ: 親の feat/sot-1556-loop-engineering-improvements（子は同一 feature ブランチ）。

## 分解判断: 不要
既に親 SOT-1556 から分解された子 Issue。単一 feature（worktree 隔離＋ロック粒度低下）で対象ファイル群が
密結合（laneNotifier.ts / runnerLock.ts / run_codex・antigravity lane_path / CLAUDE.md）、impl+tests+docs が
1 PR にまとまる単位。3 段は段階導入ステップであって独立 rollback/PR 単位ではない。さらなる分割は overhead > value。

## 対象ファイル（親Issueの変更範囲より）
- `src/lib/runnerLock.ts` — ロックキーを repo → worktree パスに拡張（＋単体テスト）
- `src/lib/laneNotifier.ts` — detach 実行 / lane_path を worktree ベースに
- `scripts/ai/run_codex.sh`, `scripts/ai/run_antigravity.sh` — lane_path（worktree add/remove ライフサイクル）
- `CLAUDE.md` — 並列方針節（「same repo/branch は serial」→ branch 単位）

## Next Action: READY_FOR_REVIEW（実装ロールへ）
