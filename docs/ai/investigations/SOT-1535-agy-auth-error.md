# SOT-1535 調査レポート — agy 認証エラーの原因特定と解決

種別: DEBUG（原因特定＋解決）
対象: `/workspaces/ai-dev-control-plane`（ハーネス自身の Antigravity ワーカー経路）
再現日時: 2026-07-05 06:03–06:17 UTC
備考: 本 Issue は「AIがAIを呼ぶことを許可する」と明示しているため、`agy` を直接起動し実測で切り分けた。
先行調査 [SOT-1534](SOT-1534-agy-auth-error.md) を土台に、**新たな2つの反証実験**を追加した。

---

## 1. 結論（根本原因）

**このヘッドレス Dev Container では `agy -p`（非対話 print モード＝ハーネスが常に使うモード）が
認証を完了できない。** silent auth（キーリング経由）が**5秒でタイムアウト**し、対話 OAuth に
フォールバックするが、ブラウザ(`xdg-open`)も認可コードを貼る人間もいないため失敗する。

決定的に重要な新事実（SOT-1534 からの前進）:

- **(A) 有効な file token があっても `-p` は失敗する。** 人間の再認証で `antigravity-oauth-token` は
  今回**有効**（access_token 260 文字 / refresh_token 103 文字 / `expiry=2026-07-05T06:56:59Z`,
  `expired=false`, `auth_method=consumer`）になっているが、`agy -p` は3回連続とも失敗した。
  → 「再認証すれば直る」は**誤り**。silent auth はこの有効 token を読み込んだ上で捨てている。
- **(B) キーリングを実際に用意しても 5 秒タイムアウトは消えない。** `gnome-keyring` / `dbus-x11` /
  `libsecret-1-0` を導入し、session D-Bus と `gnome-keyring-daemon --unlock` を起動して
  `secret-tool store/lookup` が正常動作する状態にしても、`agy -p` の silent auth は依然
  `keyring.go:95 keyringAuth: timed out after 5s, skipping keyring auth` で落ちた。
  → 原因は単に「keyring パッケージが無い」だけではなく、**agy の consumer silent-auth の
  keyring ラウンドトリップがこの環境では 5 秒以内に完了しない**（かつ有効 file token への
  非対話フォールバックを持たない）ことにある。

人間の症状「認証直後の1回だけ動く」は今回**再現しなかった**（有効 token 直後でも全 `-p` 失敗）。
人間が対話コンソールで成功するのは、silent auth 失敗後の OAuth を人間がブラウザで完了しているため。
`-p` にはそれを完了する人間がいないので慢性的に失敗する（SOT-1534 の「対話↔非対話は別モード」を実証補強）。

人間の最有力仮説「OAuth token refresh 後の keyring 書き戻し失敗」は**方向は正しい**（keyring が主因）が、
正確な機構は**書き戻し(write)側でなく silent auth の読み取り/プローブ側の 5 秒タイムアウト**であり、
keyring を用意しても解消しない点が異なる。

---

## 2. 実測エビデンス

### 2.1 環境（Issue 手順 2–4）
| 項目 | 実測 | 判定 |
| --- | --- | --- |
| `gnome-keyring` / `libsecret` / `dbus-x11` | いずれも**未導入**（`gnome-keyring-daemon`/`secret-tool`/`dbus-launch` 不在） | keyring 保存先なし |
| `DBUS_SESSION_BUS_ADDRESS` | **空** | Secret Service へ接続不可 |
| `gnome-keyring-daemon` | **未起動** / `dbus-daemon` 未起動 | 資格情報ストア機能せず |
| `XDG_RUNTIME_DIR` | 空 / TTY: not a tty（tmux 非対話） | 対話 OAuth 不能 |
| `agy` | `/home/vscode/.local/bin/agy` v1.0.16 | — |

### 2.2 file token（Issue 手順 6 の「1回目だけ成功」検証）
`~/.gemini/antigravity-cli/antigravity-oauth-token`（500B, mtime 05:57:00）は
`{token:{access_token(260), token_type:Bearer, refresh_token(103), expiry:2026-07-05T06:56:59Z}, auth_method:consumer}`。
`expired=false`。**同一シェルで `agy -p` を3回連続実行 → 全て exit 1 `Error: authentication failed or timed out`**、
token ファイルの md5/mtime は不変（＝ `-p` は有効 token を書き換えも活用もしない）。

