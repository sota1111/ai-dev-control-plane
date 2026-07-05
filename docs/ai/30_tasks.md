# Tasks — SOT-1534 Agy認証エラー (REOPEN#2)

## 分解判断: 不要
理由: agy 固有の「対話ログイン直後は `-p` 成功→数分後に失効し再認証要求で失敗」という単一の
根本原因を特定する DEBUG 調査ユニット。独立フィーチャ・別デプロイ単位・複数PR・順序依存がなく、
分解のオーバーヘッド＞価値。

## 単一作業ユニット（親 SOT-1534 をそのまま調査・DEBUG）
対象: ハーネス自身（`/workspaces/ai-dev-control-plane`）の Antigravity ワーカー経路。
明示許可: 本Issueは「AIがAIを呼ぶ」禁止を免除 → `agy` を実起動して再現・切り分け可。

1. **再現**: agy を対話ログイン → 直後に `agy -p "Reply with exactly: OK"` 成功を確認 →
   数分後に同じ `agy -p` を再実行して失敗（再認証要求）を再現。失効までの時間を記録。
2. **観測点の特定**: 成功時→失敗時の間で何が変わるか実測。
   - file token (`~/.gemini/antigravity-cli/antigravity-oauth-token`) の実体トークン長・expiry・auth_method。
   - access token の expiry と現在時刻の関係（短寿命か）。
   - keyring / D-Bus (`DBUS_SESSION_BUS_ADDRESS`, `secret-tool`) の状態。
   - CLI ログ `~/.gemini/antigravity-cli/log/cli-*.log` の auth/oauth/token/refresh/keyring/timeout 語。
3. **agy 固有性の説明**: なぜ Claude/codex/gemini CLI では起きないか（トークン寿命・リフレッシュ機構・
   keyring 依存の差）。SOT-1535 の「silent-auth keyring プローブ 5s タイムアウトで有効 file token を破棄」
   ([[sot1535-agy-auth-keyring]]) と今回観測の整合を取る（リフレッシュ後の書き戻し失敗 vs 読取側破棄）。
4. **根本原因を1点に特定**: 例) 短寿命 access token + リフレッシュ結果が非対話 `-p` 経路で
   永続化されない（もしくは keyring 読取 5s TO で有効トークン破棄）ため次回 `-p` が資格情報を復元できない。
5. **是正/回避の提示**: `ANTIGRAVITY_DISABLED=1` での即フォールバック（機能不変）／agy 真利用は対話
   セッション維持／根本は upstream 対応。適用可能なら運用回避を適用。
6. **成果物**: `docs/ai/investigations/SOT-1534-agy-auth-error.md` を REOPEN#2 の観測・切り分け・結論で更新。
   コード変更なし → lint/test は doc-only のため対象外。

## 検証
- 対話直後の `-p` 成功 と 数分後の `-p` 失敗 の両方を実測ログで提示。
- 根本原因が1点に接地し、是正/回避が明記されていること。

## スコープ外
- 他 Issue の処理・子 Issue 作成・パイプライン全体の再設計。
- agy 以外のワーカー経路の変更・ハーネスのフォールバック機構改変（既に正常動作と確認済み）。
- agy 自体のバージョン更新（最新版前提）。

## Next role (implementation) 向けメモ
DEBUG=実測駆動。盲目結論不可。Antigravity 自身が調査対象で慢性 auth 失敗のため、実作業は
codex/claude チェーンが担う想定。破壊的操作は事前承認。
