'use strict';

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getSecret } from './config/secrets.js';
import { spawn, execSync } from 'node:child_process';
import { classifyUsageLimit } from './lib/usageLimitParser.js';
import { buildIssueRerunMetadata, saveResumeMetadata, formatResumeLogLines } from './lib/resumeMetadata.js';
import * as queueOrdering from './lib/queueOrdering.js';
import { isTerminalState } from './lib/issueState.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RunResultType {
  TASK_COMPLETED: string;
  COMPLETION_UNVERIFIED: string;
  LOCK_CONFLICT: string;
  USAGE_LIMIT_RETRY: string;
  NON_RETRYABLE_LIMIT: string;
  FAILED: string;
}

const SKIPPED_LOCKED = 75;  // exit code when lock is not available
const COMPLETION_UNVERIFIED = 70; // exit code when process 0 but task not finished

const RUN_RESULT: RunResultType = {
  TASK_COMPLETED: 'TASK_COMPLETED',
  COMPLETION_UNVERIFIED: 'COMPLETION_UNVERIFIED',
  LOCK_CONFLICT: 'LOCK_CONFLICT',
  USAGE_LIMIT_RETRY: 'USAGE_LIMIT_RETRY',
  NON_RETRYABLE_LIMIT: 'NON_RETRYABLE_LIMIT',
  FAILED: 'FAILED'
};

interface CompletionResult {
  completed: boolean;
  reason?: string;
}

/**
 * Verifies if the task is actually completed even if the process exited with 0.
 */
async function verifyTaskCompletion(issueId: string, output: string): Promise<CompletionResult> {
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
    const data: any = await linearQuery(query, { id: issueId });

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
  } catch (err: any) {
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
const CURRENT_ISSUE_FILE = path.join(LOG_DIR, 'current-issue.json');

function log(tag: string, message: string, context: Record<string, any> = {}) {
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
  } catch (err: any) {
    console.error(`[RUNNER:LOG_ERROR] ${err.message}`);
  }
}

function acquireLock(context: Record<string, any> = {}): boolean {
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
    } catch (e: any) {
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
  } catch (err: any) {
    log('LOCK', `ERROR: ${err.message}`, context);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf8');
      const [pidStr] = content.split(':');
      if (parseInt(pidStr, 10) === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        log('LOCK', 'released');
      }
    }
  } catch (err: any) {
    log('LOCK', `release ERROR: ${err.message}`);
  }
}

interface GitCheckpointInfo {
  branch: string;
  lastCommit: string;
  gitStatus: string;
}

function getGitCheckpointInfo(): GitCheckpointInfo {
  const root = path.join(__dirname, '..');
  const result: GitCheckpointInfo = { branch: '', lastCommit: '', gitStatus: '' };
  try {
    result.branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', cwd: root }).trim();
    result.lastCommit = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: root }).trim();
    result.gitStatus = execSync('git status --short', { encoding: 'utf8', cwd: root }).trim();
  } catch (err) {
    // Silence errors, return empty strings as requested
  }
  return result;
}

function isLocked(): boolean {
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
    } catch (e: any) {
      return e.code !== 'ESRCH';
    }
  } catch (err) {
    return false;
  }
}

async function linearQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
  const apiKey = getSecret('LINEAR_API_KEY');
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

    const req = https.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.errors) {
            reject(new Error(json.errors[0].message));
          } else {
            resolve(json.data);
          }
        } catch (e: any) {
          reject(new Error(`Failed to parse Linear API response: ${e.message}`));
        }
      });
    });

    req.on('error', (err: any) => { reject(err); });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Linear API timeout'));
    });
    req.write(body);
    req.end();
  });
}

const getPriorityRank = queueOrdering.getPriorityRank;

