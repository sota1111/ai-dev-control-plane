const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execSync } = require('child_process');
const { classifyUsageLimit } = require('./lib/usageLimitParser');
const { buildIssueRerunMetadata, saveResumeMetadata, formatResumeLogLines } = require('./lib/resumeMetadata');
const queueOrdering = require('./lib/queueOrdering');

const SKIPPED_LOCKED = 75;  // exit code when lock is not available
const COMPLETION_UNVERIFIED = 70; // exit code when process 0 but task not finished

/**
 * Verifies if the task is actually completed even if the process exited with 0.
 * @param {string} issueId
 * @param {string} output
 * @returns {Promise<{completed: boolean, reason: string}>}
 */
async function verifyTaskCompletion(issueId, output) {
  // 1. Check explicit marker from run_auto.sh
  if (output && output.includes('COMPLETION_CONTRACT: INCOMPLETE')) {
    const reasonMatch = output.match(/COMPLETION_CONTRACT: INCOMPLETE reason=(.+)/);
    const reason = (reasonMatch ? reasonMatch[1] : 'run_auto marker: incomplete').trim();
    return { completed: false, reason };
  }

  // 2. Query Linear for final state (Source of Truth)
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          state { name type }
        }
      }
    `;
    const data = await linearQuery(query, { id: issueId });

    if (!data.issue) {
      return { completed: false, reason: 'verification unavailable: issue not found' };
    }

    const { state } = data.issue;
    const isActuallyCompleted = state?.type === 'completed' || state?.name === 'Done';

    if (isActuallyCompleted) {
      return { completed: true };
    } else {
      return { completed: false, reason: `state is "${state?.name || 'unknown'}" (${state?.type || 'unknown'})` };
    }
  } catch (err) {
    // Fail closed: if we can't confirm completion via API, assume it's incomplete
    // to prevent premature cleanup of usage-limit states.
    return { completed: false, reason: `verification unavailable: ${err.message}` };
  }
}
const LOG_DIR = path.join(__dirname, '..', 'docs', 'ai', 'auto_logs');
const LOCK_FILE = path.join(LOG_DIR, 'runner.lock');
const QUEUE_FILE = path.join(LOG_DIR, 'runner.queue.json');
const USAGE_LIMIT_FILE = path.join(LOG_DIR, 'runner.usage-limit.json');
const COOLDOWN_FILE = path.join(LOG_DIR, 'runner.cooldown.json');
const USAGE_LIMIT_RETRY_BUFFER_SECONDS = parseInt(process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS || '600', 10);
const MAX_DRAIN_ITEMS = 20;  // safety guard against infinite drain loops
const LOG_FILE = path.join(LOG_DIR, 'auto_runner.log');
const STALE_LOCK_MS = 30 * 60 * 1000;  // 30 minutes
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const QUEUE_ITEM_TTL_DAYS = parseInt(process.env.QUEUE_ITEM_TTL_DAYS || '7', 10);
const INFLIGHT_FILE = path.join(LOG_DIR, 'runner.inflight.json');

function log(tag, message, context = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    const contextStr = Object.entries(context)
      .filter(([_, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const line = `[${timestamp}] [${tag}] ${contextStr ? contextStr + ' ' : ''}${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch (err) {
    console.error(`[RUNNER:LOG_ERROR] ${err.message}`);
  }
}

function acquireLock(context = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    if (!fs.existsSync(LOCK_FILE)) {
      fs.writeFileSync(LOCK_FILE, `${process.pid}:${new Date().toISOString()}`);
      log('LOCK', 'acquired', context);
      return true;
    }

    const content = fs.readFileSync(LOCK_FILE, 'utf8');
    const parts = content.split(':');
    const pidStr = parts[0];
    const timestampStr = parts.slice(1).join(':');
    const pid = parseInt(pidStr, 10);
    const timestamp = new Date(timestampStr);

    let isDead = false;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') {
        isDead = true;
      }
    }

    const isStale = (Date.now() - timestamp.getTime()) > STALE_LOCK_MS;

    if (isDead || isStale) {
      const reason = isDead ? 'dead process' : 'stale';
      log('LOCK', `removing ${reason} lock`, { oldPid: pidStr });
      fs.unlinkSync(LOCK_FILE);
      fs.writeFileSync(LOCK_FILE, `${process.pid}:${new Date().toISOString()}`);
      log('LOCK', 'acquired (after stale/dead removal)', context);
      return true;
    }

    log('LOCK', `SKIPPED_LOCKED lock held by pid=${pid}`, context);
    return false;
  } catch (err) {
    log('LOCK', `ERROR: ${err.message}`, context);
    return false;
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8');
      const [pidStr] = content.split(':');
      if (parseInt(pidStr, 10) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        log('LOCK', 'released');
      }
    }
  } catch (err) {
    log('LOCK', `release ERROR: ${err.message}`);
  }
}

function getGitCheckpointInfo() {
  const root = path.join(__dirname, '..');
  const result = { branch: '', lastCommit: '', gitStatus: '' };
  try {
    result.branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: root }).trim();
    result.lastCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: root }).trim();
    result.gitStatus = execSync('git status --short', { encoding: 'utf8', cwd: root }).trim();
  } catch (err) {
    // Silence errors, return empty strings as requested
  }
  return result;
}

