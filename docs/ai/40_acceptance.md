# Acceptance Criteria — SOT-1534 (Agy認証エラー / REOPEN#2)

Issue: SOT-1534 — "Agy認証エラー"
Type: DEBUG (root-cause investigation)
Status at task-check: Todo / No priority / No labels / project=ai-dev-control-plane
Note: 本Issueは明示的に「AIがAIを呼ぶ」禁止を免除（必要なら agy を実起動して再現可）。

## Requirement (latest human comment, 2026-07-05 05:59)
> OAuth 認可コードは対話型で完了し、その後、非対話（ハーネス `-p`）で**成功している**。
> しかし、数分後に再実行すると再度認証が必要になり、失敗する。
> これは、他の Claude, codex, gemini cli では発生していない。**agy の認証に原因がある**。

新しい観測が前回結論（「`-p` は一度も成功しない」）を反証している。焦点は
「対話ログイン直後は `-p` が通るのに、数分後の再実行で再認証が必要になり失敗する」
という**時間経過での資格情報の失効／リフレッシュ（書き戻し）の失敗**に移った。

## Acceptance criteria
- [ ] 「対話ログイン直後の `-p` 成功 → 数分後の `-p` 失敗（再認証要求）」の再現条件を接地する
      （どのくらいの時間で失効するか、失効の観測点＝トークン/keyring/ファイルのどれか）。
- [ ] agy 固有である理由を特定する（Claude/codex/gemini CLI では起きない差分＝トークンの
      永続化先・リフレッシュ機構・keyring 依存の違い）。
- [ ] 既特定の「`agy -p` の silent-auth keyring プローブが 5s タイムアウト」（SOT-1535）との関係を
      明確化する（リフレッシュ後の書き戻し失敗か、読取側タイムアウトで有効トークン破棄か）。
- [ ] 根本原因を1点に絞って報告する（例: 短寿命 access token + リフレッシュ結果が非対話経路で
      永続化されず、次回 `-p` が有効資格情報を復元できない）。
- [ ] 是正策 or 恒久回避を提示（`ANTIGRAVITY_DISABLED=1` で即フォールバック／agy 真利用は対話セッション／
      根本は upstream 対応）。
- [ ] 成果物は調査レポート（`docs/ai/investigations/SOT-1534-agy-auth-error.md` を更新）。
      コード変更なし → lint/test は doc-only のため対象外。

## Out of scope
- agy 以外のワーカー経路の変更、ハーネスのフォールバック機構の改変（既に正常動作と確認済み）。
- agy 自体のバージョン更新。
