Implemented SOT-572.

Changed:
- `README.md`: added TOC entry and new `## tmux / tmuxinator` section.
- `docs/ai/60_worker_codex_report.md`: wrote the requested worker report.

Verification:
- `grep -n "tmux" README.md` passed.
- `grep -n "## tmux" README.md` passed.
- `npm run lint` passed.
- `npm test` passed: 9 suites, 108 tests.
or を使うと、Webhook サーバー・ngrok・Claude / Codex / Gemini CLI・ステータス確認用 pane を**一括起動**できる。
218:詳細は [`docs/tmuxinator-setup.md`](./docs/tmuxinator-setup.md) を参照。
223:# tmux（通常はプリインストール済み）
224:which tmux || sudo apt-get install -y tmux
226:# tmuxinator
227:gem install tmuxinator
234:ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-auth.yml ~/.config/tmuxinator/ai-auth.yml
235:ln -s /workspaces/ai-dev-control-plane/.config/tmuxinator/ai-dev.yml  ~/.config/tmuxinator/ai-dev.yml
242:| 初回認証（全 CLI を順番に認証） | `tmuxinator start ai-auth` |
243:| 通常開発（Webhook + ngrok + 各 CLI） | `tmuxinator start ai-dev` |
244:| パス直接指定で起動（リンク不要） | `tmuxinator start -p .config/tmuxinator/ai-auth.yml` |
251:| セッションに戻る (attach) | `tmux attach -t ai-dev` |
252:| セッション一覧 | `tmux ls` |
253:| セッション終了 | `tmux kill-session -t ai-dev` |

$ grep -n "## tmux" README.md
214:## tmux / tmuxinator

$ npm run lint
> ai-dev-control-plane@1.0.0 lint
> node --check src/runner.js && node --check src/runner-cli.js && node --check src/webhook-server.js && node --check src/lib/usageLimitParser.js && node --check src/lib/discordNotifier.js && node --check src/lib/issueClassifier.js && node --check src/lib/discordInteractions.js && node --check src/lib/discordCommandRouter.js && node --check src/lib/discordCommandHandlers.js && node --check src/lib/discordPauseState.js && node --check src/lib/discordAskHandler.js && node --check src/lib/discordIntentClassifier.js && node --check src/lib/discordIntentHandlers.js && node --check scripts/register_discord_commands.js && node --check scripts/auth/firebase-user.js && node --check scripts/auth/cloudrun-sync.js && node --check scripts/auth/auth-setup.js

$ npm test
> ai-dev-control-plane@1.0.0 test
> jest --forceExit

PASS src/__tests__/discordInteractions.test.js
PASS src/__tests__/issueClassifier.test.js
PASS src/__tests__/discordIntentClassifier.test.js
PASS src/__tests__/discordAskHandler.test.js
PASS src/__tests__/usageLimitParser.test.js
PASS src/__tests__/discordCommandHandlers.test.js
PASS src/__tests__/runner.test.js
PASS src/__tests__/discordNotifierIntegration.test.js
PASS src/__tests__/webhookServer.test.js

Test Suites: 9 passed, 9 total
Tests:       108 passed, 108 total
Snapshots:   0 total
```

## Acceptance Criteria
- [x] TOC entry `- [tmux / tmuxinator](#tmux--tmuxinator)` added after クイックスタート
- [x] `## tmux / tmuxinator` section added with install, symlink, and startup commands
- [x] `npm run lint` passes
- [x] `npm test` passes

## Risks
No known risks. The README change is documentation-only.

## Next Action
READY_FOR_REVIEW