function isLocked() {
  try {
    if (!fs.existsSync(LOCK_FILE)) return false;
    const content = fs.readFileSync(LOCK_FILE, 'utf8');
    const parts = content.split(':');
    const pid = parseInt(parts[0], 10);
    const timestamp = new Date(parts.slice(1).join(':'));
    if (isNaN(pid)) return false;
    const isStale = (Date.now() - timestamp.getTime()) > STALE_LOCK_MS;
    if (isStale) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code !== 'ESRCH';
    }
  } catch (err) {
    return false;
  }
}

async function linearQuery(query, variables = {}) {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error('LINEAR_API_KEY not set');

  const body = JSON.stringify({ query, variables });

  return new Promise((resolve, reject) => {
    const url = new URL(LINEAR_API_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(json.errors[0].message));
          } else {
            resolve(json.data);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Linear API response: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => { reject(err); });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Linear API timeout'));
    });
    req.write(body);
    req.end();
  });
}

const getPriorityRank = queueOrdering.getPriorityRank;

async function getIssueQueueMetadata(issueId) {
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          priority
          priorityLabel
          archivedAt
          createdAt
          updatedAt
          state { type name }
          parent { id identifier }
        }
      }
    `;
    const data = await linearQuery(query, { id: issueId });
    if (!data.issue) return null;
    const issue = data.issue;
    return {
      id: issue.id,
      identifier: issue.identifier,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      priorityRank: getPriorityRank(issue.priority),
      parentIssueId: issue.parent?.id ?? null,
      parentIssueIdentifier: issue.parent?.identifier ?? null,
      stateType: issue.state?.type ?? null,
      stateName: issue.state?.name ?? null,
      archivedAt: issue.archivedAt ?? null,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null
    };
  } catch (err) {
    log('RUNNER', `getIssueQueueMetadata failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

async function hasPendingIssues() {
  try {
    const query = '{ issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: 1) { nodes { id } } }';
    const data = await linearQuery(query);
    return !!(data.issues?.nodes?.length > 0);
  } catch (err) {
    // Fail safe: don't block execution
    return false;
  }
}

async function fetchActiveIssues(first = 50) {
  const query = `
    query($first: Int!) {
      issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: $first) {
        nodes {
          id
          identifier
          priority
          priorityLabel
          archivedAt
          createdAt
          updatedAt
          state { type name }
          parent { id identifier }
        }
      }
    }
  `;
  const data = await linearQuery(query, { first });
  return (data.issues?.nodes || [])
    .filter(issue => !issue.archivedAt)
    .map(issue => ({
      id: issue.id,
      identifier: issue.identifier,
      priority: issue.priority ?? null,
      priorityLabel: issue.priorityLabel ?? null,
      priorityRank: getPriorityRank(issue.priority),
      parentIssueId: issue.parent?.id ?? null,
      parentIssueIdentifier: issue.parent?.identifier ?? null,
      stateType: issue.state?.type ?? null,
      stateName: issue.state?.name ?? null,
      archivedAt: issue.archivedAt ?? null,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null
    }));
}

function buildUsageLimitCommentBody(resetEpoch) {
  const date = new Date(resetEpoch * 1000);
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const iso = jstDate.toISOString();
  const jstTime = `${iso.substring(0, 10)} ${iso.substring(11, 16)} JST`;
  return `usage-limit: Next auto run: ${jstTime}`;
}

async function postUsageLimitComment(issueId, resetEpoch) {
  try {
    const getIssue = await linearQuery('query($id: String!) { issue(id: $id) { id } }', { id: issueId });
    if (!getIssue.issue) return;
    const uuid = getIssue.issue.id;

    const body = buildUsageLimitCommentBody(resetEpoch);

    // Check for duplicate comment before posting
    let existingComments = [];
    try {
      const commentsData = await linearQuery(
        'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
        { id: uuid }
      );
      existingComments = commentsData.issue?.comments?.nodes || [];
    } catch (err) {
      log('WARN', `postUsageLimitComment: could not fetch comments, proceeding to post. ${err.message}`, { issue: issueId });
    }

    if (existingComments.some(c => c.body === body)) {
      log('RUNNER', 'usage-limit comment already exists, skipped', { issue: issueId, body });
      return;
    }

    await linearQuery(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId: uuid, body });
  } catch (err) {
    log('ERROR', `postUsageLimitComment failed: ${err.message}`, { issue: issueId });
  }
}

