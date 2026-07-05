# SOT-1536 — Antigravity CLI 認証永続化問題 調査報告

対象: ハーネス自身（`/workspaces/ai-dev-control-plane`）の Antigravity ワーカー経路
種別: DEBUG / INVESTIGATION（web検索許可・AIがAIを呼ぶ許可）
実測日: 2026-07-05 / agy version 1.0.16
系譜: [SOT-1534](SOT-1534-agy-auth-error.md) / [SOT-1535](SOT-1535-agy-auth-error.md) の続き

---

## 結論（先に）

**web報告どおり原因の方向性は「headless Linux + system keyring」で正しいが、web で挙げられた対策
（`dbus-x11` / `libsecret-1-0` / `gnome-keyring` 導入 + Secret Service 正常化）は本 Dev Container では
効かない。** 本環境で Secret Service を完全に機能させた状態でも `agy -p` は同一の
`keyring.go:95: timed out after 5s` を再現して失敗する。真因は Secret Service の有無/速度ではなく、
**`agy` print-mode の silent-auth が固定 5s の keyringAuth タイムアウトで、既に読み込み済みの有効な
file token（`expired=false`）を破棄して OAuth に落ちる upstream 実装欠陥**。

→ 恒久回避として `.env` に `ANTIGRAVITY_DISABLED=1` を設定（codex/claude へ即フォールバック、機能不変、
毎回 ~40s の無駄なプローブを回避）。真の解決は upstream 対応（または agy を対話セッション常駐で使う）。

---

## 1. 環境実測（web報告との照合）

web報告は「headless Linux/WSL に OS keyring が無いから token を保存できない」を主因候補にしていた。
本 Dev Container はそれと状況が異なり、**keyring インフラは既に揃っている**：

| 項目 | 実測 |
| -- | -- |
| keyring パッケージ | `gnome-keyring 46.1` / `libsecret-1-0 0.21.4` / `libsecret-tools` / `dbus-x11 1.14.10` すべて導入済 |
| デーモン | `dbus-daemon --session` と `gnome-keyring-daemon --unlock --components=secrets` が複数常駐 |
| `DBUS_SESSION_BUS_ADDRESS` | **空**（agy を起動するシェルに未エクスポート） |
| file token | `~/.gemini/antigravity-cli/antigravity-oauth-token`（498B）、access=`ya29...`/refresh 有り/`expiry=2026-07-05T07:25:40Z`（**未来・未失効**）/`auth_method=consumer` |

→ web の「keyring が無い」ケースとは違い、**パッケージ・デーモンはあるが session bus address が
未エクスポート**というのが本環境の初期状態。ただし後述のとおり、これを直しても解決しない。

## 2. 素の `agy -p`（cold start）の失敗ログ

```
printmode.go:223 Print mode: not authenticated, trying silent auth
keyring.go:59    keyringAuth: loaded token, expiry=2026-07-05 07:25:40 ... expired=false   ← 有効 token を読込済
keyring.go:95    keyringAuth: timed out after 5s, skipping keyring auth                     ← 固定 5s で破棄
printmode.go:229 Print mode: silent auth failed, triggering OAuth
printmode.go:277 Print mode: auth timed out                                                 ← OAuth 30s も失敗
Error: authentication timed out.
```

`keyring.go:59` で **有効・未失効の file token を読み込めている**のに、`keyring.go:95` の keyringAuth が
5s でタイムアウトすると silent-auth 全体を失敗扱いにして OAuth に遷移し、非対話では OAuth も完了できず失敗。

## 3. web報告の対策を実試行（決定的実験）

「Secret Service を正常化すれば直る」という web 仮説を本環境で直接検証した。

### 3-1. 素朴な keyring 起動 → Secret Service がハング
`dbus-launch` で session bus を作り `gnome-keyring-daemon --unlock` しただけでは、`secret-tool store` が
**応答せずハング**（要 kill）。web の「Secret Service の応答が1秒超で未ログイン扱い」報告と一致する挙動。

### 3-2. login keyring を明示作成 → collection がロックで書けない
`gnome-keyring-daemon --start --unlock --components=secrets,pkcs11,ssh` で起動しても
`secret-tool: Cannot create an item in a locked collection`（非対話でアンロック不能）。

### 3-3. 空パスワードの login keyring → Secret Service が完全動作
```
rm -rf ~/.local/share/keyrings; export $(dbus-launch)
eval "$(printf '\0' | gnome-keyring-daemon --unlock --components=secrets)"
secret-tool store ...  → exit 0 / secret-tool lookup ... → 値が返る（login.keyring / user.keystore 生成）
```
→ **本環境でも Secret Service を完全に機能させられることを実証**（store/lookup が高速に成功）。