export interface IssueQueueMetadata {
  id: string;
  identifier: string;
  title?: string | null;
  url?: string | null;
  priority: number | null;
  priorityLabel: string | null;
  priorityRank: number;
  parentIssueId: string | null;
  parentIssueIdentifier: string | null;
  stateType: string | null;
  stateName: string | null;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

async function getIssueQueueMetadata(issueId: string): Promise<IssueQueueMetadata | null> {
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
    const data: any = await linearQuery(query, { id: issueId });
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
  } catch (err: any) {
    log('RUNNER', `getIssueQueueMetadata failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

async function hasPendingIssues(): Promise<boolean> {
  try {
    const query = '{ issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: 1) { nodes { id } } }';
    const data: any = await linearQuery(query);
    return !!(data.issues?.nodes?.length > 0);
  } catch (err) {
    // Fail safe: don't block execution
    return false;
  }
}

async function fetchActiveIssues(first: number = 50): Promise<IssueQueueMetadata[]> {
  const query = `
    query($first: Int!) {
      issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: $first) {
        nodes {
          id
          identifier
          title
          url
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
  const data: any = await linearQuery(query, { first });
  return (data.issues?.nodes || [])
    .filter((issue: any) => !issue.archivedAt)
    .map((issue: any) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
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

function buildUsageLimitCommentBody(resetEpoch: number): string {
  const date = new Date(resetEpoch * 1000);
  const jstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const iso = jstDate.toISOString();
  const jstTime = `${iso.substring(0, 10)} ${iso.substring(11, 16)} JST`;
  return `usage-limit: Next auto run: ${jstTime}`;
}

async function postUsageLimitComment(issueId: string, resetEpoch: number): Promise<void> {
  try {
    const getIssue: any = await linearQuery('query($id: String!) { issue(id: $id) { id } }', { id: issueId });
    if (!getIssue.issue) return;
    const uuid = getIssue.issue.id;

    const body = buildUsageLimitCommentBody(resetEpoch);

    // Check for duplicate comment before posting
    let existingComments: any[] = [];
    try {
      const commentsData: any = await linearQuery(
        'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
        { id: uuid }
      );
      existingComments = commentsData.issue?.comments?.nodes || [];
    } catch (err: any) {
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
  } catch (err: any) {
    log('ERROR', `postUsageLimitComment failed: ${err.message}`, { issue: issueId });
  }
}

async function addUsageLimitLabel(issueId: string): Promise<void> {
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds team { id } } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds, team } = issueData.issue;
    const teamId = team.id;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    let labelId = labelsData.issueLabels.nodes[0]?.id;

    if (!labelId) {
      const createLabelData: any = await linearQuery(`
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
  } catch (err: any) {
    log('ERROR', `addUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

async function removeUsageLimitLabel(issueId: string): Promise<void> {
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds } = issueData.issue;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }');
    const labelId = labelsData.issueLabels.nodes[0]?.id;

    if (labelId && labelIds.includes(labelId)) {
      const filteredIds = labelIds.filter((id: string) => id !== labelId);
      await linearQuery(`
        mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) {
            success
          }
        }
      `, { id: uuid, labelIds: filteredIds });
    }
  } catch (err: any) {
    log('ERROR', `removeUsageLimitLabel failed: ${err.message}`, { issue: issueId });
  }
}

interface CooldownState {
  retryAt: string;
  issueId: string | null;
  issueIdentifier?: string | null;
  reason?: string | null;
  limitType?: string | null;
  active?: boolean;
}

interface CooldownOptions {
  issueId?: string | null;
  issueIdentifier?: string | null;
  resetAt?: string | null;
  bufferSeconds?: number;
  reason?: string;
  limitType?: string;
}

function setUsageLimitCooldownUntil(retryAt: string, issueIdOrOptions: string | CooldownOptions | null = null): void {
  // Accept both old signature (retryAt, issueId) and new (retryAt, { issueId, issueIdentifier, resetAt, bufferSeconds, reason, limitType })
  let issueId: string | null = null;
  let issueIdentifier: string | null = null;
  let resetAt: string | null = null;
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
  } catch (err: any) {
    log('ERROR', `setUsageLimitCooldownUntil failed: ${err.message}`);
  }
}

function clearUsageLimitCooldown(): void {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      fs.unlinkSync(COOLDOWN_FILE);
    }
    if (fs.existsSync(USAGE_LIMIT_FILE)) {
      fs.unlinkSync(USAGE_LIMIT_FILE);
    }
    log('RUNNER', 'usage limit cooldown cleared');
  } catch (err: any) {
    log('ERROR', `clearUsageLimitCooldown failed: ${err.message}`);
  }
}

function getUsageLimitCooldownUntil(nowMs: number = Date.now()): CooldownState | null {
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
    } catch (err: any) {
      log('ERROR', `getUsageLimitCooldownUntil: COOLDOWN_FILE parse failed: ${err.message}`);
      // Fall through to legacy file
    }
  }

