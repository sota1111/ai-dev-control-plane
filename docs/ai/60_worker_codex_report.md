Completed SOT-572.

Changed:
- `README.md`: added `### 初期起動コマンド詳細` between `### 起動コマンド` and `### セッション操作`.
- `docs/ai/60_worker_codex_report.md`: wrote the requested worker report.

Verification:
- `grep -n "初期起動コマンド詳細" README.md` passed.
- `grep -n "tmuxinator start ai-dev" README.md` passed.
- `npm run lint` passed.
- `npm test` passed: 9 suites, 108 tests.

Unrelated existing working tree items were left untouched: `.claude/settings.local.json`, `.tmp_ai-dev-test4/`.
EADME.md`

```text
243:| 通常開発（Webhook + ngrok + 各 CLI） | `tmuxinator start ai-dev` |
248:#### `tmuxinator start ai-dev`（通常開発）
```

`npm run lint`

```text
> ai-dev-control-plane@1.0.0 lint
> node --check src/runner.js && node --check src/runner-cli.js && node --check src/webhook-server.js && node --check src/lib/usageLimitParser.js && node --check src/lib/discordNotifier.js && node --check src/lib/issueClassifier.js && node --check src/lib/discordInteractions.js && node --check src/lib/discordCommandRouter.js && node --check src/lib/discordCommandHandlers.js && node --check src/lib/discordPauseState.js && node --check src/lib/discordAskHandler.js && node --check src/lib/discordIntentClassifier.js && node --check src/lib/discordIntentHandlers.js && node --check scripts/register_discord_commands.js && node --check scripts/auth/firebase-user.js && node --check scripts/auth/cloudrun-sync.js && node --check scripts/auth/auth-setup.js
```

Result: exit 0

`npm test`

```text
> ai-dev-control-plane@1.0.0 test
> jest --forceExit

Test Suites: 9 passed, 9 total
Tests:       108 passed, 108 total
Snapshots:   0 total
Time:        1.224 s, estimated 2 s
Ran all test suites.
```

Result: exit 0

## Acceptance Criteria
- [x] `### 初期起動コマンド詳細` subsection added
- [x] `ai-dev` session window table is present
- [x] `ai-auth` session window table is present
- [x] `npm run lint` passes
- [x] `npm test` passes

## Risks
None. Documentation-only change. Existing unrelated working tree changes were left untouched.

## Next Action
READY_FOR_REVIEW
