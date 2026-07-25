# Final Report — SOT-1932（マルチターゲットレジストリ + 改善方針の起案エンジン / IMPLEMENT）

親 SOT-1913（Kaggleコンペ自動化・PLAN v4）の先頭実装子。人間コメント「実装を開始してください」を受け、
依存順の先頭 SOT-1932 を実装・検証・PR化した（後続 SOT-1933/1934/1935 は default OFF・In Review パーク）。

## Summary
6コンペ×2系統(claude=旧fable / gpt=旧sol)=12ターゲットの改善サイクル・レジストリと、cron が LLM を
呼ばずに「その枠の当番コンペの2ターゲットを起案するか（draft）／ガードで抑制するか（skip）」を決める
**決定的な起案エンジン**を実装。単一スケジュール JST [0,4,8,12,16,20]・1枠=1コンペのローテーション。
default OFF（registry.enabled + env KAGGLE_IMPROVE_ENABLED の2段 kill switch）。

## Changed Files
- `src/lib/kaggleImprovement.ts`（新規）— レジストリ parse / 枠→コンペ rotation 解決 / ガード判定 /
  起案Issue タイトル・本文テンプレ生成。純粋関数（I/O なし）。
- `scripts/ai/kaggle_targets_registry.json`（新規）— 6コンペ×2系統=12ターゲット、rotation 表、
  per-competition 提出 spec。`enabled:false`（default OFF）。
- `src/runner-cli.ts` — `kaggle-improve-plan` サブコマンド追加（dry-run 専用・CyclePlan を JSON 出力・
  不正レジストリは exit 1 で fail-loud）。
- `src/__tests__/kaggleImprovement.test.ts`（新規）— parse/rotation/ガード/dry-run/同梱レジストリ検証。

## Commands Run
- `npm run lint` — PASS。
- `npm run typecheck` — PASS。
- `npx jest`（`.worktrees/`・`.targets/` を除外）— **91 suites / 1131 tests PASS**（旧 88/1087 から
  本 Issue のテスト追加分）。
- CLI 実behavior 確認:
  - default（env OFF）→ `active:false, targets:0`（kill switch 動作）。
  - registry enabled + env ON, hour 0（ptcg 当番）→ claude/gpt 両ターゲット `draft`、claude 本文に
    前回提出 digest（`rank 42 / score 571.8`）が埋め込まれる。

## Note — `npm test` の見かけ上の失敗について
素の `npm test` はこの作業ツリーで 150 test failed と出るが、全て `.worktrees/`・`.targets/`（過去 run の
git worktree / clone 済み target repo。**未追跡のランタイム生成物**、本変更と無関係）配下のテストである。
jest 設定に `testPathIgnorePatterns` が無いため走査対象に入るだけで、クリーンチェックアウトでは
`src/` 配下 91/1131 が全緑。`package.json`（jest 設定を含む）は Safety Rule により変更していない。

## Acceptance Criteria
- [x] 単一スケジュール [0,4,8,12,16,20] と 枠→コンペ ローテーション表がレジストリに定義される
- [x] dry-run で当番コンペの claude/gpt 2ターゲット分の起案プレビューが出る（前回提出結果 digest 含む）
- [x] ガードが期待通り抑制する（cap/cooldown/新材料なし/未完了サイクル）— 単体テストで網羅
- [x] 既存テスト緑・lint/typecheck 0（クリーンチェックアウト）

## Risks / Remaining
- 実起案（Linear Issue 作成）・実提出は本 Issue の範囲外（後続 SOT-1933/1934）。本 Issue は dry-run 専用。
- レジストリの kaggle_competition slug は暫定。実 slug は各 repo の子Issue側で確定。

## Acceptance: PASS
## Next Action: READY_FOR_REVIEW