  // Fall back to legacy USAGE_LIMIT_FILE
  try {
    if (!fs.existsSync(USAGE_LIMIT_FILE)) return null;
    const content = fs.readFileSync(USAGE_LIMIT_FILE, 'utf8');
    const state = JSON.parse(content);

    let retryAt: string | null = null;
    let issueId: string | null = null;
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
  } catch (err: any) {
    log('ERROR', `getUsageLimitCooldownUntil failed: ${err.message}`);
    return null;
  }
}

export interface QueueItem {
  issueId: string;
  issueIdentifier: string | null;
  trigger: string | null;
  retryAt: string | null;
  enqueuedAt: string;
  lastAttemptAt: string | null;
  attemptCount: number;
  reason: string | null;
  priority: number | null;
  priorityLabel: string | null;
  priorityRank: number;
  linearFetchedAt: string | null;
  parentIssueId: string | null;
  parentIssueIdentifier: string | null;
  queueGroup: string | null;
  queueGroupOrder: string | null;
}

function loadQueue(): QueueItem[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const content = fs.readFileSync(QUEUE_FILE, 'utf8');
    try {
      const queue = JSON.parse(content);
      return Array.isArray(queue) ? queue : [];
    } catch (parseErr: any) {
      const backupFile = QUEUE_FILE + '.corrupt.' + Date.now();
      try { fs.writeFileSync(backupFile, content); } catch (_) {}
      log('QUEUE', `loadQueue: JSON parse failed, backed up corrupt file to ${path.basename(backupFile)}: ${parseErr.message}`);
      return [];
    }
  } catch (err: any) {
    log('QUEUE', `loadQueue ERROR: ${err.message}`);
    return [];
  }
}

