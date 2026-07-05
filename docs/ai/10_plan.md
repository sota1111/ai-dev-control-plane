# Plan — SOT-1536 Antigravity CLI 認証永続化問題の調査報告

## 解釈（1–2行）
`agy`(Antigravity CLI)の慢性認証エラー（認証直後の1回のみ成功→次回また要求→約40秒で timed out）を、
人間提供のweb証拠（headless Linux/Dev Container で Secret Service/DBus/keyring が無い・遅いため token を
保存/読み戻せず「毎回ログイン」になる既存複数報告）を踏まえて根本原因を確定し、解決または恒久回避策を
提示する DEBUG/INVESTIGATION タスク。web検索・AIがAIを呼ぶことを共に許可。

## タスク種別
DEBUG（root-cause 調査 + 対策試行）。web報告の対策（`dbus-x11`/`libsecret-1-0`/`gnome-keyring` 導入、
Secret Service 起動、default keyring 作成）を本 Dev Container で実測し、Secret Service 応答遅延
（>5s timeout で有効 file token を破棄する読取経路）が解決可能か upstream 欠陥かを判定する。

## 意図するスコープ / 判断
- 既存調査 SOT-1535([[sot1535-agy-auth-keyring]]) / SOT-1534([[sot1534-agy-auth-error]]) の確定知見
  （真因 = `agy -p` silent-auth の keyring probe が 5s timeout で有効 file token を破棄する upstream 読取欠陥）を
  出発点にし、本 Issue が持ち込んだ web 証拠でこれを裏付け／反証する。
- web報告の keyring 導入策を実試行し、効果の有無を実測ログで示す（secret-tool 導入済でも DBUS 未設定で
  TO 不変、という既知見の再検証を含む）。
- 解決に至れば手順を、至らなければ恒久回避（`ANTIGRAVITY_DISABLED=1` で codex/claude へ即フォールバック、
  機能不変）と upstream 起因である旨を明示。
- 成果物 = 調査報告（`docs/ai/investigations/` 配下、SOT-1534/1535 と同系）＋ Linear 報告。コード変更は
  keyring 導入スクリプト等に限定される可能性があり doc/scaffold 中心。ゼロから再調査せず既知見を再利用する。
