# Worker Report

## Summary
`src/runner.js` contains both requested usage-limit notification functions. `postUsageLimitComment(issueId, resetEpoch)` resolves the Linear issue UUID, formats the reset epoch as `YYYY-MM-DD HH:mm JST`, and posts `usage-limit: Next auto run: <time>` using the Linear GraphQL `commentCreate` mutation. `notifyUsageLimitToAllActiveIssues(epochSeconds)` queries up to 50 active issues in `unstarted` or `started` states, then calls `postUsageLimitComment()` and `addUsageLimitLabel()` for each issue.

No existing comment lookup or deduplication logic was found in the usage-limit comment path. `src/__tests__/runner.test.js` exists, but it currently covers lock, cooldown, and queue behavior only; it does not cover `postUsageLimitComment()` or `notifyUsageLimitToAllActiveIssues()`.

Existing tests pass: 9 suites, 108 tests.

## Key Findings
- postUsageLimitComment location: `src/runner.js:176`
- notifyUsageLimitToAllActiveIssues location: `src/runner.js:497`
- Comment API used: Linear GraphQL mutation `commentCreate(input: { issueId: $issueId, body: $body })` at `src/runner.js:187-193`
- Existing comment dedup logic: no; `postUsageLimitComment()` posts directly after resolving the issue UUID and does not query existing comments before calling `commentCreate`
- Test framework: Jest (`npm test` runs `jest --forceExit`)
- Tests passing: yes; `npm test 2>&1 | tail -30` reported 9 passed suites and 108 passed tests

## Changed Files
(none - this is a task check only)

## Commands Run
`grep -n "postUsageLimitComment\|notifyUsageLimitToAllActiveIssues\|usage-limit\|Next auto run\|commentCreate\|comment" /workspaces/ai-dev-control-plane/src/runner.js | head -80`

Result:
```text
11:const USAGE_LIMIT_FILE = path.join(LOG_DIR, 'runner.usage-limit.json');
176:async function postUsageLimitComment(issueId, resetEpoch) {
189:        commentCreate(input: { issueId: $issueId, body: $body }) {
193:    `, { issueId: uuid, body: `usage-limit: Next auto run: ${jstTime}` });
195:    log('ERROR', `postUsageLimitComment failed: ${err.message}`, { issue: issueId });
206:    const labelsData = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
216:      `, { name: 'usage-limit', teamId, color: '#FF6B6B' });
240:    const labelsData = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
497:async function notifyUsageLimitToAllActiveIssues(epochSeconds) {
504:      await postUsageLimitComment(issue.id, epochSeconds).catch(() => {});
507:    log('RUNNER', `notifyUsageLimitToAllActiveIssues done for ${issues.length} issue(s)`);
509:    log('ERROR', `notifyUsageLimitToAllActiveIssues failed: ${err.message}`);
516:      'query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }'
520:      log('RUNNER', 'removeUsageLimitLabelFromAllIssues: no usage-limit label found');
685:      await notifyUsageLimitToAllActiveIssues(resetEpoch).catch(() => {});
774:  postUsageLimitComment,
780:  notifyUsageLimitToAllActiveIssues,
```

`ls /workspaces/ai-dev-control-plane/src/`

Result:
```text
__tests__
lib
runner-cli.js
runner.js
webhook-server.js
```

`ls /workspaces/ai-dev-control-plane/test/ 2>/dev/null || ls /workspaces/ai-dev-control-plane/__tests__/ 2>/dev/null || ls /workspaces/ai-dev-control-plane/tests/ 2>/dev/null || echo "no test dir found"`

Result:
```text
no test dir found
```

`ls /workspaces/ai-dev-control-plane/src/__tests__`

Result:
```text
discordAskHandler.test.js
discordCommandHandlers.test.js
discordIntentClassifier.test.js
discordInteractions.test.js
discordNotifierIntegration.test.js
issueClassifier.test.js
runner.test.js
usageLimitParser.test.js
webhookServer.test.js
```

`cat /workspaces/ai-dev-control-plane/package.json`

