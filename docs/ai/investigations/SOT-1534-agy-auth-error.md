# SOT-1534 調査レポート — Antigravity (agy) 認証エラーの根本原因

種別: DEBUG / 調査（コード変更なし・原因特定と是正案の提示）
対象: `/workspaces/ai-dev-control-plane`（ハーネス自身の Antigravity ワーカー経路）
再現日時: 2026-07-05 05:24 UTC
備考: 本 Issue は「AIがAIを呼ぶ」禁止を明示免除しているため、`agy` を直接起動して再現・観察した。

---

## 1. 結論（根本原因）

**agy はこのコンテナ内で非対話（`-p` / print モード）で使える有効な資格情報を持てず、対話 OAuth に
フォールバックするが対話不能なため約40秒でタイムアウトして exit 1 で落ちる。** これは一過性の
usage-limit ではなく、人間の再認証（または環境整備）が必要な**慢性的な認証障害**である。

具体的には次の3段が連鎖して失敗する:

1. **ファイルベースのトークンが無効** — `~/.gemini/antigravity-cli/antigravity-oauth-token` は
   `auth_method=consumer`・token 長 15 文字の実質プレースホルダで、agy は
   `You are not logged into Antigravity.` を返す（token source 取得失敗）。
2. **キーリング（OS 資格情報ストア）経由の silent auth が5秒でタイムアウト** — agy はキーリングに
   有効期限内トークン（`expiry=2026-07-05 05:56:59, expired=false`）を見つけるが、実際のシークレット
   取得が5秒でハングして `keyringAuth: timed out after 5s, skipping keyring auth`。コンテナには
   Secret Service / gnome-keyring デーモンも session D-Bus も無い（`DBUS_SESSION_BUS_ADDRESS` 未設定、
   `gnome-keyring-daemon`/`secret-tool` 不在）ため、キーリングアクセスが完了しない。
3. **対話 OAuth にフォールバックするが完了不能** — silent auth 失敗後 agy は OAuth フローを開始し
   `Authentication required. Please visit the URL...` を表示、`xdg-open` 不在でブラウザも開けず
   (`Failed to open browser: exec: "xdg-open": ... not found`)、`-p` 非対話モードなので認可コードを
   貼る人間もいない。30秒待って `Print mode: auth timed out` → `Error: authentication timed out.`。

**約40秒の内訳** = 起動/初期化 ~5s ＋ キーリング待ち 5s ＋ OAuth 待ち 30s。

## 2. 一次証拠

再現（直接起動、60s cap）:
```
$ agy -p "Reply with exactly: OK" --dangerously-skip-permissions --print-timeout 55s
Error: authentication failed or timed out
---- exit=1  elapsed=40s ----
```

CLI ログ `~/.gemini/antigravity-cli/log/cli-20260705_052421.log`（抜粋・時系列）:
```
E ... server.go:645] Failed to get OAuth token: error getting token source from auth provider:
      You are not logged into Antigravity.
I ... printmode.go:223] Print mode: not authenticated, trying silent auth
I ... keyring.go:59]  keyringAuth: loaded token, expiry=2026-07-05 05:56:59 expired=false
W ... keyring.go:95]  keyringAuth: timed out after 5s, skipping keyring auth
I ... printmode.go:229] Print mode: silent auth failed, triggering OAuth
I ... auth_manager.go:107] Starting OAuth authentication flow
   Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?...
   Waiting for authentication (timeout 30s)...
W ... browser.go:301] Failed to open browser: exec: "xdg-open": executable file not found in $PATH
E ... printmode.go:277] Print mode: auth timed out
Error: authentication timed out.
```

環境事実:
- `DBUS_SESSION_BUS_ADDRESS` 未設定 / `gnome-keyring-daemon`・`secret-tool` 不在 / `xdg-open` 不在。
- `~/.gemini/oauth_creds.json`（gemini 系 OAuth）: `expiry_date=2026-06-28`（**期限切れ**、refresh_token あり）。
- `~/.gemini/antigravity-cli/antigravity-oauth-token`: `auth_method=consumer`、token 長 15。ファイル更新は
  07-05 04:57（それでも上記のとおり無効判定）。
