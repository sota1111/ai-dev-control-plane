# tmuxinator セットアップガイド

## tmux と tmuxinator の違い

- **tmux**: 起動中のプロセスを維持するターミナルマルチプレクサ。ターミナルを閉じてもセッションが残る。
- **tmuxinator**: tmux セッションの構成（window・pane 配置）を YAML ファイルで定義し、再現するツール。認証情報の保存機能はない。

## インストール

```bash
# tmux（通常はプリインストール済み）
which tmux || sudo apt-get install -y tmux

# tmuxinator
gem install tmuxinator

# ngrok（未インストールの場合）
# https://ngrok.com/download を参照
```

## 設定ファイルの場所

このリポジトリに含まれる tmuxinator 設定ファイル:

- `.config/tmuxinator/ai-auth.yml` — 初回認証・再認証用セッション
- `.config/tmuxinator/ai-dev.yml` — 通常開発・常駐起動用セッション

tmuxinator はデフォルトで `~/.config/tmuxinator/` から設定を読み込みます。
このリポジトリの設定を使う場合は、シンボリックリンクを張るか、`tmuxinator` コマンドに `-p` オプションでパスを指定してください。

```bash
# シンボリックリンクを張る場合
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml
ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml ~/.config/tmuxinator/ai-dev.yml

# または直接パス指定で起動
tmuxinator start -p .config/tmuxinator/ai-auth.yml
tmuxinator start -p .config/tmuxinator/ai-dev.yml
```

## 初回認証手順

Dev Container 起動後、まず認証用セッションを起動します:

```bash
# シンボリックリンク設定済みの場合
tmuxinator start ai-auth

# 直接パス指定の場合
tmuxinator start -p .config/tmuxinator/ai-auth.yml
```

各 window で以下を順番に実行してください:

1. **claude**: `claude` が起動 → `/mcp` を実行 → Linear を選択
2. **gemini**: `gemini` で認証
3. **codex**: `codex` で認証
4. **codex-mcp**: `codex mcp login linear` で Linear 認証
5. **gh**: `GH_BROWSER=echo gh auth login --hostname github.com --git-protocol https --web` で GitHub CLI 認証
6. **azure**: `az login --use-device-code` で Azure CLI 認証（ブラウザでコード入力）
7. **gcloud**: `gcloud auth login --no-launch-browser` で認証
8. **gcloud-adc**: `gcloud auth application-default login --no-launch-browser` で ADC 認証（必要な場合のみ）

### gcloud ADC について

`gcloud auth application-default login --no-launch-browser` は **毎回必要ではありません**。

以下のコマンドで ADC が有効か確認できます:

```bash
ls -l ~/.config/gcloud/application_default_credentials.json
gcloud auth application-default print-access-token > /dev/null && echo "ADC OK"
```

ADC が有効な場合は再実行不要です。以下の場合のみ再実行してください:
- Dev Container を rebuild した場合（認証情報をバインドマウントしていない場合）
- ADC ファイルが削除・期限切れになった場合

## 通常開発時の起動

```bash
# シンボリックリンク設定済みの場合
tmuxinator start ai-dev

# 直接パス指定の場合
tmuxinator start -p .config/tmuxinator/ai-dev.yml
```

起動される window:
- **webhook**: Webhook サーバー（`npm run dev:webhook`）と ngrok（`ngrok http 3000`）が別 pane で起動
- **claude**: Claude CLI
- **codex**: Codex CLI
- **gemini**: Gemini CLI
- **status**: git status・プロセス確認・ログ確認

### ngrok 公開URL の確認

ngrok 起動後、webhook pane の ngrok ログで `Forwarding` 行を確認:

```
Forwarding  https://xxxx-xx-xx-xxx-xx.ngrok-free.app -> http://localhost:3000
```

または別ターミナルで:

```bash
curl -s http://localhost:4040/api/tunnels | python3 -c "import json,sys; t=json.load(sys.stdin)['tunnels'][0]; print(t['public_url'])"
```

**注意**: ngrok の公開 URL を Linear の Webhook URL に設定する作業は**ユーザー操作**が必要です。
Linear > Settings > API > Webhooks > 対象 Webhook の URL を更新してください。

## セッション操作

| 操作 | コマンド |
|------|---------|
| セッションから抜ける (detach) | `Ctrl+b d` |
| セッションに戻る (attach) | `tmux attach -t ai-dev` |
| セッション一覧 | `tmux ls` |
| セッション終了 | `tmux kill-session -t ai-dev` |
| 認証セッション終了 | `tmux kill-session -t ai-auth` |

## Dev Container Rebuild 後の認証情報永続化

Dev Container を rebuild すると、認証情報が消える場合があります。以下のディレクトリを
`devcontainer.json` の `mounts` でバインドマウントすることで認証情報を維持できます。

```json
"mounts": [
  "source=${localEnv:HOME}/.claude,target=/home/vscode/.claude,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.codex,target=/home/vscode/.codex,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.config/gemini,target=/home/vscode/.config/gemini,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.config/gh,target=/home/vscode/.config/gh,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.azure,target=/home/vscode/.azure,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.config/gcloud,target=/home/vscode/.config/gcloud,type=bind,consistency=cached",
  "source=${localEnv:HOME}/.config/ngrok,target=/home/vscode/.config/ngrok,type=bind,consistency=cached"
]
```

**コンテナユーザーの確認**:

```bash
whoami      # vscode または ubuntu
echo $HOME  # /home/vscode または /home/ubuntu
```

コンテナユーザーが `ubuntu` の場合は、上記の `target` パスを `/home/ubuntu/...` に変更してください。

**認証ディレクトリの存在確認**:

```bash
# 存在するディレクトリのみ確認
for d in ~/.claude ~/.codex ~/.config/gemini ~/.config/gh ~/.azure ~/.config/gcloud ~/.config/ngrok; do
  [ -d "$d" ] && echo "EXISTS: $d" || echo "NOT FOUND: $d"
done
```

存在しないディレクトリはバインドマウントしなくても構いません。

## 注意事項

- tmuxinator は認証情報を保存しません。認証維持には各 CLI の認証ディレクトリの永続化が必要です。
- ngrok の無料プランでは URL が毎回変わります。再起動時に Linear の Webhook URL を更新してください。
- 既存の Webhook サーバー・スケジューラー・Linear 処理の動作には影響しません。
