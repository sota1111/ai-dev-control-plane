const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { DiscordNotifier } = require('./lib/discordNotifier');

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

const { parseUsageLimitResetEpoch } = require('./lib/usageLimitParser');
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

function triggerRun(issueId) {
  // SECURITY: Pass issueId only via environment variable, never as shell argument
  const env = { ...process.env, WEBHOOK_ISSUE_ID: issueId };
  const projectRoot = path.join(__dirname, '..');
  const startedAt = new Date().toISOString();

  // detached: true puts child in its own process group (POSIX).
  // Signals sent to the webhook server's process group do NOT propagate to the child,
  // and signals sent to the child's process group do NOT propagate to this server.
  const child = spawn('bash', ['scripts/ai/run_auto.sh'], {
    env,
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  runner.log('WEBHOOK', `Spawned run_auto.sh for issueId=${issueId} pid=${child.pid} startedAt=${startedAt}`, { issue: issueId });

  let output = '';

  child.stdout.on('data', (data) => {
    const str = data.toString();
    output += str;
    runner.log('RUN', str.trim(), { issue: issueId, trigger: 'webhook' });
    process.stdout.write(`[RUN:${issueId}] ${str}`);
  });
  child.stderr.on('data', (data) => {
    const str = data.toString();
    output += str;
    runner.log('RUN', `stderr: ${str.trim()}`, { issue: issueId, trigger: 'webhook' });
    process.stderr.write(`[RUN:${issueId}] ${str}`);
  });

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      const endedAt = new Date().toISOString();
      if (signal) {
        // Child received a signal (e.g. SIGTERM from external kill).
        // This is the CHILD's signal — the parent webhook server is still running.
        runner.log('WEBHOOK', `run_auto.sh for issueId=${issueId} terminated by signal=${signal} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      } else {
        runner.log('WEBHOOK', `run_auto.sh for issueId=${issueId} exited code=${code} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      }
      resolve({ code: code ?? (signal ? 143 : 1), output });
    });
    child.on('error', (err) => {
      const endedAt = new Date().toISOString();
      runner.log('WEBHOOK', `Failed to spawn run_auto.sh for issueId=${issueId} error=${err.message} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      resolve({ code: 1, output: err.message });
    });
  });
}

async function runItem(item) {
  const { issueId } = item;
  runner.log('RUN', 'start', { trigger: item.trigger || 'queue', issue: issueId });
  const { code, output } = await triggerRun(issueId);

  if (code === 0) {
    runner.log('RUN', 'completed successfully', { trigger: item.trigger || 'queue', issue: issueId });
    await runner.removeUsageLimitLabel(issueId).catch(() => {});
  } else if (code === runner.SKIPPED_LOCKED) {
    runner.log('WEBHOOK', 'SKIPPED_LOCKED received from run_auto.sh — re-enqueuing', { issue: issueId });
    runner.enqueue(issueId, item.trigger || 'queue');
  } else {
    const resetEpoch = parseUsageLimitResetEpoch(output);
    if (resetEpoch !== null) {
      runner.log('RUN', 'usage limit detected', { trigger: item.trigger || 'queue', issue: issueId });
      await runner.notifyUsageLimitToAllActiveIssues(resetEpoch).catch(() => {});
      const retryAt = new Date(resetEpoch * 1000).toISOString();
      runner.enqueue(issueId, item.trigger || 'queue', retryAt);
      runner.log('RETRY', 'scheduled', { trigger: item.trigger || 'queue', issue: issueId, retryAt });

      // backward compat: setTimeout retry
      const delayMs = Math.max(0, resetEpoch * 1000 - Date.now());
      setTimeout(async () => {
        runner.log('RETRY', 'firing', { trigger: item.trigger || 'queue', issue: issueId });
        const retryItem = runner.dequeue();
        if (!retryItem) return;
        const retryLocked = runner.acquireLock({ trigger: 'retry', issue: retryItem.issueId });
        if (!retryLocked) {
          runner.enqueue(retryItem.issueId, 'retry');
          return;
        }
        try {
          const { code: retryCode } = await triggerRun(retryItem.issueId);
          if (retryCode === 0) {
            runner.log('RETRY', 'completed successfully', { issue: retryItem.issueId });
            await runner.removeUsageLimitLabel(retryItem.issueId).catch(() => {});
          } else {
            runner.log('RETRY', `failed exit=${retryCode}`, { issue: retryItem.issueId });
          }
        } finally {
          runner.releaseLock();
        }
      }, delayMs);
    } else {
      runner.log('RUN', `failed exit=${code}`, { trigger: item.trigger || 'queue', issue: issueId });
    }
  }
}

async function drainQueue() {
  let item;
  while ((item = runner.dequeue()) !== null) {
    // Skip items whose retryAt is in the future
    if (item.retryAt && new Date(item.retryAt) > new Date()) {
      runner.enqueue(item.issueId, item.trigger, item.retryAt);
      break;
    }
    const remaining = runner.loadQueue().length;
    runner.log('QUEUE', `drain: starting issueId=${item.issueId}, queue remaining after this: ${remaining}`, { issue: item.issueId });

    const locked = runner.acquireLock({ trigger: 'drain', issue: item.issueId });
    if (!locked) {
      runner.log('QUEUE', 'drain: SKIPPED_LOCKED — re-enqueuing', { issue: item.issueId });
      runner.enqueue(item.issueId, item.trigger || 'drain');
      break;
    }
    try {
      await runItem(item);
    } catch (err) {
      runner.log('QUEUE', `drain error: ${err.message}`, { issue: item.issueId });
    } finally {
      runner.releaseLock();
    }
  }
  runner.log('QUEUE', `drain complete — queue empty`);
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

  runner.log('WEBHOOK', `Issue event: id=${body.data?.identifier || body.data?.id || 'unknown'} title="${body.data?.title || ''}" state=${body.data?.state?.name || ''} labels=${(body.data?.labels || []).map(l => l.name).join(',')}`);

  if (!["create", "update"].includes(body.action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  const issueId = body.data?.identifier || body.data?.id;
  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  const stateName = body.data?.state?.name || "";
  const stateType = body.data?.state?.type || "";
  const isTerminalState = ["completed", "canceled"].includes(stateType)
    || ["Done", "Canceled", "Cancelled"].includes(stateName);
  if (isTerminalState) {
    runner.log("WEBHOOK", `terminal issue state ignored: ${stateName || stateType}`, { issue: issueId });
    return res.status(200).json({ status: "ignored", reason: `terminal state: ${stateName || stateType}` });
  }

  // 既に処理中またはキュー内にある場合はスキップ
  if (runner.isQueued(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already queued: ${issueId}` });
  }

  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
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
        await runItem(item);
      } finally {
        runner.releaseLock();
        // After main task: drain remaining queue
        const queueSize = runner.loadQueue().length;
        if (queueSize > 0) {
          runner.log('QUEUE', `main task done, draining ${queueSize} remaining item(s)`);
          await drainQueue();
        } else {
          runner.log('QUEUE', 'main task done, queue empty — no drain needed');
        }
      }
    } catch (err) {
      runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[WEBHOOK] Server listening on port ${PORT}`);
  });
}

module.exports = app;