- `~/.gemini/settings.json`: `security.auth.selectedType=oauth-personal`（API キー方式ではない）。

## 3. ハーネス側の扱いは正しい（=バグではない）

- `scripts/ai/run_antigravity.sh` は非0終了かつ非 usage-limit を `worker-health-record` で分類し、
  `src/lib/workerHealth.ts` の `AUTH_FAILURE_RE`（`authentication failed`/`auth failed`/`timed out` 等に
  一致）で **auth_failure（chronic）** と判定 → `antigravity.auth_unhealthy.json` マーカーを短 TTL
  （既定 `WORKER_AUTH_UNHEALTHY_TTL_SECONDS=900s`）で作成し、ディスパッチャは exit 75 で次ワーカー
  （codex/claude）へハンドオフする。
- つまり「起動時ゲート通過 ≠ 認証復旧」。マーカー失効後は毎回 agy を再起動して**約40秒を消費**してから
  同じ auth 障害で落ち、再びフォールバックする。過去メモの「~40s, exit75」と一致（本 run でも
  04:17 に auth_unhealthy マーカーが記録され、本調査時点では失効済みだったため実起動で再現できた）。

## 4. 是正案（人間対応が必要）

コード欠陥ではなく**資格情報/環境の問題**。実効性の高い順:

1. **agy を対話ログインし直してファイルベーストークンを更新する（本命）。** コンテナ内で `agy` を
   対話起動し、表示される OAuth URL をホストのブラウザで開いて認可 → 認可コードを端末に貼る。agy は
   コンテナ検出時 `Using file-based token storage` を使うため、成功すればファイルストアに有効トークンが
   書かれ、以後の `-p` 実行で `You are not logged into Antigravity.` が解消する見込み。
   （現状の `antigravity-oauth-token`＝consumer/15文字 は無効なので、この再ログインが必須。）
2. **復旧までは agy を明示無効化して40秒/回の浪費を止める。** `ANTIGRAVITY_DISABLED=1` を設定すると
   run_antigravity.sh が即 exit 75 で codex/claude にフォールバックし、無駄な起動待ちを回避できる
   （既に SOT-1522/1524 等で codex フォールバックが実運用で機能している）。
3. **キーリング待ちを避ける環境整備（任意・補助）。** session D-Bus + gnome-keyring を devcontainer に
   用意すれば silent auth の5秒ハングが解消するが、コンテナでは重い。ファイルストア方式（案1）で足りる。
4. **auth-unhealthy マーカー TTL の延長（任意）。** 慢性障害中の再試行間隔を延ばし（例
   `WORKER_AUTH_UNHEALTHY_TTL_SECONDS` を 900→3600 等）、40秒浪費の頻度を下げる。恒久設定変更のため
   人間判断ゲート。

## 5. スコープ / 次アクション
- 本 leg はコードを変更しない（原因特定と是正案提示が成果物）。案1（再ログイン）と案2
  （`ANTIGRAVITY_DISABLED`）は人間の資格情報操作/運用判断が必要なので In Review で人間に委ねる。
- Linear へは根本原因の要約＋是正案（案1/案2）を報告し、Issue は In Review で停止する。

---

## 6. REOPEN#1（2026-07-05 05:47 UTC）— 「コンソールでは応答が返る＝認証は通っている。状況をまとめて。」

人間の反証コメント: 「コンソールで agy を叩くと応答が返ってくるので、認証は通っている」。
これは**正しい観察**であり、初回結論と矛盾しない。両者は**別モードの話**である。

### 6.1 一言でまとめると
- **対話（interactive／TTY あり）で `agy` を叩く**＝人間が OAuth を完了できる／セッションが揃うため
  **応答が返る＝認証は通る**。⇒ アカウント／資格情報そのものは壊れていない。