function normalizeQueue(queue: QueueItem[]): QueueItem[] {
  if (!Array.isArray(queue) || queue.length === 0) return [];

  const map = new Map<string, QueueItem>();
  for (const item of queue) {
    const issueId = item.issueId;
    if (!issueId) continue;

    if (!map.has(issueId)) {
      map.set(issueId, { ...item });
      continue;
    }

    const existing = map.get(issueId)!;

    // Merge retryAt: null (immediate) beats any future time; among two future times, earlier wins
    const existingRetryMs = existing.retryAt ? new Date(existing.retryAt).getTime() : null;
    const newRetryMs = item.retryAt ? new Date(item.retryAt).getTime() : null;
    let mergedRetryAt: string | null;
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

async function syncQueueWithLinear(): Promise<void> {
  const queue = loadQueue();
  if (queue.length === 0) return;

  const toRemove: string[] = [];
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
      const data: any = await linearQuery(query, { id: item.issueId });

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

      const isTerminal = isTerminalState(state);

      if (isTerminal) {
        log('QUEUE', `syncQueueWithLinear: removing terminal issue state=${state?.name}`, { issue: item.issueId });
        toRemove.push(item.issueId);
      }
    } catch (err: any) {
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

/**
 * Refreshes the priority of items already in the local queue from Linear's current state.
 *
 * Priority-only changes in Linear do NOT fire a webhook, so an issue bumped to High/Urgent after
 * it was enqueued would otherwise stay ordered on its stale enqueue-time priority. This re-stamps
 * each queued item's priority/priorityLabel/priorityRank with the latest Linear value so the next
 * dequeue() selects the genuinely highest-priority issue.
 *
 * Fail-open: on any error (e.g. Linear API failure) the queue is left untouched and execution is
 * never blocked. This only affects selection of the NEXT item — items already running under the
 * lock are not touched.
 */
async function refreshQueuePriorities(): Promise<void> {
  try {
    const queue = loadQueue();
    if (queue.length === 0) return;

    const active = await fetchActiveIssues();
    // Key by both identifier and id, since queue items store issueId as either.
    const byKey = new Map<string, { priority: number | null; priorityLabel: string | null }>();
    for (const issue of active) {
      const entry = { priority: issue.priority ?? null, priorityLabel: issue.priorityLabel ?? null };
      if (issue.identifier) byKey.set(issue.identifier, entry);
      if (issue.id) byKey.set(issue.id, entry);
    }

    const changed: string[] = [];
    for (const item of queue) {
      const fresh = item.issueId ? byKey.get(item.issueId) : undefined;
      if (!fresh) continue;
      const newRank = getPriorityRank(fresh.priority);
      const oldRank = item.priorityRank ?? getPriorityRank(item.priority);
      if (newRank !== oldRank || fresh.priority !== item.priority) {
        changed.push(`${item.issueId}:${oldRank}->${newRank}`);
        item.priority = fresh.priority;
        item.priorityLabel = fresh.priorityLabel;
        item.priorityRank = newRank;
      }
    }

    if (changed.length > 0) {
      saveQueue(queue);
      log('QUEUE', `refreshQueuePriorities: updated ${changed.length} item(s)`, { changed: changed.join(',') });
    }
  } catch (err: any) {
    log('QUEUE', `refreshQueuePriorities: error (fail-open, queue unchanged): ${err.message}`);
  }
}

async function pruneExpiredQueueItems(): Promise<void> {
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

  const toRemove: string[] = [];
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
      const data: any = await linearQuery(query, { id: item.issueId });

      if (!data.issue) {
        toRemove.push(item.issueId);
        continue;
      }
      const { archivedAt, state } = data.issue;
      if (archivedAt) {
        toRemove.push(item.issueId);
        continue;
      }
      const isTerminal = isTerminalState(state);
      if (isTerminal) {
        toRemove.push(item.issueId);
      }
      // Active issues older than TTL: keep in queue (do not blindly remove active issues)
    } catch (err: any) {
      log('QUEUE', `pruneExpiredQueueItems: API error for ${item.issueId}, skip: ${err.message}`);
    }
  }

  if (toRemove.length > 0) {
    const cleaned = loadQueue().filter(item => !toRemove.includes(item.issueId));
    saveQueue(cleaned);
    log('QUEUE', `pruneExpiredQueueItems: removed ${toRemove.length} expired item(s)`, { removed: toRemove.join(',') });
  }
}

function saveQueue(queue: QueueItem[]): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    const tmpFile = QUEUE_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(queue, null, 2));
    fs.renameSync(tmpFile, QUEUE_FILE);
  } catch (err: any) {
    log('QUEUE', `save ERROR: ${err.message}`);
  }
}

interface EnqueueOptions {
  issueIdentifier?: string | null;
  reason?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  parentIssueId?: string | null;
  parentIssueIdentifier?: string | null;
  queueGroup?: string | null;
  queueGroupOrder?: string | null;
}

function enqueue(issueId: string, trigger: string | null, retryAt: string | null = null, {
  issueIdentifier = null,
  reason = null,
  priority = null,
  priorityLabel = null,
  parentIssueId = null,
  parentIssueIdentifier = null,
  queueGroup = null,
  queueGroupOrder = null
}: EnqueueOptions = {}): void {
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
      let mergedRetryAt: string | null;
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
  } catch (err: any) {
    log('QUEUE', `enqueue ERROR: ${err.message}`, { issue: issueId });
  }
}