async function addUsageLimitLabel(issueId) {
  try {
    const issueData = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds team { id } } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds, team } = issueData.issue;
    const teamId = team.id;

    const labelsData = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    let labelId = labelsData.issueLabels.nodes[0]?.id;

    if (!labelId) {
      const createLabelData = await linearQuery(`
        mutation($name: String!, $teamId: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId, color: $color }) {
            issueLabel { id }
          }
        }
      `, { name: 'usage-limit', teamId, color: '#FF6B6B' });
      labelId = createLabelData.issueLabelCreate.issueLabel.id;
    }

    if (!labelIds.includes(labelId)) {
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: [...labelIds, labelId] });
    }
  } catch (err) {
    log('ERROR', `addUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

async function removeUsageLimitLabel(issueId) {
  try {
    const issueData = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds } = issueData.issue;

    const labelsData = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    const labelId = labelsData.issueLabels.nodes[0]?.id;

    if (labelId && labelIds.includes(labelId)) {
      const filteredIds = labelIds.filter(id => id !== labelId);
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: filteredIds });
    }
  } catch (err) {
    log('ERROR', `removeUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

function setUsageLimitCooldownUntil(retryAt, issueIdOrOptions = null) {
  // Accept both old signature (retryAt, issueId) and new (retryAt, { issueId, issueIdentifier, resetAt, bufferSeconds, reason, limitType })
  let issueId = null;
  let issueIdentifier = null;
  let resetAt = null;
  let bufferSeconds = USAGE_LIMIT_RETRY_BUFFER_SECONDS;
  let reason = 'usage_limit';
  let limitType = 'session_limit';

  if (typeof issueIdOrOptions === 'string') {
    issueId = issueIdOrOptions; // backward compat
  } else if (issueIdOrOptions && typeof issueIdOrOptions === 'object') {
    issueId = issueIdOrOptions.issueId || null;
    issueIdentifier = issueIdOrOptions.issueIdentifier || null;
    resetAt = issueIdOrOptions.resetAt || null;
    bufferSeconds = issueIdOrOptions.bufferSeconds != null ? issueIdOrOptions.bufferSeconds : USAGE_LIMIT_RETRY_BUFFER_SECONDS;
    reason = issueIdOrOptions.reason || 'usage_limit';
    limitType = issueIdOrOptions.limitType || 'session_limit';
  }

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const now = new Date().toISOString();

    // Write to new COOLDOWN_FILE with rich structure
    const cooldownData = {
      active: true,
      until: retryAt,
      detectedAt: now,
      sourceIssueId: issueId,
      sourceIssueIdentifier: issueIdentifier,
      resetAt: resetAt,
      bufferSeconds: bufferSeconds,
      reason: reason,
      limitType: limitType
    };
    const cooldownTmp = COOLDOWN_FILE + '.tmp';
    fs.writeFileSync(cooldownTmp, JSON.stringify(cooldownData, null, 2));
    fs.renameSync(cooldownTmp, COOLDOWN_FILE);

    // Also write backward-compat USAGE_LIMIT_FILE so old scheduler.sh can still read it
    const legacyData = { retryAt, issueId };
    const legacyTmp = USAGE_LIMIT_FILE + '.tmp';
    fs.writeFileSync(legacyTmp, JSON.stringify(legacyData, null, 2));
    fs.renameSync(legacyTmp, USAGE_LIMIT_FILE);

    log('RUNNER', 'usage limit cooldown set', { retryAt, issueId: issueId || undefined, issueIdentifier: issueIdentifier || undefined });
  } catch (err) {
    log('ERROR', `setUsageLimitCooldownUntil failed: ${err.message}`);
  }
}

function clearUsageLimitCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      fs.unlinkSync(COOLDOWN_FILE);
    }
    if (fs.existsSync(USAGE_LIMIT_FILE)) {
      fs.unlinkSync(USAGE_LIMIT_FILE);
    }
    log('RUNNER', 'usage limit cooldown cleared');
  } catch (err) {
    log('ERROR', `clearUsageLimitCooldown failed: ${err.message}`);
  }
}

function getUsageLimitCooldownUntil(nowMs = Date.now()) {
  // Try new COOLDOWN_FILE first
  if (fs.existsSync(COOLDOWN_FILE)) {
    try {
      const content = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      const state = JSON.parse(content);
      const retryAt = state.until || state.retryAt || null;
      if (!retryAt) {
        clearUsageLimitCooldown();
        return null;
      }
      const retryAtMs = new Date(retryAt).getTime();
      if (isNaN(retryAtMs) || retryAtMs <= nowMs) {
        clearUsageLimitCooldown();
        return null;
      }
      return {
        retryAt,
        issueId: state.sourceIssueId || null,
        issueIdentifier: state.sourceIssueIdentifier || null,
        reason: state.reason || null,
        limitType: state.limitType || null,
        active: true
      };
    } catch (err) {
      log('ERROR', `getUsageLimitCooldownUntil: COOLDOWN_FILE parse failed: ${err.message}`);
      // Fall through to legacy file
    }
  }

  // Fall back to legacy USAGE_LIMIT_FILE
  try {
    if (!fs.existsSync(USAGE_LIMIT_FILE)) return null;
    const content = fs.readFileSync(USAGE_LIMIT_FILE, 'utf8');
    const state = JSON.parse(content);

    let retryAt, issueId;
    if (typeof state === 'string') {
      retryAt = state;
    } else {
      retryAt = state.retryAt;
      issueId = state.issueId;
    }

    if (!retryAt) return null;
    const retryAtMs = new Date(retryAt).getTime();
    if (isNaN(retryAtMs)) {
      clearUsageLimitCooldown();
      return null;
    }
    if (retryAtMs <= nowMs) {
      clearUsageLimitCooldown();
      return null;
    }
    return { retryAt, issueId: issueId || null };
  } catch (err) {
    log('ERROR', `getUsageLimitCooldownUntil failed: ${err.message}`);
    return null;
  }
}

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const content = fs.readFileSync(QUEUE_FILE, 'utf8');
    try {
      const queue = JSON.parse(content);
      return Array.isArray(queue) ? queue : [];
    } catch (parseErr) {
      const backupFile = QUEUE_FILE + '.corrupt.' + Date.now();
      try { fs.writeFileSync(backupFile, content); } catch (_) {}
      log('QUEUE', `loadQueue: JSON parse failed, backed up corrupt file to ${path.basename(backupFile)}: ${parseErr.message}`);
      return [];
    }
  } catch (err) {
    log('QUEUE', `loadQueue ERROR: ${err.message}`);
    return [];
  }
}

