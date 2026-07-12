# T4 — DOC ベンチマークタスク(最も簡単・再現可能)

worker 性能比較の「簡単なベンチマーク1件」として選定した固定タスク。DOC 種別は副作用が小さく、
成果物が読みやすく採点しやすいため最初の1件に適する(`docs/ai/20_design.md` §3 の T4)。

## 固定条件(apples-to-apples)
- **対象リポ**: 小さな既存リポ(例: `window-runner`)を**固定 SHA** から開始。各 run 前にリポを
  その SHA に戻す(`git checkout <SHA> -- .` / clean worktree)。
- **role**: `implementation` のみ worker を入れ替える。他 role は固定。
- **反復**: ノイズ低減のため主要 worker は 2 回反復推奨(時間が許す範囲)。

## 課題文(prompt・固定)
> リポジトリの `README.md` に「## 動作環境」節を1つ追記せよ。内容は実際のコード/設定から読み取れる
> 事実に接地すること(実行方法・必要ランタイム・エントリポイント)。既存の記述は変更しない。追記のみ。

## 受け入れ条件
- [ ] `README.md` に「## 動作環境」節が1つ追加されている(既存節は不変)。
- [ ] 記述がリポの実態(package.json / エントリファイル等)に接地し、誤り・リンク切れがない。
- [ ] 差分は追記のみ(不要な整形・無関係変更なし)。
- [ ] 既存テストがあれば不変(DOC のため通常影響なし)。

## メトリクス取得の指針(記録者向け)
- M1 品質ゲート: DOC のため lint/typecheck/test が該当すれば通ること(通常 N/A→pass 扱い)。
- M2 受入充足率: 上記4条件の充足数/4。
- M3 デバッグ数: verification→implementation ループ回数(DOC は通常 0)。
- M4 所要: `docs/ai/auto_logs/` の role タイムスタンプ差。
- M5 中断: usage-limit / exit75 handoff 回数。
- M6 差分: `git diff --stat`。追記のみ・不要変更なしなら適正。
- M7 介入: BLOCKED/NEEDS_USER_INPUT で止まったか。
- M8 定性: 記述の正確さ・過不足を 1–5 でレビュア採点。