function dequeue(lastProcessedGroup: string | null = null): QueueItem | null {
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
  } catch (err: any) {
    log('QUEUE', `dequeue ERROR: ${err.message}`);
    return null;
  }
}

function removeFromQueue(issueId: string): void {
  try {
    const queue = loadQueue();
    const filtered = queue.filter(item => item.issueId !== issueId);
    if (filtered.length !== queue.length) {
      saveQueue(filtered);
      log('QUEUE', 'removed', { issue: issueId });
    }
  } catch (err: any) {
    log('QUEUE', `removeFromQueue ERROR: ${err.message}`, { issue: issueId });
  }
}

function isQueued(issueId: string): boolean {
  const queue = loadQueue();
  return queue.some(item => item.issueId === issueId);
}

function loadInflight(): string[] {
  try {
    if (!fs.existsSync(INFLIGHT_FILE)) return [];
    const content = fs.readFileSync(INFLIGHT_FILE, 'utf8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveInflight(list: string[]): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = INFLIGHT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, INFLIGHT_FILE);
  } catch (err: any) {
    log('RUNNER', `saveInflight ERROR: ${err.message}`);
  }
}

function setCurrentIssue(item: QueueItem): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const data = {
      issueId: item.issueId,
      issueIdentifier: item.issueIdentifier,
      startedAt: new Date().toISOString()
    };
    const tmp = CURRENT_ISSUE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CURRENT_ISSUE_FILE);
  } catch (err: any) {
    log('RUNNER', `setCurrentIssue ERROR: ${err.message}`);
  }
}

function clearCurrentIssue(): void {
  try {
    if (fs.existsSync(CURRENT_ISSUE_FILE)) {
      fs.unlinkSync(CURRENT_ISSUE_FILE);
    }
  } catch (err: any) {
    log('RUNNER', `clearCurrentIssue ERROR: ${err.message}`);
  }
}

function getCurrentIssue(): { issueId: string; issueIdentifier?: string; startedAt: string } | null {
  try {
    if (!fs.existsSync(CURRENT_ISSUE_FILE)) return null;
    const content = fs.readFileSync(CURRENT_ISSUE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (err: any) {
    return null;
  }
}

function addInflight(issueId: string): void {
  const list = loadInflight();
  if (!list.includes(issueId)) {
    list.push(issueId);
    saveInflight(list);
  }
}

function removeInflight(issueId: string): void {
  const list = loadInflight().filter(id => id !== issueId);
  saveInflight(list);
}

function isInflight(issueId: string): boolean {
  return loadInflight().includes(issueId);
}

function isQueuedOrRunning(issueId: string): boolean {
  return isQueued(issueId) || isInflight(issueId);
}

async function notifyUsageLimitToAllActiveIssues(epochSeconds: number): Promise<void> {
  try {
    const data: any = await linearQuery(
      '{ issues(filter: { state: { type: { in: ["unstarted","started"] } } }, first: 50) { nodes { id } } }'
    );
    const issues = data.issues?.nodes || [];
    for (const issue of issues) {
      await postUsageLimitComment(issue.id, epochSeconds).catch(() => {});
      await addUsageLimitLabel(issue.id).catch(() => {});
    }
    log('RUNNER', `notifyUsageLimitToAllActiveIssues done for ${issues.length} issue(s)`);
  } catch (err: any) {
    log('ERROR', `notifyUsageLimitToAllActiveIssues failed: ${err.message}`);
  }
}

async function removeUsageLimitLabelFromAllIssues(): Promise<void> {
  try {
    const labelsData: any = await linearQuery(
      'query { issueLabels(filter: { name: { eq: "usage-limit" } }) { nodes { id } } }'
    );
    const labelId = labelsData.issueLabels.nodes[0]?.id;
    if (!labelId) {
      log('RUNNER', 'removeUsageLimitLabelFromAllIssues: no usage-limit label found');
      return;
    }
    const issueData: any = await linearQuery(
      `{ issues(filter: { labels: { id: { eq: "${labelId}" } } }, first: 50) { nodes { id labelIds } } }`
    );
    const issues = issueData.issues?.nodes || [];
    for (const issue of issues) {
      await removeUsageLimitLabel(issue.id).catch(() => {});
    }
    log('RUNNER', `removeUsageLimitLabelFromAllIssues done for ${issues.length} issue(s)`);
  } catch (err: any) {
    log('ERROR', `removeUsageLimitLabelFromAllIssues failed: ${err.message}`);
  }
}

async function setIssueInProgress(issueId: string): Promise<void> {
  try {
    const issueData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { id state { type } team { id } } }',
      { id: issueId }
    );
    if (!issueData.issue) return;
    if (issueData.issue.state?.type === 'started') {
      log('WEBHOOK', `setIssueInProgress: ${issueId} already started, skip`);
      return;
    }
    const { id: uuid, team } = issueData.issue;
    const statesData: any = await linearQuery(
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
  } catch (err: any) {
    log('ERROR', `setIssueInProgress failed: ${err.message}`, { issue: issueId });
  }
}

interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

async function getIssueExecutionEligibility(issueId: string): Promise<EligibilityResult> {
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
    const data: any = await linearQuery(query, { id: issueId });

    if (!data.issue) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'issue not found before run' };
    }

    const { archivedAt, state } = data.issue;

    if (archivedAt) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'archived issue before run' };
    }

    const isTerminal = isTerminalState(state);

    if (isTerminal) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'terminal state before run' };
    }

    return { eligible: true };
  } catch (err: any) {
    // Fail open: if Linear API is unavailable, allow execution to proceed
    log('ERROR', `getIssueExecutionEligibility failed: ${err.message}`, { issue: issueId });
    return { eligible: true };
  }
}