function normalizeQueue(queue) {
  if (!Array.isArray(queue) || queue.length === 0) return [];

  const map = new Map();
  for (const item of queue) {
    const issueId = item.issueId;
    if (!issueId) continue;

    if (!map.has(issueId)) {
      map.set(issueId, { ...item });
      continue;
    }

    const existing = map.get(issueId);

    // Merge retryAt: null (immediate) beats any future time; among two future times, earlier wins
    const existingRetryMs = existing.retryAt ? new Date(existing.retryAt).getTime() : null;
    const newRetryMs = item.retryAt ? new Date(item.retryAt).getTime() : null;
    let mergedRetryAt;
    if (newRetryMs === null || existingRetryMs === null) {
      mergedRetryAt = null;
    } else {
      mergedRetryAt = new Date(Math.min(existingRetryMs, newRetryMs)).toISOString();
    }

    // priorityRank: take the lower rank value (higher urgency)
    const existingRank = existing.priorityRank ?? getPriorityRank(existing.priority);
    const newRank = item.priorityRank ?? getPriorityRank(item.priority);
    const mergedRank = Math.min(existingRank, newRank);

    // enqueuedAt: take the earlier timestamp
    const existingEnqMs = existing.enqueuedAt ? new Date(existing.enqueuedAt).getTime() : Infinity;
    const newEnqMs = item.enqueuedAt ? new Date(item.enqueuedAt).getTime() : Infinity;
    const mergedEnqueuedAt = existingEnqMs <= newEnqMs ? existing.enqueuedAt : item.enqueuedAt;

    // attemptCount: sum both counts
    const mergedAttemptCount = (existing.attemptCount || 0) + (item.attemptCount || 0);

    // lastAttemptAt: take the later timestamp
    const existingLastMs = existing.lastAttemptAt ? new Date(existing.lastAttemptAt).getTime() : 0;
    const newLastMs = item.lastAttemptAt ? new Date(item.lastAttemptAt).getTime() : 0;
    const mergedLastAttemptAt = existingLastMs >= newLastMs ? existing.lastAttemptAt : item.lastAttemptAt;

    map.set(issueId, {
      ...existing,
      ...item, // keep fields from the latest one by default
      retryAt: mergedRetryAt,
      priorityRank: mergedRank,
      enqueuedAt: mergedEnqueuedAt,
      attemptCount: mergedAttemptCount,
      lastAttemptAt: mergedLastAttemptAt,
      // Restore some fields from existing if they were null in item
      issueIdentifier: item.issueIdentifier || existing.issueIdentifier || null,
      trigger: item.trigger || existing.trigger || null,
      reason: item.reason || existing.reason || null,
      priority: item.priority !== null ? item.priority : existing.priority,
      priorityLabel: item.priorityLabel || existing.priorityLabel || null,
      parentIssueId: item.parentIssueId || existing.parentIssueId || null,
      parentIssueIdentifier: item.parentIssueIdentifier || existing.parentIssueIdentifier || null,
      queueGroup: item.queueGroup || existing.queueGroup || null,
      queueGroupOrder: item.queueGroupOrder || existing.queueGroupOrder || null
    });
  }
  return Array.from(map.values());
}

async function syncQueueWithLinear() {
  const queue = loadQueue();
  if (queue.length === 0) return;

  const toRemove = [];
  for (const item of queue) {
    try {
      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            archivedAt
            state { type name }
          }
        }
      `;
      const data = await linearQuery(query, { id: item.issueId });

      if (!data.issue) {
        log('QUEUE', `syncQueueWithLinear: removing not-found issue`, { issue: item.issueId });
        toRemove.push(item.issueId);
        continue;
      }

      const { archivedAt, state } = data.issue;

      if (archivedAt) {
        log('QUEUE', `syncQueueWithLinear: removing archived issue`, { issue: item.issueId });
        toRemove.push(item.issueId);
        continue;
      }

      const isTerminal = ['completed', 'canceled', 'duplicate'].includes(state?.type)
        || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name);

      if (isTerminal) {
        log('QUEUE', `syncQueueWithLinear: removing terminal issue state=${state?.name}`, { issue: item.issueId });
        toRemove.push(item.issueId);
      }
    } catch (err) {
      // Fail-open: API failure does not remove the item
      log('QUEUE', `syncQueueWithLinear: API error for ${item.issueId}, skipping: ${err.message}`);
    }
  }

  if (toRemove.length > 0) {
    const cleaned = loadQueue().filter(item => !toRemove.includes(item.issueId));
    saveQueue(cleaned);
    log('QUEUE', `syncQueueWithLinear: removed ${toRemove.length} item(s)`, { removed: toRemove.join(',') });
  }
}

async function pruneExpiredQueueItems() {
  const queue = loadQueue();
  if (queue.length === 0) return;

  const now = Date.now();
  const ttlMs = QUEUE_ITEM_TTL_DAYS * 24 * 60 * 60 * 1000;

  const expired = queue.filter(item => {
    if (!item.enqueuedAt) return false;
    const age = now - new Date(item.enqueuedAt).getTime();
    return age > ttlMs;
  });

  if (expired.length === 0) return;

  const toRemove = [];
  for (const item of expired) {
    try {
      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            archivedAt
            state { type name }
          }
        }
      `;
      const data = await linearQuery(query, { id: item.issueId });

      if (!data.issue) {
        toRemove.push(item.issueId);
        continue;
      }
      const { archivedAt, state } = data.issue;
      if (archivedAt) {
        toRemove.push(item.issueId);
        continue;
      }
      const isTerminal = ['completed', 'canceled', 'duplicate'].includes(state?.type)
        || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name);
      if (isTerminal) {
        toRemove.push(item.issueId);
      }
      // Active issues older than TTL: keep in queue (do not blindly remove active issues)
    } catch (err) {
      log('QUEUE', `pruneExpiredQueueItems: API error for ${item.issueId}, skip: ${err.message}`);
    }
  }

  if (toRemove.length > 0) {
    const cleaned = loadQueue().filter(item => !toRemove.includes(item.issueId));
    saveQueue(cleaned);
    log('QUEUE', `pruneExpiredQueueItems: removed ${toRemove.length} expired item(s)`, { removed: toRemove.join(',') });
  }
}

