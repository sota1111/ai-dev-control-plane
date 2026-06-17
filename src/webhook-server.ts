'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { DiscordNotifier } = require('./lib/discordNotifier');
const { verifyDiscordSignature } = require('./lib/discordInteractions');
const { routeInteraction } = require('./lib/discordCommandRouter');

export {};

const _discordNotifier = process.env.DISCORD_WEBHOOK_URL
  ? new DiscordNotifier(process.env.DISCORD_WEBHOOK_URL)
  : null;

if (_discordNotifier) {
  _discordNotifier.start();
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk: any, ...args: any[]) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStdoutWrite(chunk, ...args);
  };
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk: any, ...args: any[]) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStderrWrite(chunk, ...args);
  };
}

const runner = require('./runner');
const { isTerminalState } = require('./lib/issueState');
const fs = require('fs');
const WEBHOOK_EVENTS_FILE = path.join(runner.LOG_DIR, 'linear.webhook-events.json');
const WEBHOOK_EVENT_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  verify: (req: any, res: any, buf: Buffer) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Error handler for JSON parsing errors
app.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof SyntaxError && (err as any).status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;

function loadDedupeStore(): Record<string, string> {
  try {
    if (!fs.existsSync(WEBHOOK_EVENTS_FILE)) return {};
    const content = fs.readFileSync(WEBHOOK_EVENTS_FILE, 'utf8');
    const store = JSON.parse(content);
    // Prune expired entries (older than 1 hour)
    const now = Date.now();
    const pruned: Record<string, string> = {};
    for (const [key, receivedAt] of Object.entries(store)) {
      if (now - new Date(receivedAt as string).getTime() < WEBHOOK_EVENT_TTL_MS) {
        pruned[key] = receivedAt as string;
      }
    }
    return pruned;
  } catch (err) {
    return {};
  }
}

function saveDedupeStore(store: Record<string, string>): void {
  try {
    if (!fs.existsSync(runner.LOG_DIR)) fs.mkdirSync(runner.LOG_DIR, { recursive: true });
    const tmp = WEBHOOK_EVENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, WEBHOOK_EVENTS_FILE);
  } catch (err: any) {
    runner.log('WEBHOOK', `saveDedupeStore ERROR: ${err.message}`);
  }
}

