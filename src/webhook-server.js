const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { parseUsageLimitResetEpoch } = require('./lib/usageLimitParser');

// Distinguish parent-received signals from child process signals
process.on('SIGTERM', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGTERM at ${new Date().toISOString()} — user-initiated stop, shutting down gracefully`);
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGINT at ${new Date().toISOString()} — user-initiated stop (Ctrl+C), shutting down gracefully`);
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
const runningIssues = new Set();
const pendingRetryIssues = new Set();

function verifyLinearSignature(req) {
  if (!LINEAR_WEBHOOK_SECRET) {
    return true; // development mode: skip verification
  }
  const signature = req.headers['linear-signature'];
  if (!signature) {
    console.warn('[WEBHOOK] No linear-signature header found');
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

  console.log(`[WEBHOOK:CHILD] Spawned run_auto.sh for issueId=${issueId} pid=${child.pid} startedAt=${startedAt}`);

  let output = '';

  child.stdout.on('data', (data) => {
    const str = data.toString();
    output += str;
    process.stdout.write(`[RUN:${issueId}] ${str}`);
  });
  child.stderr.on('data', (data) => {
    const str = data.toString();
    output += str;
    process.stderr.write(`[RUN:${issueId}] ${str}`);
  });

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      const endedAt = new Date().toISOString();
      if (signal) {
        // Child received a signal (e.g. SIGTERM from external kill).
        // This is the CHILD's signal — the parent webhook server is still running.
        console.log(`[WEBHOOK:CHILD] run_auto.sh for issueId=${issueId} terminated by signal=${signal} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`);
      } else {
        console.log(`[WEBHOOK:CHILD] run_auto.sh for issueId=${issueId} exited code=${code} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`);
      }
      resolve({ code: code ?? (signal ? 143 : 1), output });
    });
    child.on('error', (err) => {
      const endedAt = new Date().toISOString();
      console.error(`[WEBHOOK:CHILD] Failed to spawn run_auto.sh for issueId=${issueId} error=${err.message} startedAt=${startedAt} endedAt=${endedAt}`);
      resolve({ code: 1, output: err.message });
    });
  });
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
    console.warn('[WEBHOOK] Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  console.log(`[WEBHOOK] Received event type=${body.type || 'unknown'} action=${body.action || 'unknown'} at ${new Date().toISOString()}`);

  if (body.type !== "Issue") {
    return res.status(200).json({ status: "ignored", reason: "not an issue event" });
  }

  console.log(`[WEBHOOK] Issue event: id=${body.data?.identifier || body.data?.id || 'unknown'} title="${body.data?.title || ''}" state=${body.data?.state?.name || ''} labels=${(body.data?.labels || []).map(l => l.name).join(',')}`);

  if (!["create", "update"].includes(body.action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  const issueId = body.data?.identifier || body.data?.id;
  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  if (runningIssues.has(issueId) || pendingRetryIssues.has(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already processing or pending retry for ${issueId}` });
  }

  runningIssues.add(issueId);
  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
      const { code, output } = await triggerRun(issueId);
      if (code === 0) {
        console.log(`[WEBHOOK] Processing completed for issueId=${issueId} exit=0`);
        runningIssues.delete(issueId);
      } else {
        const resetEpoch = parseUsageLimitResetEpoch(output);
        if (resetEpoch !== null) {
          console.log(`[WEBHOOK] Usage limit detected for issueId=${issueId}. Reset+buffer at ${new Date(resetEpoch * 1000).toISOString()}`);
          pendingRetryIssues.add(issueId);
          runningIssues.delete(issueId);
          const delayMs = Math.max(0, resetEpoch * 1000 - Date.now());
          console.log(`[WEBHOOK] Retry scheduled for issueId=${issueId} in ${delayMs}ms`);
          setTimeout(async () => {
            console.log(`[WEBHOOK] Retry starting for issueId=${issueId}`);
            pendingRetryIssues.delete(issueId);
            runningIssues.add(issueId);
            try {
              const { code: retryCode } = await triggerRun(issueId);
              if (retryCode === 0) {
                console.log(`[WEBHOOK] Retry completed successfully for issueId=${issueId}`);
              } else {
                console.log(`[WEBHOOK] Retry failed for issueId=${issueId} exit=${retryCode}`);
              }
            } catch (retryErr) {
              console.error(`[WEBHOOK] Retry error for issueId=${issueId}: ${retryErr.message}`);
            } finally {
              runningIssues.delete(issueId);
            }
          }, delayMs);
        } else {
          console.log(`[WEBHOOK] Run failed for issueId=${issueId} exit=${code}. No usage limit detected, not retrying.`);
          runningIssues.delete(issueId);
        }
      }
    } catch (err) {
      runningIssues.delete(issueId);
      console.error(`[WEBHOOK] Processing error for issueId=${issueId}: ${err.message}`);
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[WEBHOOK] Server listening on port ${PORT}`);
  });
}

module.exports = app;
