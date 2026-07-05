# Plan — SOT-1534 Agy認証エラー (REOPEN#2)

## 解釈（1–2行）
`agy`(Antigravity CLI)の認証が「対話ログイン直後は非対話 `agy -p` で成功するのに、数分後に再実行すると
再認証を要求され失敗する」原因を調査する DEBUG タスク。他CLI(Claude/codex/gemini)では起きず agy 固有＝
**時間経過での資格情報失効／リフレッシュ結果の非対話経路への非永続化**が焦点（前回「-pは一度も通らない」
という結論を人間の新観測が反証）。

## タスク種別
DEBUG（root-cause 調査）。コード変更なしの調査/レポート更新が既定成果物。本Issueは「AIがAIを呼ぶ」禁止を
免除しているため、必要なら agy を実起動して対話認証→`agy -p` を時間差で連続実行し失効を再現してよい。

## 意図するスコープ / 判断
- 再現: 対話ログイン直後の `agy -p` 成功を確認 → 数分後に再実行して失敗を再現し、失効までの時間・
  観測点（access token expiry / keyring / file token）を接地する。
- 特定: なぜ agy 固有か（トークン寿命・リフレッシュ機構・keyring 依存が他CLIと異なる点）と、
  既特定の「`agy -p` silent-auth keyring プローブが 5s タイムアウトで有効 file token を破棄」
  （SOT-1535, [[sot1535-agy-auth-keyring]]）との関係を明確化。
- 根本原因を1点に絞る（短寿命 access token + リフレッシュ結果が非対話経路で永続化されず次回復元不能、等）。
- 是正/回避: `ANTIGRAVITY_DISABLED=1` での即フォールバック（機能不変）／agy 真利用は対話セッション／
  根本は upstream 対応、を提示。
- 成果物は `docs/ai/investigations/SOT-1534-agy-auth-error.md` の更新。SOT-1534/1535 の既知見を再利用し
  ゼロから再調査しない。