function saveQueue(queue) {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const tmpFile = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(queue, null, 2));
    fs.renameSync(tmpFile, QUEUE_FILE);
  } catch (err) {
    log('QUEUE', `save ERROR: ${err.message}`);
  }
}

function enqueue(issueId, trigger, retryAt = null, {
  issueIdentifier = null,
  reason = null,
  priority = null,
  priorityLabel = null,
  parentIssueId = null,
  parentIssueIdentifier = null,
  queueGroup = null,
  queueGroupOrder = null
} = {}) {
  try {
    // Derive queueGroup from parentIssueId if not explicitly set
    const resolvedQueueGroup = queueGroup ?? (parentIssueId || null);

    const queue = loadQueue();
    const now = new Date().toISOString();
    const existingIndex = queue.findIndex(item => item.issueId === issueId);

    if (existingIndex !== -1) {
      const existing = queue[existingIndex];

      // Merge retryAt: null (immediate) beats any future time; among two future times, earlier wins
      const existingRetryMs = existing.retryAt ? new Date(existing.retryAt).getTime() : null;
      const newRetryMs = retryAt ? new Date(retryAt).getTime() : null;
      let mergedRetryAt;
      if (newRetryMs === null || existingRetryMs === null) {
        mergedRetryAt = null; // immediate beats any future time
      } else {
        mergedRetryAt = new Date(Math.min(existingRetryMs, newRetryMs)).toISOString();
      }

      queue[existingIndex] = {
        ...existing,
        trigger,
        retryAt: mergedRetryAt,
        lastAttemptAt: now,
        attemptCount: (existing.attemptCount || 0) + 1,
        reason: reason || existing.reason || null,
        ...(issueIdentifier && !existing.issueIdentifier ? { issueIdentifier } : {}),
        // Update priority if provided
        ...(priority !== null ? {
          priority,
          priorityLabel: priorityLabel ?? existing.priorityLabel ?? null,
          priorityRank: getPriorityRank(priority),
          linearFetchedAt: now
        } : {}),
        // Update parent if provided
        ...(parentIssueId !== null ? {
          parentIssueId,
          parentIssueIdentifier: parentIssueIdentifier ?? existing.parentIssueIdentifier ?? null
        } : {}),
        // Update queueGroup if provided or derivable
        ...(resolvedQueueGroup !== null ? {
          queueGroup: resolvedQueueGroup,
          ...(queueGroupOrder !== null ? { queueGroupOrder } : {})
        } : {})
      };
      saveQueue(queue);
      log('QUEUE', 'enqueue: updated existing item', { issue: issueId, trigger, retryAt: mergedRetryAt });
      return;
    }

    queue.push({
      issueId,
      issueIdentifier: issueIdentifier || null,
      trigger,
      retryAt,
      enqueuedAt: now,
      lastAttemptAt: null,
      attemptCount: 0,
      reason: reason || null,
      priority: priority !== null ? priority : null,
      priorityLabel: priorityLabel ?? null,
      priorityRank: priority !== null ? getPriorityRank(priority) : getPriorityRank(null),
      linearFetchedAt: priority !== null ? now : null,
      parentIssueId: parentIssueId ?? null,
      parentIssueIdentifier: parentIssueIdentifier ?? null,
      queueGroup: resolvedQueueGroup,
      queueGroupOrder: queueGroupOrder ?? null
    });
    saveQueue(queue);
    log('QUEUE', 'enqueued', { issue: issueId, trigger });
  } catch (err) {
    log('QUEUE', `enqueue ERROR: ${err.message}`, { issue: issueId });
  }
}

function dequeue(lastProcessedGroup = null) {
  try {
    const queue = loadQueue();
    const now = new Date();

    const bestIndex = queueOrdering.selectNextReadyIndex(queue, { lastProcessedGroup, now });
    if (bestIndex === null) return null;

    const item = queue[bestIndex];
    const rank = queueOrdering.effectiveRank(item);

    // Determine which branch was taken for logging (Urgent > Group > Normal)
    let logType = 'dequeued';
    if (rank === 1) {
      logType = 'dequeued (urgent)';
    } else if (lastProcessedGroup && item.queueGroup === lastProcessedGroup) {
      logType = 'dequeued (group priority)';
    }

    queue.splice(bestIndex, 1);
    saveQueue(queue);

    if (logType === 'dequeued (group priority)') {
      log('QUEUE', logType, { issue: item.issueId, queueGroup: item.queueGroup, priorityRank: rank });
    } else {
      log('QUEUE', logType, { issue: item.issueId, priorityRank: rank });
    }

    return item;
  } catch (err) {
    log('QUEUE', `dequeue ERROR: ${err.message}`);
    return null;
  }
}

