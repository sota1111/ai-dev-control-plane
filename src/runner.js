const fs = require('fs');
const path = require('path');
const https = require('https');

const SKIPPED_LOCKED = 75;  // exit code when lock is not available
const LOG_DIR = path.join(__dirname, '..', 'docs', 'ai', 'auto_logs');
const LOCK_FILE = path.join(LOG_DIR, 'runner.lock');
const QUEUE_FILE = path.join(LOG_DIR, 'runner.queue.json');
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

async function postUsageLimitComment(issueId, resetEpoch) {
  try {
    const getIssue = await linearQuery('query($id: String!) { issue(id: $id) { id } }', { id: issueId });
    if (!getIssue.issue) return;
    const uuid = getIssue.issue.id;

    const date = new Date(resetEpoch * 1000);
    const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
    const iso = jstDate.toISOString();
    const jstTime = `${iso.substring(0, 10)} ${iso.substring(11, 16)} JST`;

    await linearQuery(`
      mutation($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
        }
      }
    `, { issueId: uuid, body: `usage-limit: Next auto run: ${jstTime}` });
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

function loadQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const content = fs.readFileSync(QUEUE_FILE, 'utf8');
    const queue = JSON.parse(content);
    return Array.isArray(queue) ? queue : [];
  } catch (err) {
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

function enqueue(issueId, trigger, retryAt = null) {
  try {
    const queue = loadQueue();
    if (queue.some(item => item.issueId === issueId)) {
      return;
    }
    queue.push({
      issueId,
      trigger,
      enqueuedAt: new Date().toISOString(),
      retryAt
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
    const index = queue.findIndex(item => !item.retryAt || new Date(item.retryAt) <= now);
    
    if (index === -1) return null;

    const [item] = queue.splice(index, 1);
    saveQueue(queue);
    log('QUEUE', 'dequeued', { issue: item.issueId });
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

module.exports = {
  SKIPPED_LOCKED,
  LOG_DIR,
  LOCK_FILE,
  QUEUE_FILE,
  LOG_FILE,
  STALE_LOCK_MS,
  LINEAR_API_URL,
  log,
  acquireLock,
  releaseLock,
  hasPendingIssues,
  postUsageLimitComment,
  addUsageLimitLabel,
  removeUsageLimitLabel,
  loadQueue,
  saveQueue,
  enqueue,
  dequeue,
  removeFromQueue,
  isQueued
};