interface TriggerOptions {
  resume?: boolean;
}

interface TriggerResult {
  code: number;
  output: string;
}

function triggerRun(issueId: string, options: TriggerOptions = {}): Promise<TriggerResult> {
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

  child.stdout.on('data', (data: any) => {
    const str = data.toString();
    output += str;
    log('RUN', str.trim(), { issue: issueId });
    process.stdout.write(`[RUN:${issueId}] ${str}`);
  });
  child.stderr.on('data', (data: any) => {
    const str = data.toString();
    output += str;
    log('RUN', `stderr: ${str.trim()}`, { issue: issueId });
    process.stderr.write(`[RUN:${issueId}] ${str}`);
  });

  return new Promise((resolve) => {
    child.on('close', (code: number | null, signal: string | null) => {
      const endedAt = new Date().toISOString();
      if (signal) {
        log('RUNNER', `run_auto.sh terminated by signal=${signal} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      } else {
        log('RUNNER', `run_auto.sh exited code=${code} pid=${child.pid} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      }
      resolve({ code: code ?? (signal ? 143 : 1), output });
    });
    child.on('error', (err: any) => {
      const endedAt = new Date().toISOString();
      log('RUNNER', `Failed to spawn run_auto.sh error=${err.message} startedAt=${startedAt} endedAt=${endedAt}`, { issue: issueId });
      resolve({ code: 1, output: err.message });
    });
  });
}

interface ClassifyRunArgs {
  code: number;
  output: string;
  completion: CompletionResult | null;
}

interface ClassifyRunResult {
  kind: string;
  code: number;
  completion?: CompletionResult;
  classification?: any;
  reason?: string;
}

/**
 * triggerRun のプロセス結果(code/output)とタスク完了検証結果(completion)から、
 * run result 種別を構造化して返す純粋関数。副作用なし。
 */
function classifyRunResult({ code, output, completion }: ClassifyRunArgs): ClassifyRunResult {
  if (code === 0) {
    if (completion && completion.completed) {
      return { kind: RUN_RESULT.TASK_COMPLETED, code, completion };
    }
    return { kind: RUN_RESULT.COMPLETION_UNVERIFIED, code, reason: completion ? completion.reason : undefined };
  }
  if (code === COMPLETION_UNVERIFIED) {
    return { kind: RUN_RESULT.COMPLETION_UNVERIFIED, code };
  }
  if (code === SKIPPED_LOCKED) {
    return { kind: RUN_RESULT.LOCK_CONFLICT, code };
  }
  const classification = classifyUsageLimit(output);
  if (classification.retryable && classification.retryAt) {
    return { kind: RUN_RESULT.USAGE_LIMIT_RETRY, code, classification };
  }
  if (classification.type !== 'unknown') {
    return { kind: RUN_RESULT.NON_RETRYABLE_LIMIT, code, classification };
  }
  return { kind: RUN_RESULT.FAILED, code, classification };
}

async function runItem(item: QueueItem): Promise<void> {
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
  const completion = code === 0 ? await verifyTaskCompletion(issueId, output) : null;
  const result = classifyRunResult({ code, output, completion });

  switch (result.kind) {
    case RUN_RESULT.TASK_COMPLETED:
      log('RUN', 'completed successfully', { trigger: item.trigger || 'queue', issue: issueId });
      clearUsageLimitCooldown();
      await removeUsageLimitLabel(issueId).catch(() => {});
      break;

    case RUN_RESULT.COMPLETION_UNVERIFIED:
      if (result.code === 0) {
        log('RUNNER', `process exited 0 but task completion not verified: ${result.reason} — skipping success cleanup`, { issue: issueId });
      } else {
        log('RUNNER', `process exited ${COMPLETION_UNVERIFIED} (COMPLETION_UNVERIFIED) — skipping success cleanup`, { issue: issueId });
      }
      break;

    case RUN_RESULT.LOCK_CONFLICT:
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
      break;

    case RUN_RESULT.USAGE_LIMIT_RETRY: {
      const { classification } = result;
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
        previousExitCode: result.code,
        nextActionHint: null
      });
      try {
        saveResumeMetadata(metadata);
      } catch (e: any) {
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
      break;
    }

    case RUN_RESULT.NON_RETRYABLE_LIMIT:
      log('RUN', `non-retryable limit: ${result.classification.type}`, { trigger: item.trigger || 'queue', issue: issueId });
      if (result.classification.type === 'context_limit') {
        log('RUN', 'summarization/compaction is required before resume', { issue: issueId });
      }
      break;

    case RUN_RESULT.FAILED:
    default:
      log('RUN', `failed exit=${result.code}`, { trigger: item.trigger || 'queue', issue: issueId });
      break;
  }
}