function removeFromQueue(issueId) {
  try {
    const queue = loadQueue();
    const filtered = queue.filter(item => item.issueId !== issueId);
    if (filtered.length !== queue.length) {
      saveQueue(filtered);
      log('QUEUE', 'removed', { issue: issueId });
    }
  } catch (err) {
    log('QUEUE', `removeFromQueue ERROR: ${err.message}`, { issue: issueId });
  }
}

function isQueued(issueId) {
  const queue = loadQueue();
  return queue.some(item => item.issueId === issueId);
}

function loadInflight() {
  try {
    if (!fs.existsSync(INFLIGHT_FILE)) return [];
    const content = fs.readFileSync(INFLIGHT_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveInflight(list) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = INFLIGHT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, INFLIGHT_FILE);
  } catch (err) {
    log('RUNNER', `saveInflight ERROR: ${err.message}`);
  }
}

function addInflight(issueId) {
  const list = loadInflight();
  if (!list.includes(issueId)) {
    list.push(issueId);
    saveInflight(list);
  }
}

function removeInflight(issueId) {
  const list = loadInflight().filter(id => id !== issueId);
  saveInflight(list);
}

function isInflight(issueId) {
  return loadInflight().includes(issueId);
}

function isQueuedOrRunning(issueId) {
  return isQueued(issueId) || isInflight(issueId);
}

async function notifyUsageLimitToAllActiveIssues(epochSeconds) {
  try {
    const data = await linearQuery(
      '{ issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: 50) { nodes { id } } }'
    );
    const issues = data.issues?.nodes || [];
    for (const issue of issues) {
      await postUsageLimitComment(issue.id, epochSeconds).catch(() => {});
      await addUsageLimitLabel(issue.id).catch(() => {});
    }
    log('RUNNER', `notifyUsageLimitToAllActiveIssues done for ${issues.length} issue(s)`);
  } catch (err) {
    log('ERROR', `notifyUsageLimitToAllActiveIssues failed: ${err.message}`);
  }
}

async function removeUsageLimitLabelFromAllIssues() {
  try {
    const labelsData = await linearQuery(
      'query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }'
    );
    const labelId = labelsData.issueLabels.nodes[0]?.id;
    if (!labelId) {
      log('RUNNER', 'removeUsageLimitLabelFromAllIssues: no usage-limit label found');
      return;
    }
    const issueData = await linearQuery(
      `{ issues(filter: { labels: { id: { eq: "${labelId}" } } }, first: 50) { nodes { id labelIds } } }`
    );
    const issues = issueData.issues?.nodes || [];
    for (const issue of issues) {
      await removeUsageLimitLabel(issue.id).catch(() => {});
    }
    log('RUNNER', `removeUsageLimitLabelFromAllIssues done for ${issues.length} issue(s)`);
  } catch (err) {
    log('ERROR', `removeUsageLimitLabelFromAllIssues failed: ${err.message}`);
  }
}

async function setIssueInProgress(issueId) {
  try {
    const issueData = await linearQuery(
      'query($id: String!) { issue(id: $id) { id state { type } team { id } } }',
      { id: issueId }
    );
    if (!issueData.issue) return;
    if (issueData.issue.state?.type === 'started') {
      log('WEBHOOK', `setIssueInProgress: ${issueId} already started, skip`);
      return;
    }
    const { id: uuid, team } = issueData.issue;
    const statesData = await linearQuery(
      'query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } }, type: { eq: "started" } }, first: 1) { nodes { id name } } }',
      { teamId: team.id }
    );
    const stateId = statesData.workflowStates?.nodes[0]?.id;
    if (!stateId) {
      log('WEBHOOK', `setIssueInProgress: no started state found for team ${team.id}`);
      return;
    }
    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: uuid, stateId }
    );
    log('WEBHOOK', `setIssueInProgress: ${issueId} updated to In Progress`);
  } catch (err) {
    log('ERROR', `setIssueInProgress failed: ${err.message}`, { issue: issueId });
  }
}

