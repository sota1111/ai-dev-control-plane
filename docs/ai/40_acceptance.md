# Acceptance Criteria — SOT-1536: Antigravity CLI 認証永続化問題の調査報告

Issue type: **DEBUG / INVESTIGATION**（web検索許可、AIがAIを呼ぶことを許可）
Target repo: /workspaces/ai-dev-control-plane
Status: Todo（actionable）

## 要件解釈
`agy`（Antigravity CLI）の慢性認証エラーに対し、試行錯誤して問題を解決に至らせる。
人間が提供したweb検索結果（WSL2/headless Linux/Dev Container で Secret Service / DBus /
keyring が無い・遅い・別セッションを見るため token を保存/読み戻しできず「毎回ログイン要求」に
なる、という既存複数報告）を踏まえ、根本原因を確定し、実効的な解決または恒久回避策を提示する。

## 受け入れ条件
- [ ] `agy` の認証失敗（認証直後の1回のみ成功→次回また要求→約40秒で timed out）の根本原因を
      実測で確定する（web報告と自環境の一致/不一致を検証）。
- [ ] web検索で示された対策（`dbus-x11` / `libsecret-1-0` / `gnome-keyring` 導入、Secret Service
      起動、default keyring 作成、Secret Service 応答1秒超で未ログイン扱いになる挙動）を
      本 Dev Container で試行し、効果の有無を実測で示す。
- [ ] Secret Service の応答遅延（>5s timeout で有効な file token を破棄する読取経路）が
      解決可能か、あるいは upstream 欠陥として回避不能かを判定する。
- [ ] 解決に至った場合はその手順を、至らない場合は恒久回避策
      （例: `ANTIGRAVITY_DISABLED=1` で codex/claude へ即フォールバック、機能不変）と
      upstream 起因である旨を明示する。
- [ ] 調査結果・根拠・再現ログ・結論を調査報告としてまとめる（Linear へ報告）。

## スコープ外
- Antigravity CLI 本体（upstream）のソース修正。
- 認証プロバイダ（Google OAuth）側の変更。

## 参考（既存調査・lineage）
- SOT-1535: `agy -p` 非対話 silent-auth の keyring probe が 5s timeout（keyring.go:95）し
  有効 file token を破棄 → 真因は読取経路 upstream 欠陥。
- SOT-1534: 対話ログイン直後は `-p` 成功→数分後失敗は失効でなく cold-start 毎の keyring 5s TO。
  secret-tool 導入済でも DBUS 未設定で TO 不変。
- これらは本 Issue（SOT-1536）が web証拠で裏付ける「headless Linux + system keyring 不安定」
  仮説と一致する。