function getEventKey(body: any, issueId: string): string {
  if (body.id) return body.id;
  // Fallback: hash of type+action+issueId+updatedAt
  const raw = JSON.stringify({
    type: body.type || '',
    action: body.action || '',
    issueId: issueId || '',
    updatedAt: body.data && body.data.updatedAt ? body.data.updatedAt : ''
  });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function isDedupeEvent(key: string): boolean {
  const store = loadDedupeStore();
  return !!store[key];
}

function markDedupeEvent(key: string): void {
  const store = loadDedupeStore();
  store[key] = new Date().toISOString();
  saveDedupeStore(store);
}

function verifyLinearSignature(req: any): boolean {
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

app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/webhooks/linear', (req: any, res: any) => {
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

  // Deduplicate: ignore retransmitted events
  const eventKey = getEventKey(body, body.data && body.data.identifier ? body.data.identifier : body.data && body.data.id ? body.data.id : '');
  if (isDedupeEvent(eventKey)) {
    runner.log('WEBHOOK', `ignored: duplicate event key=${eventKey}`);
    return res.status(200).json({ status: 'ignored', reason: 'duplicate event' });
  }
  markDedupeEvent(eventKey);

  if (body.type !== "Issue") {
    return res.status(200).json({ status: "ignored", reason: "not an issue event" });
  }

  const action = body.action || "";
  const issueId = body.data?.identifier || body.data?.id;
  const stateName = body.data?.state?.name || "";
  const stateType = body.data?.state?.type || "";
  const archivedAt = body.data?.archivedAt || null;

  runner.log('WEBHOOK', `Issue event: identifier=${issueId || 'unknown'} action=${action} state.name=${stateName} state.type=${stateType} labels=${(body.data?.labels || []).map((l: any) => l.name).join(',')}`);

  if (!["create", "update"].includes(action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  if (isTerminalState({ type: stateType, name: stateName })) {
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
  if (runner.isQueuedOrRunning(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already queued or running: ${issueId}` });
  }

  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
      const issuePriority = body.data?.priority ?? null;
      const issuePriorityLabel = body.data?.priorityLabel ?? null;
      const parentIssueId = body.data?.parent?.id ?? null;
      const parentIssueIdentifier = body.data?.parent?.identifier ?? null;
      const isUrgent = issuePriority === 1;

      const cooldown = runner.getUsageLimitCooldownUntil();
      if (cooldown) {
        const cooldownRetryAt = cooldown.retryAt;
        runner.enqueue(issueId, 'webhook', cooldownRetryAt, {
          priority: issuePriority,
          priorityLabel: issuePriorityLabel,
          parentIssueId,
          parentIssueIdentifier
        });
        runner.log('WEBHOOK', `usage limit cooldown active, queued until ${cooldownRetryAt}`, { issue: issueId });
        return;
      }

      if (!isUrgent && runner.isLocked()) {
        // Non-Urgent while locked: enqueue for later drain
        runner.enqueue(issueId, 'webhook', null, {
          priority: issuePriority,
          priorityLabel: issuePriorityLabel,
          parentIssueId,
          parentIssueIdentifier
        });
        runner.log('WEBHOOK', `non-Urgent issue (priority=${issuePriority}) queued while locked, queue size=${runner.loadQueue().length}`, { issue: issueId });
        return;
      }

      // Linear 全体チェック: Todo/In Progress Issue がなければ起動しない
      let hasPending = true;
      try {
        hasPending = await runner.hasPendingIssues();
      } catch (e: any) {
        runner.log('WEBHOOK', `hasPendingIssues error (fail-open): ${e.message}`, { issue: issueId });
      }
      if (!hasPending) {
        runner.log('WEBHOOK', 'no pending issues in Linear, skipping run', { issue: issueId });
        return;
      }

      // キューに追加してすぐ取り出す
      runner.enqueue(issueId, 'webhook', null, {
        priority: issuePriority,
        priorityLabel: issuePriorityLabel,
        parentIssueId,
        parentIssueIdentifier
      });
      const item = runner.dequeue();
      if (!item) return;
      const queuedIssueId = item.issueId;

      // ロック取得
      const locked = runner.acquireLock({ trigger: 'webhook', issue: queuedIssueId });
      if (!locked) {
        runner.log('WEBHOOK', 'SKIPPED_LOCKED — re-enqueuing', { issue: queuedIssueId });
        runner.enqueue(queuedIssueId, 'webhook', null, {
          priority: item.priority ?? null,
          priorityLabel: item.priorityLabel ?? null,
          parentIssueId: item.parentIssueId ?? null,
          parentIssueIdentifier: item.parentIssueIdentifier ?? null
        });
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
    } catch (err: any) {
      runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
    }
  });
});

app.post('/webhooks/discord', (req: any, res: any) => {
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
    .then(({ status, body }: { status: number, body: any }) => {
      res.status(status).json(body);
    })
    .catch((err: any) => {
      runner.log('DISCORD', `Error handling interaction: ${err.message}`);
      res.status(200).json({
        type: 4,
        data: { content: 'エラーが発生しました。しばらくしてから再試行してください。', flags: 64 },
      });
    });
});

async function runBootstrapScan(): Promise<void> {
  const enabled = process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED === 'true';
  if (!enabled) {
    runner.log('BOOTSTRAP', 'startup scan disabled (WEBHOOK_BOOTSTRAP_SCAN_ENABLED != true)');
    return;
  }

  if (!process.env.LINEAR_API_KEY) {
    runner.log('BOOTSTRAP', 'startup scan skipped: LINEAR_API_KEY not set');
    return;
  }

  const startedAt = new Date().toISOString();
  runner.log('BOOTSTRAP', `startup scan started at ${startedAt}`);

  let issues: any[] = [];
  try {
    issues = await runner.fetchActiveIssues(50);
  } catch (err: any) {
    runner.log('BOOTSTRAP', `fetchActiveIssues error: ${err.message}`);
    return;
  }

  runner.log('BOOTSTRAP', `startup scan: found ${issues.length} active issue(s)`);

  if (issues.length === 0) {
    runner.log('BOOTSTRAP', 'startup scan: no issues to enqueue');
    return;
  }

  const cooldown = runner.getUsageLimitCooldownUntil();
  const cooldownRetryAt = cooldown ? cooldown.retryAt : null;

  let enqueuedCount = 0;
  let skippedCount = 0;

  for (const issue of issues) {
    const { identifier, priority, priorityLabel, parentIssueId, parentIssueIdentifier } = issue;

    if (runner.isQueued(identifier)) {
      runner.log('BOOTSTRAP', `startup scan: skip ${identifier} (already queued)`);
      skippedCount++;
      continue;
    }

    const retryAt = cooldownRetryAt || null;
    runner.enqueue(identifier, 'webhook-bootstrap', retryAt, {
      priority,
      priorityLabel,
      parentIssueId,
      parentIssueIdentifier
    });
    runner.log('BOOTSTRAP', `startup scan: enqueued ${identifier}${retryAt ? ` retryAt=${retryAt}` : ''}`);
    enqueuedCount++;
  }

  runner.log('BOOTSTRAP', `startup scan complete: enqueued=${enqueuedCount} skipped=${skippedCount}`);

  if (enqueuedCount > 0) {
    runner.log('BOOTSTRAP', 'startup scan: running syncQueueWithLinear before drain');
    try {
      await runner.syncQueueWithLinear();
    } catch (err: any) {
      runner.log('BOOTSTRAP', `startup scan: syncQueueWithLinear error (non-fatal): ${err.message}`);
    }
    runner.log('BOOTSTRAP', 'startup scan: starting drainQueue');
    try {
      await runner.drainQueue();
      runner.log('BOOTSTRAP', 'startup scan: drainQueue complete');
    } catch (err: any) {
      runner.log('BOOTSTRAP', `startup scan: drainQueue error: ${err.message}`);
    }
  } else {
    runner.log('BOOTSTRAP', 'startup scan: no new items enqueued, drain skipped');
  }
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[WEBHOOK] Server listening on port ${PORT}`);
    setImmediate(() => {
      runBootstrapScan().catch((err) => {
        runner.log('BOOTSTRAP', `startup scan uncaught error: ${err.message}`);
      });
    });
  });
}

module.exports = { app, runBootstrapScan };

