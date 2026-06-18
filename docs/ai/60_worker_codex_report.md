# Worker Report

## Summary
SOT-787「実行中issueの可視化と/queue・/status表示を強化する」のタスク確認（read-only）。

**Worker Non-Response Fallback 適用**: `scripts/ai/run_codex.sh` が exit 75（usage-limit cooldown、epoch 1782000900 / 約63時間後まで）を返し非応答。cooldown ゲートのため即時リトライは無意味と判断し、Claude Code が本タスク確認を直接実施した。

## Issue actionability
ACTIONABLE。
- status: In Progress、priority High、親 SOT-783 の子Issue、blocker なし。
- スコープ明確（R1a + A2 + A1）。受け入れ条件は5項目。
- branch `feat/SOT-783-discord-bot-improvements` 上で作業中、runner.ts に未コミットの部分実装あり。

## 現在の実装状態（src/runner.ts、未コミット）
- `CURRENT_ISSUE_FILE = LOG_DIR/current-issue.json` 定数追加済み（runner.ts:97）。
- `setCurrentIssue(item)` / `clearCurrentIssue()` / `getCurrentIssue()` ヘルパー追加済み（runner.ts:1072-1107）。tmp→rename のアトミック書き込み。
- `drainQueue()` 内で `runItem` 直前に `setCurrentIssue(item)`、`finally` で `clearCurrentIssue()` 呼び出し済み（runner.ts:1540, 1550）。→ **R1a の永続化側は実装済み**。
- `IssueQueueMetadata` に `title?`/`url?` 追加、`fetchActiveIssues` の GraphQL に `title`/`url` 追加・マッピング済み（runner.ts:268-269, 340-341, 359-360）。→ **A1 のデータ取得側は実装済み**。
- `fetchActiveIssues` は export 済み。**`getCurrentIssue` は未 export**（runner.ts:1563 の export ブロックに無い）。

## 残作業
1. **runner.ts**: `getCurrentIssue` を export ブロックに追加（discordCommandHandlers から参照するため）。
2. **src/lib/discordCommandHandlers.ts**:
   - `handleStatus`（A2）: `runner.getCurrentIssue()` を参照し、実行中issueと `startedAt` からの経過時間を表示する `**実行中**` 行を追加。なければ「なし」。
   - `handleQueue`（R1a）: 先頭に `0. ▶ 現在実行中: SOT-xxx`（`getCurrentIssue()` 有時のみ）。
   - `handleQueue`（A1）: `runner.fetchActiveIssues()` を呼び identifier→{title,url} マップを作り各項目に付与。API 失敗・未取得は identifier のみにフォールバック（try/catch でクラッシュさせない）。
   - 既存の整形は `formatItem`（discordCommandHandlers.ts:99-108）。queue 読み込みは `runner.loadQueue()`、順序は `queueOrdering.previewQueueOrder`。
3. **src/__tests__/discordCommandHandlers.test.ts**: mock に `getCurrentIssue`/`fetchActiveIssues` を追加し、0番表示・経過時間・タイトルURL付与・実行中なし時フォールバックのテストを追加。

## 検証結果（Worker Non-Response Fallback で Claude Code が実施）
Codex は usage-limit cooldown（exit 75）で検証も非応答のため、Claude Code が品質ゲートを直接実行した。

- `npm run lint` → exit 0
- `npm run typecheck` → 初回 exit 2（discordCommandHandlers.ts:113 で `issue.title`/`issue.url` が `string | null` のため Map<string,{title:string;url:string}> に代入不可）。Gemini 実装の型不備。
  - **fallback 修正**: `activeMap.set` を `issue.identifier && issue.title && issue.url` のときのみ実行するよう1行修正。title/url 欠落時は identifier のみ（仕様通りのフォールバック）。
  - 再実行 → exit 0
- `npm test` → 23 suites / 288 tests 全 pass（新規テスト5件含む）
- e2e: 該当スクリプトなし（N/A）

## Commands Run
- `scripts/ai/run_codex.sh` → exit 75（usage-limit cooldown、非応答）
- `npm run lint` → exit 0
- `npm run typecheck` → exit 0（fallback 修正後）
- `npm test` → exit 0（288 passed）

## Acceptance Criteria
- [x] drain中に current-issue.json が書かれ終了後クリア（runner.ts setCurrentIssue/clearCurrentIssue）
- [x] /queue 先頭に実行中issueが0番表示（実行中なしなら非表示）
- [x] /status に実行中issue＋経過時間表示
- [x] /queue 各項目に Linear タイトル/URL付与（未取得は identifier のみ）
- [x] lint / typecheck / test 全 pass

## Risks
- `fetchActiveIssues` は Linear API を叩く非同期呼び出し。`/queue` は try/catch でフォールバック済み、API 障害でも識別子のみで応答する。
- Gemini は jest のみで検証し tsc を通していなかったため型エラーを見落としていた。fallback で検出・修正済み。

## Next Action
READY_FOR_REVIEW