async function drainQueue(): Promise<void> {
  // Normalize queue to eliminate any duplicate issueId entries
  const normalizedQueue = normalizeQueue(loadQueue());
  saveQueue(normalizedQueue);

  // Prune expired items (TTL-based, with Linear confirmation)
  try {
    await pruneExpiredQueueItems();
  } catch (err: any) {
    log('QUEUE', `drainQueue: pruneExpiredQueueItems error (non-fatal): ${err.message}`);
  }

  // Refresh queued items' priority from Linear before selecting — priority-only changes do not
  // fire a webhook, so this ensures the highest-priority issue is dequeued first.
  try {
    await refreshQueuePriorities();
  } catch (err: any) {
    log('QUEUE', `drainQueue: refreshQueuePriorities error (non-fatal): ${err.message}`);
  }

  let processedCount = 0;
  let item: QueueItem | null;
  let lastProcessedGroup: string | null = null;

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
      setCurrentIssue(item);
      await runItem(item);
      processedCount++;
      // Track this item's issueId as the last processed group anchor for child issues
      lastProcessedGroup = item.issueId || item.issueIdentifier || null;
    } catch (err: any) {
      log('QUEUE', `drain error: ${err.message}`, { issue: item.issueId });
      lastProcessedGroup = null;
    } finally {
      clearCurrentIssue();
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

export {
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
  refreshQueuePriorities,
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
  getCurrentIssue,
  setIssueInProgress,
  getIssueExecutionEligibility,
  triggerRun,
  runItem,
  drainQueue,
  RUN_RESULT,
  classifyRunResult
};