async function getIssueExecutionEligibility(issueId) {
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          archivedAt
          state { name type }
        }
      }
    `;
    const data = await linearQuery(query, { id: issueId });

    if (!data.issue) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'issue not found before run' };
    }

    const { archivedAt, state } = data.issue;

    if (archivedAt) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'archived issue before run' };
    }

    const isTerminal = ['completed', 'canceled', 'duplicate'].includes(state?.type)
      || ['Done', 'Canceled', 'Cancelled', 'Duplicate'].includes(state?.name);

    if (isTerminal) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'terminal state before run' };
    }

    return { eligible: true };
  } catch (err) {
    // Fail open: if Linear API is unavailable, allow execution to proceed
    log('ERROR', `getIssueExecutionEligibility failed: ${err.message}`, { issue: issueId });
    return { eligible: true };
  }
}

function triggerRun(issueId, options = {}) {
  // SECURITY: Pass issueId only via environment variable, never as shell argument
  const env = { ...process.env, WEBHOOK_ISSUE_ID: issueId };
  const projectRoot = path.join(__dirname, '..');
  const startedAt = new Date().toISOString();

  const args = ['scripts/ai/run_auto.sh'];
  if (options.resume) {
    args.push('--resume');
  }

  // detached: true puts child in its own process group (POSIX)
  const child = spawn('bash', args, {
    env,
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  log('RUNNER', `Spawned run_auto.sh for issueId=${issueId} pid=${child.pid} startedAt=${startedAt}${options.resume ? ' (resume)' : ''}`, { issue: issueId });

  let output = '';

  child.stdout.on('data', (data) => {
    const str = data.toString();
    output += str;
    log('RUN', str.trim(), { issue: issueId });
    process.stdout.write(`[RUN:${issueId}] ${str}`);
  });
  child.stderr.on('data', (data) => {
    const str = data.toString();
    output += str;
    log('RUN', `stderr: ${str.trim()}`, { issue: issueId });
    process.stderr.write(`[RUN:${issueId}] ${str}`);
  });

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      const endedAt = new Date().toISOString();
      if (signal) {
        log('RUNNER', `run_auto.sh terminated by signal=${signal} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      } else {
        log('RUNNER', `run_auto.sh exited code=${code} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      }
      resolve({ code: code ?? (signal ? 143 : 1), output });
    });
    child.on('error', (err) => {
      const endedAt = new Date().toISOString();
      log('RUNNER', `Failed to spawn run_auto.sh error=${err.message} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      resolve({ code: 1, output: err.message });
    });
  });
}

async function runItem(item) {
  const { issueId } = item;

  // Check current Linear state before executing
  const eligibility = await getIssueExecutionEligibility(issueId);
  if (!eligibility.eligible) {
    log('RUN', `skipped: ${eligibility.reason}`, { trigger: item.trigger || 'queue', issue: issueId });
    return;
  }

  const isResume = item.reason === 'usage_limit';
  if (isResume) {
    log('RESUME', 'issue-rerun start', { issue: issueId, retryAt: item.retryAt || null });
    log('RUN', 'start (resume)', { trigger: item.trigger || 'queue', issue: issueId });
  } else {
    log('RUN', 'start', { trigger: item.trigger || 'queue', issue: issueId });
  }

  const { code, output } = await triggerRun(issueId, { resume: isResume });

  if (code === 0) {
    const completion = await verifyTaskCompletion(issueId, output);
    if (completion.completed) {
      log('RUN', 'completed successfully', { trigger: item.trigger || 'queue', issue: issueId });
      clearUsageLimitCooldown();
      await removeUsageLimitLabel(issueId).catch(() => {});
    } else {
      log('RUNNER', `process exited 0 but task completion not verified: ${completion.reason} — skipping success cleanup`, { issue: issueId });
    }
  } else if (code === COMPLETION_UNVERIFIED) {
    log('RUNNER', `process exited ${COMPLETION_UNVERIFIED} (COMPLETION_UNVERIFIED) — skipping success cleanup`, { issue: issueId });
  } else if (code === SKIPPED_LOCKED) {
    log('RUNNER', 'SKIPPED_LOCKED received from run_auto.sh — re-enqueuing', { issue: issueId });
    enqueue(issueId, item.trigger || 'queue', null, {
      issueIdentifier: item.issueIdentifier || null,
      reason: 'lock_conflict',
      priority: item.priority ?? null,
      priorityLabel: item.priorityLabel ?? null,
      parentIssueId: item.parentIssueId ?? null,
      parentIssueIdentifier: item.parentIssueIdentifier ?? null,
      queueGroup: item.queueGroup ?? null,
      queueGroupOrder: item.queueGroupOrder ?? null
    });
  } else {
    const classification = classifyUsageLimit(output);
    if (classification.retryable && classification.retryAt) {
      log('RUN', `retryable limit detected: ${classification.type}`, { trigger: item.trigger || 'queue', issue: issueId });
      
      // Notify for session limits or API rate limits
      if (classification.type === 'session_limit' || classification.type === 'api_429') {
        const retryEpoch = Math.floor(new Date(classification.retryAt).getTime() / 1000);
        await notifyUsageLimitToAllActiveIssues(retryEpoch).catch(() => {});
      }

      setUsageLimitCooldownUntil(classification.retryAt, {
        issueId,
        issueIdentifier: item.issueIdentifier || null,
        resetAt: classification.resetAt,
        bufferSeconds: USAGE_LIMIT_RETRY_BUFFER_SECONDS,
        reason: 'usage_limit',
        limitType: classification.type
      });

      const gitInfo = getGitCheckpointInfo();
      const metadata = buildIssueRerunMetadata({
        issueId,
        stoppedReason: 'usage_limit',
        stoppedAt: new Date().toISOString(),
        resetAt: classification.resetAt,
        retryAt: classification.retryAt,
        branch: gitInfo.branch,
        lastCommit: gitInfo.lastCommit,
        gitStatus: gitInfo.gitStatus,
        previousRunLog: LOG_FILE,
        previousExitCode: code,
        nextActionHint: null
      });
      try {
        saveResumeMetadata(metadata);
      } catch (e) {
        log('ERROR', `saveResumeMetadata failed: ${e.message}`, { issue: issueId });
      }
      const queueLength = (loadQueue() || []).length;
      for (const line of formatResumeLogLines(metadata, { queueLength })) {
        log('RESUME', line.replace(/^\[RESUME\]\s*/, ''), { issue: issueId });
      }

      enqueue(issueId, item.trigger || 'queue', classification.retryAt, {
        issueIdentifier: item.issueIdentifier || null,
        reason: 'usage_limit',
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null,
        queueGroup: item.queueGroup ?? null,
        queueGroupOrder: item.queueGroupOrder ?? null
      });
      log('RETRY', 'scheduled', { trigger: item.trigger || 'queue', issue: issueId, retryAt: classification.retryAt });
    } else if (classification.type !== 'unknown') {
      log('RUN', `non-retryable limit: ${classification.type}`, { trigger: item.trigger || 'queue', issue: issueId });
      if (classification.type === 'context_limit') {
        log('RUN', 'summarization/compaction is required before resume', { issue: issueId });
      }
    } else {
      log('RUN', `failed exit=${code}`, { trigger: item.trigger || 'queue', issue: issueId });
    }
  }
}

