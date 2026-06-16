const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { parseUsageLimitResetEpoch } = require('./lib/usageLimitParser');

const SKIPPED_LOCKED = 75;  // exit code when lock is not available
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

function getPriorityRank(priority) {
  if (priority === 1) return 1; // Urgent
  if (priority === 2) return 2; // High
  if (priority === 3) return 3; // Medium
  if (priority === 4) return 4; // Low
  return 5; // No priority (0), null, undefined, or invalid value
}

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
  // Accept both old signature (retryAt, issueId) and new (retryAt, { issueId, issueIdentifier, resetAt, bufferSeconds })
  let issueId = null;
  let issueIdentifier = null;
  let resetAt = null;
  let bufferSeconds = USAGE_LIMIT_RETRY_BUFFER_SECONDS;

  if (typeof issueIdOrOptions === 'string') {
    issueId = issueIdOrOptions; // backward compat
  } else if (issueIdOrOptions && typeof issueIdOrOptions === 'object') {
    issueId = issueIdOrOptions.issueId || null;
    issueIdentifier = issueIdOrOptions.issueIdentifier || null;
    resetAt = issueIdOrOptions.resetAt || null;
    bufferSeconds = issueIdOrOptions.bufferSeconds != null ? issueIdOrOptions.bufferSeconds : USAGE_LIMIT_RETRY_BUFFER_SECONDS;
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
      bufferSeconds: bufferSeconds
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
  parentIssueIdentifier = null
} = {}) {
  try {
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
      parentIssueIdentifier: parentIssueIdentifier ?? null
    });
    saveQueue(queue);
    log('QUEUE', 'enqueued', { issue: issueId, trigger });
  } catch (err) {
    log('QUEUE', `enqueue ERROR: ${err.message}`, { issue: issueId });
  }
}

