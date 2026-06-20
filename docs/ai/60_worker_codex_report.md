# Worker Report

## Summary
SOT-908「完了issueのラベル」の初期タスクチェック。要求: 自動化がIssueを完了して `Done` に登録したら、Linearの `check` ラベルを自動付与する。人間が確認後にラベルを手動で外す。

### 調査結果
- **Done 検知のフック点（推奨）:** `src/webhook-server.ts:392-409`。Linear webhook の Issue イベントで `isTerminalState({type,name})` が真になる箇所。誰が（Claude Code/人間）Done にしても webhook が発火するため、ここが最も堅牢な付与ポイント。ただし `isTerminalState` は completed/canceled/duplicate を含むため、`check` 付与は **completed（Done）に限定**する必要がある（Canceled/Duplicate には付けない）。
- **ラベル付与の既存メカニズム:** `src/runner.ts:498` `addUsageLimitLabel()` が雛形。`issueLabels(filter:{name:{eq}})` で取得→無ければ `issueLabelCreate`→`issueUpdate(labelIds)` で冪等に追加。除去は `removeUsageLimitLabel()` (`src/runner.ts:533`)。これを `check` ラベル用に再利用する。
- **`check` ラベルの存在:** ワークスペースにまだ無い可能性が高い。`addUsageLimitLabel` 同様、無ければ `issueLabelCreate` で自動作成する実装にすれば問題なし（人間が外すのみで作成不要）。
- **既存の終端処理:** `finalizeParentIfChildrenComplete()` (`src/runner.ts:1376`) が子全完了時に親を In Review にする。`check` 付与とは独立。

### 実装方針（actionable）
1. `src/runner.ts` に `addCheckLabel(issueId)` をエクスポート追加（`addUsageLimitLabel` を踏襲、name="check"、色は緑系）。
2. `src/webhook-server.ts` の terminal-state 分岐で、state が **Done/completed** のとき `runner.addCheckLabel(issueId)` を fire-and-forget で呼ぶ。冪等なのでラベル変更webhookの再発火でもループしない。
3. ユニットテスト追加。

## Worker Non-Response Fallback (audit disclosure — do NOT post to Linear)
- **Non-responsive worker:** Codex CLI（本Issueの初期タスクチェック担当）。
- **Detected failure mode:** `scripts/ai/run_codex.sh` が `CODEX_COOLDOWN_ACTIVE`（usage-limit cooldown, epoch 1782000900 まで＝約17時間先）で exit 75 を返却。cooldown 解除が遠いため bounded-retry は無意味と判断しリトライせず。
- **Action taken:** CLAUDE.md「Worker Non-Response Fallback Policy」に基づき、Claude Code が直接タスクチェック調査を実施。実装も Gemini 非応答時は Claude Code がフォールバックする。Quality Gate は通常どおり適用。

## Changed Files
- none (investigation only)

## Commands Run
- `grep` / `Read` によるコード調査（`src/webhook-server.ts`, `src/runner.ts`, `src/lib/issueState.ts`）

## Acceptance Criteria
- [x] Done-transition フック点を特定（`src/webhook-server.ts:392-409`）
- [x] ラベル追加/削除メカニズムを特定（`src/runner.ts:498` / `:533`）
- [x] `check` ラベルは未作成想定→自動作成で対応可能と判断

## Risks
- `isTerminalState` は Canceled/Duplicate も含むため、completed 限定の条件分岐が必須。
- ラベル付与は副作用として update webhook を発火するが、`stateId` 変更ではなく label-only のため `meaningful update` フィルタで無視され、かつ冪等付与のためループしない。

## Next Action
READY_FOR_REVIEW