Result:
```json
{
  "name": "ai-dev-control-plane",
  "version": "1.0.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "lint": "node --check src/runner.js && node --check src/runner-cli.js && node --check src/webhook-server.js && node --check src/lib/usageLimitParser.js && node --check src/lib/discordNotifier.js && node --check src/lib/issueClassifier.js && node --check src/lib/discordInteractions.js && node --check src/lib/discordCommandRouter.js && node --check src/lib/discordCommandHandlers.js && node --check src/lib/discordPauseState.js && node --check src/lib/discordAskHandler.js && node --check src/lib/discordIntentClassifier.js && node --check src/lib/discordIntentHandlers.js && node --check scripts/register_discord_commands.js && node --check scripts/auth/firebase-user.js && node --check scripts/auth/cloudrun-sync.js && node --check scripts/auth/auth-setup.js",
    "auth:setup": "node scripts/auth/auth-setup.js",
    "start:webhook": "node src/webhook-server.js",
    "start:ngrok": "bash -c \"$NGROK_COMMAND\"",
    "dev:webhook": "concurrently --kill-others-on-fail=false \"npm run start:webhook\" \"npm run start:ngrok\"",
    "test": "jest --forceExit"
  },
  "dependencies": {
    "dotenv": "^16.3.1",
    "express": "^4.18.2",
    "firebase": "^12.14.0",
    "firebase-admin": "^12.0.0"
  },
  "devDependencies": {
    "concurrently": "^8.2.2",
    "jest": "^29.0.0",
    "supertest": "^6.0.0"
  },
  "jest": {
    "testEnvironment": "node"
  }
}
```

`nl -ba /workspaces/ai-dev-control-plane/src/runner.js | sed -n '150,225p'`

Result: confirmed `postUsageLimitComment()` at lines 176-197. It queries `issue(id: $id)`, formats JST time, and calls `commentCreate` with body `usage-limit: Next auto run: ${jstTime}`.

`nl -ba /workspaces/ai-dev-control-plane/src/runner.js | sed -n '480,515p'`

Result: confirmed `notifyUsageLimitToAllActiveIssues()` at lines 497-511. It queries active issues and calls `postUsageLimitComment()` and `addUsageLimitLabel()` for each.

`nl -ba /workspaces/ai-dev-control-plane/src/runner.js | sed -n '660,695p'`

Result: confirmed usage-limit detection flow in `runOne()`: when `parseUsageLimitResetEpoch(output)` returns a value, it calls `notifyUsageLimitToAllActiveIssues(resetEpoch)`, sets cooldown, and enqueues retry.

`grep -n "postUsageLimitComment\|notifyUsageLimitToAllActiveIssues\|usage-limit\|Next auto run\|commentCreate\|comments" /workspaces/ai-dev-control-plane/src/__tests__/runner.test.js | head -120`

Result:
```text
93:        expect.stringContaining('runner.usage-limit.json.tmp'),
101:        expect.stringContaining('runner.usage-limit.json.tmp'),
```

`grep -n "comments\|commentCreate\|postUsageLimit" /workspaces/ai-dev-control-plane/src/runner.js`

Result:
```text
176:async function postUsageLimitComment(issueId, resetEpoch) {
189:        commentCreate(input: { issueId: $issueId, body: $body }) {
195:    log('ERROR', `postUsageLimitComment failed: ${err.message}`, { issue: issueId });
504:      await postUsageLimitComment(issue.id, epochSeconds).catch(() => {});
```

`cd /workspaces/ai-dev-control-plane && npm test 2>&1 | tail -30`

Result:
```text
PASS src/__tests__/discordAskHandler.test.js
PASS src/__tests__/usageLimitParser.test.js
PASS src/__tests__/runner.test.js
PASS src/__tests__/discordIntentClassifier.test.js
PASS src/__tests__/discordCommandHandlers.test.js
PASS src/__tests__/discordNotifierIntegration.test.js
PASS src/__tests__/webhookServer.test.js

Test Suites: 9 passed, 9 total
Tests:       108 passed, 108 total
Snapshots:   0 total
Time:        1.256 s, estimated 2 s
Ran all test suites.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
```

## Acceptance Criteria
- [x] postUsageLimitComment() identified
- [x] notifyUsageLimitToAllActiveIssues() identified
- [x] Comment API call location identified
- [x] Existing tests pass

## Risks
No blocker for the task check. The implementation currently has no comment deduplication before `commentCreate`, so repeated handling of the same retry timestamp can post duplicate `usage-limit: Next auto run` comments. Existing runner tests do not exercise this comment posting path.

## Next Action
READY_FOR_REVIEW