### 3-4. その完全動作 keyring 環境で `agy -p` を実行 → それでも失敗
同一シェル（DBUS エクスポート済 + secret-tool 動作確認済）で `agy -p` を cold start：
```
secret-service=OK
...
Error: authentication failed or timed out   (real 40.4s, exit 1)
```
ログ（同 run, 06:53）：
```
06:53:19 keyring.go:59 keyringAuth: loaded token, expiry=2026-07-05 07:25:40 ... expired=false
06:53:24 keyring.go:95 keyringAuth: timed out after 5s, skipping keyring auth   ← 5.001s、Secret Service 正常でも同一
06:53:24 printmode.go:229 silent auth failed, triggering OAuth
06:53:54 printmode.go:277 Print mode: auth timed out
```

**→ Secret Service が完全に動作していても keyringAuth は依然ちょうど 5s でタイムアウトする。**
つまりこの 5s タイムアウトは Secret Service の応答速度に連動しておらず、固定の内部タイムアウトである。
web で提案された keyring 導入策は本環境では解決策にならない。

## 4. バイナリ静的解析（裏付け）

`agy` バイナリ内シンボル：
- `keyringAuth: timed out after 5s, skipping keyring auth` / `keyringAuth: context cancelled, skipping keyring auth`
  … keyringAuth は固定タイムアウトで「skip」する分岐を持つ。
- `auth.(*cliFileTokenStorage).LoadToken` … **file token を読む実装は存在する**（＝`keyring.go:59` の読込元）。
- keyring を無効化する env（`*_DISABLE_KEYRING` / `*_NO_KEYRING` / `KEYRING_TIMEOUT` 等）は**存在しない**。
  ユーザ側から 5s タイムアウトを延ばす/keyring をスキップさせる公式ノブは無い。

→ 実装は「file token を LoadToken で読める」のに、print-mode silent-auth は keyringAuth の成功を必須にし、
その 5s タイムアウト時に**読込済みの有効 file token へフォールバックせず** OAuth に落とす。これが欠陥。

## 5. なぜ agy 固有か（他 CLI では起きない）

Claude/codex/gemini CLI は資格情報をファイル（またはトークンストア）から直接使い、OS keyring/Secret
Service の同期プローブを認証の必須経路に置いていない。agy だけが print-mode silent-auth を keyringAuth に
固定依存させ、そのタイムアウトで有効 file token を捨てるため、headless/Dev Container で恒常的に失敗する。

## 6. 恒久回避（本コミットで適用）

`.env` に以下を追加：
```
ANTIGRAVITY_DISABLED=1
```
- `scripts/ai/run_antigravity.sh:110` がこれを検出して即 exit 75 → dispatcher が codex/claude へハンドオフ。
- 毎回 ~40s の無駄な keyring/OAuth プローブを回避。**実作業は codex/claude が担い機能は不変**。
- upstream 修正、または agy を対話セッション常駐で使えるようになった時点で、この行を削除/コメントアウトして
  再有効化する（config/worker_roles.json の implementation チェーンに agy は残してある）。

なお、ハーネスは元々 `docs/ai/auto_logs/antigravity.auth_unhealthy.json` マーカー + 時間制限クールダウンで
この失敗を自動フォールバック処理しており（run_antigravity.sh:141-149）、`ANTIGRAVITY_DISABLED=1` は
その無駄な ~40s プローブ自体を先んじて省く明示スイッチ。

## 7. 真の解決（upstream 依存・本ハーネス外）

- upstream（google-antigravity/antigravity-cli, GitHub Issue #18 等 open）が、print-mode silent-auth で
  keyringAuth タイムアウト時に**読込済みの有効 file token へフォールバック**するよう修正すること。
- もしくは keyringAuth の 5s タイムアウトを延長/無効化できる env ノブを提供すること。
- 当面 agy を実運用したい場合は、対話 OAuth を完了したセッションを常駐させ `-p` を同一プロセス文脈で叩く
  （非対話ハーネスの単発 cold-start では成立しない）。

---

## 実測サマリ（再現手順）

```bash
# 失敗（素の cold start）: keyring.go:95 5s TO → OAuth → 40s fail
agy -p "Reply with exactly: OK"   # Error: authentication failed or timed out (exit 1)

# Secret Service を完全動作させても失敗（決定的実験）
rm -rf ~/.local/share/keyrings; export $(dbus-launch)
eval "$(printf '\0' | gnome-keyring-daemon --unlock --components=secrets)"
echo -n s | secret-tool store --label=t svc t && secret-tool lookup svc t   # OK（Secret Service 正常）
agy -p "Reply with exactly: OK"   # それでも keyring.go:95 5s TO → 40s fail (exit 1)
```
