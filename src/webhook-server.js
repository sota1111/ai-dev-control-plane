const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(express.json());

// Error handler for JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next();
});

const PORT = process.env.PORT || 3000;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const runningIssues = new Set();

if (!LINEAR_WEBHOOK_SECRET) {
  console.warn('[WEBHOOK] WARNING: LINEAR_WEBHOOK_SECRET not set. Running in development mode without signature verification.');
}

function triggerRun(issueId) {
  // SECURITY: Pass issueId only via environment variable, never as shell argument
  const env = { ...process.env, WEBHOOK_ISSUE_ID: issueId };
  const projectRoot = path.join(__dirname, '..');
  
  const child = spawn('bash', ['scripts/ai/run_auto.sh'], {
    env,
    cwd: projectRoot,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (data) => {
    process.stdout.write(`[RUN:${issueId}] ${data}`);
  });
  child.stderr.on('data', (data) => {
    process.stderr.write(`[RUN:${issueId}] ${data}`);
  });

  return new Promise((resolve) => {
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`[WEBHOOK] Failed to spawn run_auto.sh for ${issueId}: ${err.message}`);
      resolve(1);
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

  console.log(`[WEBHOOK] Received event type=${body.type || 'unknown'} action=${body.action || 'unknown'} at ${new Date().toISOString()}`);

  if (body.type !== "Issue") {
    return res.status(200).json({ status: "ignored", reason: "not an issue event" });
  }

  if (!["create", "update"].includes(body.action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  const issueId = body.data?.identifier || body.data?.id;
  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  if (runningIssues.has(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already processing ${issueId}` });
  }

  runningIssues.add(issueId);
  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
      const exitCode = await triggerRun(issueId);
      runningIssues.delete(issueId);
      console.log(`[WEBHOOK] Processing completed for issueId=${issueId} exit=${exitCode}`);
    } catch (err) {
      runningIssues.delete(issueId);
      console.error(`[WEBHOOK] Processing error for issueId=${issueId}: ${err.message}`);
    }
  });
});

app.listen(PORT, () => {
  console.log(`[WEBHOOK] Server listening on port ${PORT}`);
});