### 2.3 agy 自身のログ（`~/.gemini/antigravity-cli/log/cli-*.log`）— 失敗連鎖の核心
```
token_storage.go:57 Using file-based token storage because container environment detected
printmode.go:223   Print mode: not authenticated, trying silent auth
keyring.go:59      keyringAuth: loaded token, expiry=2026-07-05 06:56:59 ... expired=false   ← 有効 token を読込
keyring.go:95      keyringAuth: timed out after 5s, skipping keyring auth                    ← ここで5秒ハング→破棄
printmode.go:229   Print mode: silent auth failed, triggering OAuth
auth_manager.go:107 Starting OAuth authentication flow
browser.go:56      consumerOAuth: starting OAuth flow
                   Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?...
                   Waiting for authentication (timeout 30s)...
browser.go:301     Failed to open browser: exec: "xdg-open": executable file not found in $PATH
printmode.go:267   Print mode: auth cancelled or interrupted
```

### 2.4 反証実験: キーリングを用意しても失敗（新規）
1. `apt-get install gnome-keyring dbus-x11 libsecret-1-0 libsecret-tools`（導入成功）。
2. `dbus-launch` で session bus 起動 → `DBUS_SESSION_BUS_ADDRESS` 設定、
   `gnome-keyring-daemon --unlock --components=secrets`（空パスワード）起動。
3. `secret-tool store/lookup` → **正常動作**（Secret Service は応答している）。
4. それでも `agy -p` は再び `keyring.go:95 keyringAuth: timed out after 5s` → OAuth →
   `Waiting for authentication (timeout 30s)` → `xdg-open` 不在 → 失敗。
→ **keyring 提供は `agy -p` 非対話認証の解決にならない**。

### 2.5 非対話代替パスの不在
- agy バイナリに `adcAuth`（Application Default Credentials）プロバイダは存在し、
  `~/.config/gcloud/application_default_credentials.json` も存在するが、**consumer ログイン
  (`auth_method=consumer`) の silent-auth はこれを使わない**（ログに adc 試行なし）。
- `-p` 用の API キー等の非対話資格投入経路も consumer フローでは使われない。

---

## 3. 解決策

### 3.1 推奨（安全・即時・機能影響なし）: `ANTIGRAVITY_DISABLED=1`
非対話 `agy -p` はこの環境で成立しないため、ドキュメント済みの可用性エスケープハッチ
`ANTIGRAVITY_DISABLED=1` を設定し、ディスパッチャが agy を即スキップして codex/claude に
フォールバックするようにする。`config/worker_roles.json` の各チェーンは既に codex/claude を
フォールバックに持つため機能は不変で、1 ロールあたり無駄な ~5–35 秒の認証試行を消せる。
（ハーネスは初回失敗後に `antigravity.auth_unhealthy.json` マーカーで以降を高速スキップする
既存機構があるため、放置しても致命ではないが、無駄な初回待ちを避けられる。）

### 3.2 agy を本当に使いたい場合（人間側の選択肢）
- **対話モードで使う**: keyring/ブラウザを完了できるデスクトップ/対話セッションで `agy`（`-p` 無し）を
  使う。ヘッドレスの `-p` では原理的に不可。
- **上流の期待**: `agy -p` が「file-based token storage 検出時に有効 file token を silent auth に
  採用し、keyring プローブを 5 秒待たずスキップする」よう改善されれば非対話でも成立する。これは
  Google 配布バイナリ側の挙動でありハーネスからは修正不可（アップストリーム要望事項）。

### 3.3 本 run で適用したこと
- 本調査レポート（原因＋反証実験＋解決）を追加。
- keyring スタック導入は**検証目的の一時的な環境変更**（Dockerfile 不変・可逆）。恒久化はしない。
- ハーネスのコア認証フロー（`run_antigravity.sh`）への挙動変更は、keyring 有無が成功を予測できない
  ことが 2.4 で判明したため、誤検知リスクを避けて**加えない**。運用解決は 3.1 に一本化する。

---

## 4. 受け入れ条件の充足
- [x] 前提を「保存・更新・読み戻し」問題として扱った（コンテナ削除ではない）。
- [x] keyring パッケージ / `DBUS_SESSION_BUS_ADDRESS` / `gnome-keyring-daemon` を実測記録（§2.1）。
- [x] 同一シェルで `agy`→`agy -p` 連続実行し成否パターンを実測（§2.2, §2.4）、参考表に接地。
- [x] `agy -p` 前後の DBus 確認（未設定→手動設定しても失敗、§2.4）。
- [x] 認証系ログ語を確認・提示（§2.3）。
- [x] 根本原因を1つに特定（silent-auth keyring 5s タイムアウト→対話 OAuth 不能、§1）。
      仮説「refresh後書き戻し失敗」は方向のみ正、機構は読み取り側タイムアウトと反証。
- [x] 解決策を提示（§3.1 `ANTIGRAVITY_DISABLED=1` 推奨、§3.2 対話利用/上流要望）。