function dequeue() {
  try {
    const queue = loadQueue();
    const now = new Date();

    // Filter to ready items (retryAt null or in the past)
    const readyIndices = queue.reduce((acc, item, i) => {
      if (!item.retryAt || new Date(item.retryAt) <= now) acc.push(i);
      return acc;
    }, []);

    if (readyIndices.length === 0) return null;

    // Select item with best priority (lowest rank), tie-break by retryAt then enqueuedAt
    let bestIndex = readyIndices[0];
    for (const i of readyIndices.slice(1)) {
      const best = queue[bestIndex];
      const candidate = queue[i];
      const bestRank = best.priorityRank != null ? best.priorityRank : getPriorityRank(best.priority);
      const candidateRank = candidate.priorityRank != null ? candidate.priorityRank : getPriorityRank(candidate.priority);

      if (candidateRank < bestRank) {
        bestIndex = i;
        continue;
      }
      if (candidateRank > bestRank) continue;

      // Same rank: compare retryAt (null = immediate = wins, treated as -Infinity)
      const bestRetryMs = best.retryAt ? new Date(best.retryAt).getTime() : -Infinity;
      const candidateRetryMs = candidate.retryAt ? new Date(candidate.retryAt).getTime() : -Infinity;
      if (candidateRetryMs < bestRetryMs) {
        bestIndex = i;
        continue;
      }
      if (candidateRetryMs > bestRetryMs) continue;

      // Same retryAt: compare enqueuedAt (earlier wins)
      const bestEnqueuedMs = best.enqueuedAt ? new Date(best.enqueuedAt).getTime() : 0;
      const candidateEnqueuedMs = candidate.enqueuedAt ? new Date(candidate.enqueuedAt).getTime() : 0;
      if (candidateEnqueuedMs < bestEnqueuedMs) {
        bestIndex = i;
      }
    }

    const [item] = queue.splice(bestIndex, 1);
    saveQueue(queue);
    log('QUEUE', 'dequeued', { issue: item.issueId, priorityRank: item.priorityRank != null ? item.priorityRank : 5 });
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

function triggerRun(issueId) {
  // SECURITY: Pass issueId only via environment variable, never as shell argument
  const env = { ...process.env, WEBHOOK_ISSUE_ID: issueId };
  const projectRoot = path.join(__dirname, '..');
  const startedAt = new Date().toISOString();

  // detached: true puts child in its own process group (POSIX)
  const child = spawn('bash', ['scripts/ai/run_auto.sh'], {
    env,
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  log('RUNNER', `Spawned run_auto.sh for issueId=${issueId} pid=${child.pid} startedAt=${startedAt}`, { issue: issueId });

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

  log('RUN', 'start', { trigger: item.trigger || 'queue', issue: issueId });
  const { code, output } = await triggerRun(issueId);

  if (code === 0) {
    log('RUN', 'completed successfully', { trigger: item.trigger || 'queue', issue: issueId });
    clearUsageLimitCooldown();
    await removeUsageLimitLabel(issueId).catch(() => {});
  } else if (code === SKIPPED_LOCKED) {
    log('RUNNER', 'SKIPPED_LOCKED received from run_auto.sh — re-enqueuing', { issue: issueId });
    enqueue(issueId, item.trigger || 'queue', null, {
      issueIdentifier: item.issueIdentifier || null,
      reason: 'lock_conflict',
      priority: item.priority ?? null,
      priorityLabel: item.priorityLabel ?? null,
      parentIssueId: item.parentIssueId ?? null,
      parentIssueIdentifier: item.parentIssueIdentifier ?? null
    });
  } else {
    const resetEpoch = parseUsageLimitResetEpoch(output);
    if (resetEpoch !== null) {
      log('RUN', 'usage limit detected', { trigger: item.trigger || 'queue', issue: issueId });
      await notifyUsageLimitToAllActiveIssues(resetEpoch).catch(() => {});
      const resetAt = new Date(resetEpoch * 1000).toISOString();
      const retryAt = new Date((resetEpoch + USAGE_LIMIT_RETRY_BUFFER_SECONDS) * 1000).toISOString();
      setUsageLimitCooldownUntil(retryAt, {
        issueId,
        issueIdentifier: item.issueIdentifier || null,
        resetAt,
        bufferSeconds: USAGE_LIMIT_RETRY_BUFFER_SECONDS
      });
      enqueue(issueId, item.trigger || 'queue', retryAt, {
        issueIdentifier: item.issueIdentifier || null,
        reason: 'usage_limit',
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null
      });
      log('RETRY', 'scheduled', { trigger: item.trigger || 'queue', issue: issueId, retryAt });
    } else {
      log('RUN', `failed exit=${code}`, { trigger: item.trigger || 'queue', issue: issueId });
    }
  }
}

async function drainQueue() {
  let processedCount = 0;
  let item;

  while (processedCount < MAX_DRAIN_ITEMS && (item = dequeue()) !== null) {
    // Skip items whose retryAt is in the future — put back and stop drain
    if (item.retryAt && new Date(item.retryAt) > new Date()) {
      enqueue(item.issueId, item.trigger, item.retryAt, {
        issueIdentifier: item.issueIdentifier || null,
        reason: item.reason || null,
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null
      });
      log('QUEUE', `drain: item ${item.issueId} has future retryAt=${item.retryAt}, stopping drain`);
      break;
    }

    // Revalidate issue state before executing
    const eligibility = await getIssueExecutionEligibility(item.issueId);
    if (!eligibility.eligible) {
      log('QUEUE', `drain: skipped issueId=${item.issueId} reason=${eligibility.reason}`, { issue: item.issueId });
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
        parentIssueIdentifier: item.parentIssueIdentifier ?? null
      });
      break;
    }
    try {
      await runItem(item);
      processedCount++;
    } catch (err) {
      log('QUEUE', `drain error: ${err.message}`, { issue: item.issueId });
    } finally {
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
  log,
  linearQuery,
  acquireLock,
  releaseLock,
  isLocked,
  hasPendingIssues,
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
  enqueue,
  getPriorityRank,
  getIssueQueueMetadata,
  dequeue,
  removeFromQueue,
  isQueued,
  setIssueInProgress,
  getIssueExecutionEligibility,
  triggerRun,
  runItem,
  drainQueue
};
