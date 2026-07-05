# Tasks — SOT-1536: Antigravity CLI 認証永続化問題の調査報告

## 分解判断: 不要
理由: 単一の DEBUG/INVESTIGATION（agy 認証の keyring 永続化問題）で、独立した機能・別 rollback 単位・
複数 PR・逐次依存が無く、1 作業単位で完結する。SOT-1534/1535 の系譜で対象範囲は明確。

## 単一作業ユニット（親 SOT-1536 をそのまま処理）
対象: ハーネス自身（`/workspaces/ai-dev-control-plane`）の Antigravity ワーカー経路。
明示許可: 本Issueは web検索全面許可 + 「AIがAIを呼ぶ」許可 → `agy` を実起動して再現・切り分け可。

### T1: 環境実測（現状の切り分け）
- `agy` 認証を対話で完了 → 直後の `agy -p` 成功、cold-start での再失敗（~40s timed out）を再現。
- keyring/DBus 状態を実測: `DBUS_SESSION_BUS_ADDRESS` の有無、`gnome-keyring-daemon` 起動有無、
  `secret-tool` 応答、`libsecret-1-0`/`dbus-x11`/`gnome-keyring` の導入有無。
- 証跡は agy CLI ログ `~/.gemini/antigravity-cli/log/cli-*.log`（keyring probe の 5s timeout 行を確認）。

### T2: web報告の対策を試行・実測
- `dbus-x11` / `libsecret-1-0` / `gnome-keyring` を導入し、Secret Service 起動 + default keyring 作成。
- 導入後に再度 `agy -p` を cold-start で連続実行し、keyring probe の 5s timeout が解消するか、
  有効 file token が破棄されず読み戻せるかを実測ログで比較。
- 「Secret Service 応答が1秒超で未ログイン扱い」挙動が本環境の 5s timeout と同一/別現象かを判定。

### T3: 根本原因の確定と結論
- 解決した場合: 恒久化手順（keyring 導入 script / devcontainer postCreate 等の提案）をまとめる。
- 解決しない場合: upstream 読取経路欠陥（`agy -p` silent-auth が keyring 固定で TO 時に有効 file token へ
  フォールバックせず破棄）である旨を明示し、恒久回避 `ANTIGRAVITY_DISABLED=1`（codex/claude 即フォールバック、
  機能不変）を提示。

### T4: 調査報告
- 調査結果・再現ログ・結論を `docs/ai/investigations/` 配下の報告にまとめ、Linear へ報告する。

## 検証
- 対策導入 前/後 の `agy -p` cold-start 実測ログを提示。
- 根本原因が1点に接地し、解決手順 or 恒久回避が明記されていること。

## スコープ外
- 他 Issue の処理・子 Issue 作成・パイプライン全体の再設計。
- Antigravity CLI upstream 本体修正・OAuth プロバイダ変更。

## Next role (implementation) 向けメモ
DEBUG=実測駆動。盲目結論不可。Antigravity 自身が調査対象で慢性 auth 失敗のため、実作業は
codex/claude チェーンが担う想定。破壊的操作（パッケージ導入等）は best-effort、事前承認の範囲で。
SOT-1534/1535 の既知見を再利用しゼロから再調査しない。