async function drainQueue() {
  // Normalize queue to eliminate any duplicate issueId entries
  const normalizedQueue = normalizeQueue(loadQueue());
  saveQueue(normalizedQueue);

  // Prune expired items (TTL-based, with Linear confirmation)
  try {
    await pruneExpiredQueueItems();
  } catch (err) {
    log('QUEUE', `drainQueue: pruneExpiredQueueItems error (non-fatal): ${err.message}`);
  }

  let processedCount = 0;
  let item;
  let lastProcessedGroup = null;

  while (processedCount < MAX_DRAIN_ITEMS && (item = dequeue(lastProcessedGroup)) !== null) {
    // Skip items whose retryAt is in the future — put back and stop drain
    if (item.retryAt && new Date(item.retryAt) > new Date()) {
      enqueue(item.issueId, item.trigger, item.retryAt, {
        issueIdentifier: item.issueIdentifier || null,
        reason: item.reason || null,
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null,
        queueGroup: item.queueGroup ?? null,
        queueGroupOrder: item.queueGroupOrder ?? null
      });
      log('QUEUE', `drain: item ${item.issueId} has future retryAt=${item.retryAt}, stopping drain`);
      break;
    }

    // Revalidate issue state before executing
    const eligibility = await getIssueExecutionEligibility(item.issueId);
    if (!eligibility.eligible) {
      log('QUEUE', `drain: skipped issueId=${item.issueId} reason=${eligibility.reason}`, { issue: item.issueId });
      // Reset group tracking if skipped
      lastProcessedGroup = null;
      continue;
    }

    const remaining = loadQueue().length;
    log('QUEUE', `drain: starting issueId=${item.issueId}, queue remaining after this: ${remaining}`, { issue: item.issueId });

    const locked = acquireLock({ trigger: 'drain', issue: item.issueId });
    if (!locked) {
      log('QUEUE', 'drain: SKIPPED_LOCKED — re-enqueuing', { issue: item.issueId });
      enqueue(item.issueId, item.trigger || 'drain', null, {
        issueIdentifier: item.issueIdentifier || null,
        reason: 'lock_conflict',
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null,
        queueGroup: item.queueGroup ?? null,
        queueGroupOrder: item.queueGroupOrder ?? null
      });
      break;
    }
    try {
      addInflight(item.issueId);
      await runItem(item);
      processedCount++;
      // Track this item's issueId as the last processed group anchor for child issues
      lastProcessedGroup = item.issueId || item.issueIdentifier || null;
    } catch (err) {
      log('QUEUE', `drain error: ${err.message}`, { issue: item.issueId });
      lastProcessedGroup = null;
    } finally {
      removeInflight(item.issueId);
      releaseLock();
    }
  }

  if (processedCount >= MAX_DRAIN_ITEMS) {
    log('QUEUE', `drain: safety limit reached (${MAX_DRAIN_ITEMS} items). Stopping.`);
  } else {
    log('QUEUE', 'drain complete');
  }
}

module.exports = {
  SKIPPED_LOCKED,
  LOG_DIR,
  LOCK_FILE,
  QUEUE_FILE,
  COOLDOWN_FILE,
  USAGE_LIMIT_FILE,
  LOG_FILE,
  STALE_LOCK_MS,
  LINEAR_API_URL,
  USAGE_LIMIT_RETRY_BUFFER_SECONDS,
  MAX_DRAIN_ITEMS,
  QUEUE_ITEM_TTL_DAYS,
  INFLIGHT_FILE,
  log,
  linearQuery,
  acquireLock,
  releaseLock,
  isLocked,
  hasPendingIssues,
  fetchActiveIssues,
  postUsageLimitComment,
  buildUsageLimitCommentBody,
  addUsageLimitLabel,
  removeUsageLimitLabel,
  setUsageLimitCooldownUntil,
  clearUsageLimitCooldown,
  getUsageLimitCooldownUntil,
  notifyUsageLimitToAllActiveIssues,
  removeUsageLimitLabelFromAllIssues,
  loadQueue,
  saveQueue,
  normalizeQueue,
  syncQueueWithLinear,
  pruneExpiredQueueItems,
  enqueue,
  getPriorityRank,
  getIssueQueueMetadata,
  dequeue,
  removeFromQueue,
  isQueued,
  loadInflight,
  saveInflight,
  addInflight,
  removeInflight,
  isInflight,
  isQueuedOrRunning,
  setIssueInProgress,
  getIssueExecutionEligibility,
  triggerRun,
  runItem,
  drainQueue
};
