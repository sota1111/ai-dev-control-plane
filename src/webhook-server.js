const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { DiscordNotifier } = require('./lib/discordNotifier');
const { verifyDiscordSignature } = require('./lib/discordInteractions');
const { routeInteraction } = require('./lib/discordCommandRouter');

const _discordNotifier = process.env.DISCORD_WEBHOOK_URL
  ? new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL)
  : null;

if (_discordNotifier) {
  _discordNotifier.start();
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk, ...args) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStdoutWrite(chunk, ...args);
  };
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk, ...args) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStderrWrite(chunk, ...args);
  };
}

const runner = require('./runner');

// Distinguish parent-received signals from child process signals
process.on('SIGTERM', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGTERM at ${new Date().toISOString()} — user-initiated stop, shutting down gracefully`);
  if (_discordNotifier) _discordNotifier.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGINT at ${new Date().toISOString()} — user-initiated stop (Ctrl+C), shutting down gracefully`);
  if (_discordNotifier) _discordNotifier.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  // Log but DO NOT exit — keep server alive
  console.error(`[WEBHOOK:PARENT] uncaughtException at ${new Date().toISOString()}: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  // Log but DO NOT exit — keep server alive
  const msg = reason instanceof Error ? reason.stack : String(reason);
  console.error(`[WEBHOOK:PARENT] unhandledRejection at ${new Date().toISOString()}: ${msg}`);
});

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Error handler for JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;

function verifyLinearSignature(req) {
  if (!LINEAR_WEBHOOK_SECRET) {
    return true; // development mode: skip verification
  }
  const signature = req.headers['linear-signature'];
  if (!signature) {
    runner.log('WEBHOOK', 'No linear-signature header found');
    return false;
  }
  const expected = crypto
    .createHmac('sha256', LINEAR_WEBHOOK_SECRET)
    .update(req.rawBody || '')
    .digest('hex');
  return signature === expected;
}

if (!LINEAR_WEBHOOK_SECRET) {
  console.warn('[WEBHOOK] WARNING: LINEAR_WEBHOOK_SECRET not set. Running in development mode without signature verification.');
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/webhooks/linear', (req, res) => {
  const body = req.body;
  
  // express.json() handles parsing, but we check if it succeeded
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!verifyLinearSignature(req)) {
    runner.log('WEBHOOK', 'Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  runner.log('WEBHOOK', `Received event type=${body.type || 'unknown'} action=${body.action || 'unknown'} at ${new Date().toISOString()}`);

  if (body.type !== "Issue") {
    return res.status(200).json({ status: "ignored", reason: "not an issue event" });
  }

  const action = body.action || "";
  const issueId = body.data?.identifier || body.data?.id;
  const stateName = body.data?.state?.name || "";
  const stateType = body.data?.state?.type || "";
  const archivedAt = body.data?.archivedAt || null;

  runner.log('WEBHOOK', `Issue event: identifier=${issueId || 'unknown'} action=${action} state.name=${stateName} state.type=${stateType} labels=${(body.data?.labels || []).map(l => l.name).join(',')}`);

  if (!["create", "update"].includes(action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  const isTerminalState = ["completed", "canceled", "duplicate"].includes(stateType)
    || ["Done", "Canceled", "Cancelled", "Duplicate"].includes(stateName);

  if (isTerminalState) {
    runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=terminal state`, { issue: issueId });
    runner.removeFromQueue(issueId);
    return res.status(200).json({ status: "ignored", reason: `terminal state: ${stateName || stateType}` });
  }

  if (archivedAt) {
    runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=archived issue`, { issue: issueId });
    runner.removeFromQueue(issueId);
    return res.status(200).json({ status: "ignored", reason: "archived issue" });
  }

  // For update events: only proceed if a meaningful field changed.
  // Label-only changes (e.g. AI removing usage-limit label) are non-meaningful.
  if (action === "update") {
    const updatedFrom = body.updatedFrom;
    const meaningfulFields = ["stateId", "title", "description", "priority", "assigneeId", "dueDate", "estimate", "parentId"];
    const hasMeaningfulChange = updatedFrom && meaningfulFields.some(f => f in updatedFrom);

    if (updatedFrom && !hasMeaningfulChange) {
      runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=non-meaningful update`, { issue: issueId });
      return res.status(200).json({ status: "ignored", reason: "non-meaningful update" });
    }
  }

  // 既に処理中またはキュー内にある場合はスキップ
  if (runner.isQueued(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already queued: ${issueId}` });
  }

  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
      const cooldown = runner.getUsageLimitCooldownUntil();
      if (cooldown) {
        const cooldownRetryAt = cooldown.retryAt;
        runner.enqueue(issueId, 'webhook', cooldownRetryAt);
        runner.log('WEBHOOK', `usage limit cooldown active, queued until ${cooldownRetryAt}`, { issue: issueId });
        return;
      }

      const issuePriority = body.data?.priority ?? 0;
      const isUrgent = issuePriority === 1;

      if (!isUrgent && runner.isLocked()) {
        // Non-Urgent while locked: enqueue for later drain
        runner.enqueue(issueId, 'webhook');
        runner.log('WEBHOOK', `non-Urgent issue (priority=${issuePriority}) queued while locked, queue size=${runner.loadQueue().length}`, { issue: issueId });
        return;
      }

      // Linear 全体チェック: Todo/In Progress Issue がなければ起動しない
      let hasPending = true;
      try {
        hasPending = await runner.hasPendingIssues();
      } catch (e) {
        runner.log('WEBHOOK', `hasPendingIssues error (fail-open): ${e.message}`, { issue: issueId });
      }
      if (!hasPending) {
        runner.log('WEBHOOK', 'no pending issues in Linear, skipping run', { issue: issueId });
        return;
      }

      // キューに追加してすぐ取り出す
      runner.enqueue(issueId, 'webhook');
      const item = runner.dequeue();
      if (!item) return;
      const queuedIssueId = item.issueId;

      // ロック取得
      const locked = runner.acquireLock({ trigger: 'webhook', issue: queuedIssueId });
      if (!locked) {
        runner.log('WEBHOOK', 'SKIPPED_LOCKED — re-enqueuing', { issue: queuedIssueId });
        runner.enqueue(queuedIssueId, 'webhook');
        return;
      }

      try {
        await runner.runItem(item);
      } finally {
        runner.releaseLock();
        // After main task: drain remaining queue
        const queueSize = runner.loadQueue().length;
        if (queueSize > 0) {
          runner.log('QUEUE', `main task done, draining ${queueSize} remaining item(s)`);
          await runner.drainQueue();
        } else {
          runner.log('QUEUE', 'main task done, queue empty — no drain needed');
        }
      }
    } catch (err) {
      runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
    }
  });
});

app.post('/webhooks/discord', (req, res) => {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    runner.log('DISCORD', 'DISCORD_PUBLIC_KEY not configured — rejecting request');
    return res.status(401).json({ error: 'Discord public key not configured' });
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = req.rawBody;

  if (!signature || !timestamp || !rawBody) {
    runner.log('DISCORD', 'Missing signature headers');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  if (!verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
    runner.log('DISCORD', 'Signature verification failed');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  const interaction = req.body;

  routeInteraction(interaction)
    .then(({ status, body }) => {
      res.status(status).json(body);
    })
    .catch((err) => {
      runner.log('DISCORD', `Error handling interaction: ${err.message}`);
      res.status(200).json({
        type: 4,
        data: { content: 'エラーが発生しました。しばらくしてから再試行してください。', flags: 64 },
      });
    });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[WEBHOOK] Server listening on port ${PORT}`);
  });
}

module.exports = app;