- **ハーネス経路 `agy -p`（print／非対話）**＝有効な資格情報を非対話で取得できず、依然として
  約40秒で `authentication failed or timed out`（exit 1）で落ちる。
- つまり問題は「認証が壊れている」ではなく、**非対話（`-p`）で使える資格情報が用意できない**こと。
  ハーネスは `scripts/ai/run_antigravity.sh:180` で常に `-p` を付けて非対話起動するため、対話で
  通ることは非対話の成否に効かない。

### 6.2 REOPEN 時点の一次証拠（本 leg で再取得）
- **非対話は今も失敗**（人間の対話ログイン後でも再現）:
  ```
  $ agy -p "Reply with exactly: OK" --dangerously-skip-permissions --print-timeout 50s
  Error: authentication failed or timed out
  ---- exit=1  elapsed=40s ----
  ```
- **ファイルトークンは依然プレースホルダ**: `~/.gemini/antigravity-cli/antigravity-oauth-token` は
  ファイルサイズこそ 498B（mtime 05:25）だが、JSON 実体は `token`（**長さ 15**）＋
  `auth_method=consumer` のまま＝print モードの `You are not logged into Antigravity.` は未解消。
- **非対話環境は不変**: `DBUS_SESSION_BUS_ADDRESS` 未設定 / `xdg-open` 不在 / `secret-tool` 不在
  → キーリング silent auth の5秒タイムアウトも OAuth 非完了も §1〜§3 のまま。
- **auth-unhealthy マーカーは失効済み**（`expiresAtEpoch=1783225942` < now `1783230546`）。よって
  ハーネスは次回 agy を再起動し、同じ約40秒 auth 失敗 → exit 75 → codex/claude フォールバックを繰り返す。

### 6.3 なぜ「対話は通るのに非対話は落ちる」のか（差分の要点）
| 項目 | 対話（人間のコンソール） | 非対話（ハーネス `agy -p`） |
| --- | --- | --- |
| OAuth 認可コード入力 | 人間が URL を開き貼れる → 完了 | 人間不在・`-p` で待てず 30s タイムアウト |
| ブラウザ起動 | 人間側で開ける | `xdg-open` 不在 |
| キーリング silent auth | セッション/D-Bus があれば取得可 | D-Bus 無し → 5s タイムアウト |
| ファイルトークン | （対話成功時は更新され得る） | 15文字プレースホルダで無効のまま |
| 結果 | 応答が返る（認証 OK） | 約40秒で auth 失敗（exit 1）→ exit 75 |

### 6.4 是正（§4 と同じ・非対話に効くものだけ）
非対話 `-p` を通すには、**print モードが読む file-based token store に有効トークンを書く**必要がある。
- **本命**: コンテナ内で `agy` を対話起動して**最後までログインを完了**し、`antigravity-oauth-token`
  が consumer/15文字ではない**有効トークン**に更新されることを確認する（現状 05:25 更新でも実体は
  未更新なので、ログインが file store まで到達していない可能性が高い）。更新後に
  `agy -p ...` が成功するかを本 leg と同じコマンドで検証する。
- **暫定**: 復旧まで `ANTIGRAVITY_DISABLED=1` を設定 → 40秒/回の浪費を止め codex/claude へ即フォールバック。
- 環境整備（D-Bus+gnome-keyring）や marker TTL 延長は補助（§4-3/§4-4）。

### 6.5 結論
人間の「認証は通っている」は**対話モードでは正しい**。一方でハーネスは常に**非対話 `-p`** で起動し、
そこで使える有効トークンが無い（file token 無効＋keyring/OAuth 非完了）ため**引き続き失敗**する。
コード欠陥ではなく、**非対話で使える資格情報が未整備**という一点に尽きる。ハーネス側の検知・
フォールバックは正しく機能している。
