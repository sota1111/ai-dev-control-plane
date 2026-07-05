# Worker Report — task-check (SOT-1536)

## Summary
SOT-1536「Antigravity CLIの認証永続化問題に関する調査報告」の実行可否を確認。**Actionable**。
新規 Issue（Todo / No priority / ラベル無 / project=ai-dev-control-plane / コメント無）。SOT-1534 /
SOT-1535 の系譜で、`agy` 慢性認証エラーを試行錯誤で解決に至らせる DEBUG/INVESTIGATION タスク。
本 Issue の新規性 = 人間が **web検索を全面許可** し、**headless Linux/Dev Container で Secret Service /
DBus / keyring が無い・遅いため token を保存/読み戻せず「毎回ログイン要求」になる既存複数報告（Google
AI Forum / GitHub Issue #18 / Zenn / HN）** を証拠として添付。公式 README では認証は system keyring 経由・
有効セッションが無ければ Google Sign-In にフォールバック、Secret Service 応答が1秒超で未ログイン扱いに
なる、という設計説明も引用。**AIがAIを呼ぶことも許可**。`docs/ai/10_plan.md` / `docs/ai/40_acceptance.md`
を本 Issue 向けに更新済み。

## (a) 状態・ラベル・最新コメント
- Status: **Todo**（type=unstarted）。履歴: 一度 Canceled → 2026-07-05T06:38 に Todo へ復帰。
- ラベル: なし（Bug/snapshot 無 → GitHub Issue/スクショ不要）。Priority: No priority。
- Project: ai-dev-control-plane。Team: Sota。Assignee: sota morohashi。添付/コメント: なし。
- 本文: 近い既存報告表 + 公式/準公式情報 + GitHub Issue #18 + Forum 追加情報（1秒超で未ログイン扱い）+
  Zenn 検証（v1.0.1 で保存方式変更の可能性、手順を信用しすぎない注記）+ 追加検索語。
  結論仮説 = 「固有の環境破損ではなく、Antigravity CLI + headless Linux 系の既知の認証永続化問題」。

## (b) 受け入れ条件（`docs/ai/40_acceptance.md` に記載）
- [ ] 認証失敗（認証直後1回成功→次回また要求→約40秒 timed out）の根本原因を実測で確定（web報告との一致検証）。
- [ ] web提示の対策（`dbus-x11`/`libsecret-1-0`/`gnome-keyring` 導入・Secret Service 起動・default keyring
      作成・1秒超で未ログイン扱い挙動）を本 Dev Container で試行し効果を実測。
- [ ] Secret Service 応答遅延（>5s timeout で有効 file token を破棄する読取経路）が解決可能か upstream 欠陥かを判定。
- [ ] 解決手順 or 恒久回避（`ANTIGRAVITY_DISABLED=1` 即フォールバック、機能不変）+ upstream 起因の明示。
- [ ] 調査報告を Linear へ。

## (c) Actionable?
**Yes（READY_FOR_REVIEW）**。Todo・明確な actionable スコープ（原因特定＋対策試行＋解決/恒久回避提示）。
web検索・AIがAIを呼ぶ両方を明示許可。先行 SOT-1534/SOT-1535 の確定知見（真因 = `agy -p` silent-auth の
keyring probe が 5s timeout で有効 file token を破棄する upstream 読取欠陥）を土台に、本 Issue の web 証拠で
裏付け／keyring 導入策を実測できる。人間入力待ち・terminal 状態ではない。

## (d) タスク種別・スコープ
- 種別: **DEBUG / INVESTIGATION**（対策試行を含む。keyring 導入 script/env 変更まで踏み込みうる）。
- スコープ: 対象 repo = /workspaces/ai-dev-control-plane（agy を実行するハーネス側）。既知の keyring 5s
  timeout 読取経路を軸に、web報告の keyring 導入策を本 Dev Container で実測 → 解決可否を判定 → 手順 or
  恒久回避を提示。Antigravity CLI upstream 本体修正・OAuth プロバイダ変更はスコープ外。
  SOT-1534/1535 の既知見を再利用しゼロから再調査しない。

## Next Action: READY_FOR_REVIEW
