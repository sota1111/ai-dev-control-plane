# tmux / tmuxinator

tmuxinator を使うと、Webhook サーバー・ngrok・Claude / Codex / Antigravity CLI・ステータス確認用 pane を**一括起動**できる。

関連: ステップごとの詳細セットアップは [`tmuxinator-setup.md`](./tmuxinator-setup.md) を参照。

## インストール

```bash
# tmux（通常はプリインストール済み）
which tmux || sudo apt-get install -y tmux

# tmuxinator
gem install tmuxinator
```

## 設定ファイルのリンク

```bash
# シンボリックリンクを張る
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml  ~/.config/tmuxinator/ai-dev.yml

# tmux 本体の設定（マウス操作有効化）— DevContainer では Dockerfile が自動でリンク済み
ln -s /workspaces/ai-dev-control-plane/.config/tmux/tmux.conf ~/.tmux.conf
```

## マウス操作

`.config/tmux/tmux.conf` で `set -g mouse on` を有効化しているため、**マウスクリックで
window / pane を選択**できる（ステータスバーの window 名クリックで切り替え、pane クリックで
フォーカス移動、境界ドラッグでサイズ変更、ホイールでスクロール）。DevContainer では
`~/.tmux.conf` へ自動リンクされ、tmux 起動時に読み込まれる。起動中のセッションに反映するには
`tmux source-file ~/.tmux.conf` を実行する。

## 起動コマンド

| 用途                                 | コマンド                                             |
| ------------------------------------ | ---------------------------------------------------- |
| 初回認証（全 CLI を順番に認証）      | `tmuxinator start ai-auth`                           |
| 通常開発（Webhook + ngrok + 各 CLI） | `tmuxinator start ai-dev`                            |
| パス直接指定で起動（リンク不要）     | `tmuxinator start -p .config/tmuxinator/ai-auth.yml` |

## 初期起動コマンド詳細

### `tmuxinator start ai-dev`（通常開発）

| ウィンドウ | pane | 実行コマンド                                             |
| ---------- | ---- | -------------------------------------------------------- |
| `webhook`  | —    | `npm run start:webhook`（Webhook サーバー起動）          |
| `ngrok`    | —    | `ngrok http 3000`（ngrok トンネル起動）                  |
| `claude`   | —    | `claude`                                                 |
| `codex`    | —    | `codex`                                                  |
| `antigravity` | —  | `agy`                                                    |
| `status`   | 上   | `git status && git log --oneline -5`                     |
| `status`   | 中   | `ps aux \| grep -E "node\|ngrok\|claude\|codex\|agy"`    |
| `status`   | 下   | `ls -la logs/`                                           |

### `tmuxinator start ai-auth`（初回認証）

| ウィンドウ  | 実行コマンド                                                  |
| ----------- | ------------------------------------------------------------- |
| `claude`    | `claude`（起動後 `/mcp` → Linear を選択して MCP 設定）        |
| `antigravity` | `agy`                                                      |
| `antigravity-mcp` | `~/.gemini/config/mcp_config.json` に linear MCP を用意し `npx -y mcp-remote https://mcp.linear.app/mcp` で agy の Linear MCP を認証（再認証は `rm -rf ~/.mcp-auth`） |
| `codex`     | `codex`                                                       |
| `codex-mcp` | `codex mcp login linear`                                      |
| `gh`        | `GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web` |
| `azure`     | `az login --use-device-code`                                  |
| `gcloud`     | `gcloud auth login --no-launch-browser` |
| `gcloud-adc` | `gcloud auth application-default login --no-launch-browser` |

## セッション操作

| 操作                          | コマンド                      |
| ----------------------------- | ----------------------------- |
| セッションから抜ける (detach) | `Ctrl+b d`                    |
| セッションに戻る (attach)     | `tmux attach -t ai-dev`       |
| セッション一覧                | `tmux ls`                     |
| セッション終了                | `tmux kill-session -t ai-dev` |
