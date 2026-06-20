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
import { isTerminalState, isHoldState } from './lib/issueState.js';
import { resolveRepoForProject } from './lib/projectRepo.js';
import { notifyDetachedLaunched, notifyDetachedCompleted, DetachedOutcome } from './lib/laneNotifier.js';
import {
  isNewProject,
  deriveNewRepoName,
  ensureRepoForNewProject,
} from './lib/projectRepoCreate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface RunResultType {
  TASK_COMPLETED: string;
  COMPLETION_UNVERIFIED: string;
  LOCK_CONFLICT: string;
  USAGE_LIMIT_RETRY: string;
  NON_RETRYABLE_LIMIT: string;
  FAILED: string;
  DETACHED: string;
}

const SKIPPED_LOCKED = 75;  // exit code when lock is not available
const COMPLETION_UNVERIFIED = 70; // exit code when process 0 but task not finished

const RUN_RESULT: RunResultType = {
  TASK_COMPLETED: 'TASK_COMPLETED',
  COMPLETION_UNVERIFIED: 'COMPLETION_UNVERIFIED',
  LOCK_CONFLICT: 'LOCK_CONFLICT',
  USAGE_LIMIT_RETRY: 'USAGE_LIMIT_RETRY',
  NON_RETRYABLE_LIMIT: 'NON_RETRYABLE_LIMIT',
  FAILED: 'FAILED',
  DETACHED: 'DETACHED'
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

// Lane support (SOT-913): the lock/queue paths can be split per lane (repo/レーン) so
// that detached/parallel drain (SOT-911 案②) can run without sharing a single lock/queue.
// The default lane keeps the historical paths (runner.lock / runner.queue.json) for
// backward compatibility; a non-default lane gets independent, lane-suffixed paths.
const DEFAULT_LANE = 'default';

// Serialization scope (SOT-931, 案A switch). The write-side serialization granularity is
// switchable between two modes, controlled by `RUNNER_SERIALIZE_SCOPE`:
//   - 'repo'   (default, current behavior): すべての同一 repo の Issue が同一 lane を共有 → 直列。
//   - 'branch': 同一 branch だけ直列／別 branch は別 lane（別 lock/queue）で並行可。
// The default keeps the historical "同一 repo は直列" guarantee. The scope only affects how the
// lane key is DERIVED (serializationLaneKey); the lock/queue separation machinery is unchanged.
const SERIALIZE_SCOPE_REPO = 'repo';
const SERIALIZE_SCOPE_BRANCH = 'branch';

/** Sanitize an arbitrary token to the lane-safe charset `[a-zA-Z0-9_-]`. */
function sanitizeLaneToken(raw?: string | null): string {
  return (raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

/**
 * Resolve the active serialization scope. Reads `RUNNER_SERIALIZE_SCOPE` from the given env
 * (or `process.env`); anything other than the explicit 'branch' value maps to 'repo' so the
 * default stays the backward-compatible per-repo serialization.
 */
function resolveSerializeScope(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.RUNNER_SERIALIZE_SCOPE || '').trim().toLowerCase();
  return raw === SERIALIZE_SCOPE_BRANCH ? SERIALIZE_SCOPE_BRANCH : SERIALIZE_SCOPE_REPO;
}

/**
 * Derive the serialization lane key for a unit of work from its repo and branch, under the
 * active scope. This is the SOT-931 switch primitive:
 *   - scope 'repo'   → lane = sanitized repo (同一 repo の全 branch が同一 lane = 直列).
 *   - scope 'branch' → lane = sanitized `${repo}--${branch}` (別 branch は別 lane = 並行可、同一 branch は直列).
 * Empty repo (unknown target) maps to DEFAULT_LANE so existing single-lane behavior is preserved.
 */
function serializationLaneKey(
  opts: { repo?: string | null; branch?: string | null; scope?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): string {
  const scope = opts.scope || resolveSerializeScope(env);
  const repo = sanitizeLaneToken(opts.repo);
  if (!repo) return DEFAULT_LANE;
  if (scope === SERIALIZE_SCOPE_BRANCH) {
    const branch = sanitizeLaneToken(opts.branch);
    return branch ? `${repo}--${branch}` : repo;
  }
  return repo;
}

/**
 * Resolve the runner lane. Accepts an explicit lane string, an env object, or
 * (when omitted) reads from `process.env`. Precedence:
 *   1. An explicit non-default `RUNNER_LANE` (or string arg) always wins — preserves the
 *      externally-assigned per-repo lane behavior (SOT-913) and backward compatibility.
 *   2. Otherwise, under `RUNNER_SERIALIZE_SCOPE=branch`, the lane is derived from
 *      `RUNNER_REPO` / `RUNNER_BRANCH` via serializationLaneKey so 別 branch は別 lane で並行可。
 *   3. Otherwise → DEFAULT_LANE (同一 repo 直列, current behavior).
 * The lane is sanitized to `[a-zA-Z0-9_-]` so it can never escape LOG_DIR.
 */
function resolveLane(laneOrEnv?: string | NodeJS.ProcessEnv): string {
  let env: NodeJS.ProcessEnv = process.env;
  let raw: string | undefined;
  if (typeof laneOrEnv === 'string') {
    raw = laneOrEnv;
  } else if (laneOrEnv && typeof laneOrEnv === 'object') {
    env = laneOrEnv;
    raw = laneOrEnv.RUNNER_LANE;
  } else {
    raw = process.env.RUNNER_LANE;
  }
  const explicit = sanitizeLaneToken(raw);
  if (explicit && explicit !== DEFAULT_LANE) {
    return explicit;
  }
  // No explicit lane: under branch scope, derive a per-branch lane from RUNNER_REPO/RUNNER_BRANCH.
  if (resolveSerializeScope(env) === SERIALIZE_SCOPE_BRANCH) {
    const derived = serializationLaneKey(
      { repo: env.RUNNER_REPO, branch: env.RUNNER_BRANCH, scope: SERIALIZE_SCOPE_BRANCH },
      env
    );
    if (derived !== DEFAULT_LANE) return derived;
  }
  return DEFAULT_LANE;
}

/** Lock file path for a given lane (default lane → historical `runner.lock`). */
function laneLockFile(lane?: string): string {
  const l = resolveLane(lane);
  return path.join(LOG_DIR, l === DEFAULT_LANE ? 'runner.lock' : `runner.${l}.lock`);
}

/** Queue file path for a given lane (default lane → historical `runner.queue.json`). */
function laneQueueFile(lane?: string): string {
  const l = resolveLane(lane);
  return path.join(LOG_DIR, l === DEFAULT_LANE ? 'runner.queue.json' : `runner.${l}.queue.json`);
}

const LOCK_FILE = laneLockFile();
const QUEUE_FILE = laneQueueFile();
const HISTORY_FILE = path.join(LOG_DIR, 'runner.queue.history.json');
const MAX_QUEUE_HISTORY = 50;  // cap on persisted past-queue (dequeued) entries
const USAGE_LIMIT_FILE = path.join(LOG_DIR, 'runner.usage-limit.json');
const COOLDOWN_FILE = path.join(LOG_DIR, 'runner.cooldown.json');
const USAGE_LIMIT_RETRY_BUFFER_SECONDS = parseInt(process.env.USAGE_LIMIT_RETRY_BUFFER_SECONDS || '600', 10);
const MAX_DRAIN_ITEMS = 20;  // safety guard against infinite drain loops
// run_auto.sh のOS flock（同時に1プロセスのみ）を別の実行が保持しているとき、
// drain から起動した run_auto.sh は exit 75 を返す。グローバルロックなので他のキュー項目も
// 同様に弾かれる。即時 null 再投入だと drain が同一Issueを MAX_DRAIN_ITEMS 回連打して
// コンソールを溢れさせるため、この秒数だけ retryAt バックオフを付けて再投入し drain を止める。
const LOCK_CONFLICT_BACKOFF_MS = parseInt(process.env.LOCK_CONFLICT_BACKOFF_MS || '60000', 10);
const LOG_FILE = path.join(LOG_DIR, 'auto_runner.log');
const STALE_LOCK_MS = 30 * 60 * 1000;  // 30 minutes
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const QUEUE_ITEM_TTL_DAYS = parseInt(process.env.QUEUE_ITEM_TTL_DAYS || '7', 10);
const INFLIGHT_FILE = path.join(LOG_DIR, 'runner.inflight.json');
const CURRENT_ISSUE_FILE = path.join(LOG_DIR, 'current-issue.json');
// Leaked inflight entries (process crashed without cleanup) older than this are reaped.
const INFLIGHT_TTL_MS = parseInt(process.env.INFLIGHT_TTL_MS || String(2 * 60 * 60 * 1000), 10); // 2 hours
// long-run detached execution (SOT-914 / SOT-911 案②): issues carrying this Linear label are
// launched detached so the JS lock is released immediately (lock hold ≈ startup time, not sim time).
const LONG_RUN_LABEL = process.env.LONG_RUN_LABEL || 'long-run';
// Per-issue sentinel files for in-flight detached runs ({ issueId, pid, startedAt }).
const DETACHED_DIR = path.join(LOG_DIR, 'detached');

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

// Unconditionally remove the runner lock regardless of which PID owns it.
// Used by the Discord /recover force path to break a wedged lock held by a
// hung/alive holder (acquireLock already auto-reclaims dead/stale locks, so this
// is only needed for the "alive but stuck" case). Returns the removed lock's raw
// content (pid:timestamp) or null if no lock existed. Safe because run_auto.sh's
// OS-level flock still serializes the heavy claude runs even if this JS lock is broken.
function forceReleaseLock(): string | null {
  try {
    if (!fs.existsSync(LOCK_FILE)) return null;
    const content = fs.readFileSync(LOCK_FILE, 'utf8');
    fs.unlinkSync(LOCK_FILE);
    log('LOCK', `force-released (was: ${content})`);
    return content;
  } catch (err: any) {
    log('LOCK', `forceReleaseLock ERROR: ${err.message}`);
    return null;
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

// Linear issue が属するプロジェクト名を取得する。取得不能・未設定時は null（never throws）。
async function getIssueProjectName(issueId: string): Promise<string | null> {
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { project { name } } }',
      { id: issueId }
    );
    const name = data?.issue?.project?.name;
    return typeof name === 'string' && name.trim() !== '' ? name : null;
  } catch (err: any) {
    log('RUNNER', `getIssueProjectName failed: ${err.message}`, { issue: issueId });
    return null;
  }
}

interface IssueMeta {
  identifier: string | null;
  title: string | null;
  description: string | null;
  projectName: string | null;
}

// Linear issue の identifier/title/description/プロジェクト名を1クエリで取得する（never throws）。
async function getIssueMeta(issueId: string): Promise<IssueMeta> {
  try {
    const data: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { identifier title description project { name } } }',
      { id: issueId }
    );
    const issue = data?.issue ?? {};
    const projectName = issue?.project?.name;
    return {
      identifier: typeof issue.identifier === 'string' ? issue.identifier : null,
      title: typeof issue.title === 'string' ? issue.title : null,
      description: typeof issue.description === 'string' ? issue.description : null,
      projectName:
        typeof projectName === 'string' && projectName.trim() !== '' ? projectName : null,
    };
  } catch (err: any) {
    log('RUNNER', `getIssueMeta failed: ${err.message}`, { issue: issueId });
    return { identifier: null, title: null, description: null, projectName: null };
  }
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

/**
 * Issue が Done（完了）に到達したときに `check` ラベルを付与する。
 * 人間が完了Issueを確認した後、手動でラベルを外す運用（SOT-908）。
 * ラベルが無ければ作成し、既に付いていれば何もしない（冪等）。
 */
async function addCheckLabel(issueId: string): Promise<void> {
  try {
    const issueData: any = await linearQuery('query($id: String!) { issue(id: $id) { id labelIds team { id } } }', { id: issueId });
    if (!issueData.issue) return;
    const { id: uuid, labelIds, team } = issueData.issue;
    const teamId = team.id;

    const labelsData: any = await linearQuery('query { issueLabels(filter: { name: { eq: "check" } }) { nodes { id } } }');
    let labelId = labelsData.issueLabels.nodes[0]?.id;

    if (!labelId) {
      const createLabelData: any = await linearQuery(`
        mutation($name: String!, $teamId: String!, $color: String!) {
          issueLabelCreate(input: { name: $name, teamId: $teamId, color: $color }) {
            issueLabel { id }
          }
        }
      `, { name: 'check', teamId, color: '#4CB782' });
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
      log('RUNNER', 'check label added (issue Done)', { issue: issueId });
    }
  } catch (err: any) {
    log('ERROR', `addCheckLabel failed: ${err.message}`, { issue: issueId });
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

// A past-queue (history) entry: a QueueItem that has been dequeued/processed,
// tagged with the time it left the active queue.
export interface QueueHistoryItem extends QueueItem {
  dequeuedAt: string;
}

// Read the past-queue history (newest first). Returns [] when the file is
// missing, empty, or unparseable (mirrors loadQueue's defensive behavior).
function loadQueueHistory(): QueueHistoryItem[] {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const content = fs.readFileSync(HISTORY_FILE, 'utf8');
    try {
      const history = JSON.parse(content);
      return Array.isArray(history) ? history : [];
    } catch (parseErr: any) {
      log('QUEUE', `loadQueueHistory: JSON parse failed: ${parseErr.message}`);
      return [];
    }
  } catch (err: any) {
    log('QUEUE', `loadQueueHistory ERROR: ${err.message}`);
    return [];
  }
}

// Prepend a dequeued item to the past-queue history (newest first), capped to
// MAX_QUEUE_HISTORY entries. Atomic write; never throws.
function recordQueueHistory(item: QueueItem): void {
  try {
    const entry: QueueHistoryItem = { ...item, dequeuedAt: new Date().toISOString() };
    const history = loadQueueHistory();
    history.unshift(entry);
    const capped = history.slice(0, MAX_QUEUE_HISTORY);
    const tmpFile = HISTORY_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(capped, null, 2));
    fs.renameSync(tmpFile, HISTORY_FILE);
  } catch (err: any) {
    log('QUEUE', `recordQueueHistory ERROR: ${err.message}`, { issue: item.issueId });
  }
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
    recordQueueHistory(item);

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

interface InflightEntry {
  issueId: string;
  startedAt: string | null; // null => legacy/unknown entry, treated as stale by the reaper
}

// Read inflight as normalized records. Backward-compatible with the legacy `string[]` format
// (a bare string becomes `{ issueId, startedAt: null }`).
function loadInflightRecords(): InflightEntry[] {
  try {
    if (!fs.existsSync(INFLIGHT_FILE)) return [];
    const content = fs.readFileSync(INFLIGHT_FILE, 'utf8');
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry: any): InflightEntry =>
        typeof entry === 'string'
          ? { issueId: entry, startedAt: null }
          : { issueId: entry.issueId, startedAt: entry.startedAt ?? null }
      )
      .filter((e: InflightEntry) => typeof e.issueId === 'string' && e.issueId.length > 0);
  } catch (err) {
    return [];
  }
}

function saveInflightRecords(records: InflightEntry[]): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = INFLIGHT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
    fs.renameSync(tmp, INFLIGHT_FILE);
  } catch (err: any) {
    log('RUNNER', `saveInflight ERROR: ${err.message}`);
  }
}

// Backward-compatible: returns issueIds only.
function loadInflight(): string[] {
  return loadInflightRecords().map(r => r.issueId);
}

// Backward-compatible: accepts issueId[], preserving existing startedAt and stamping new ones.
function saveInflight(list: string[]): void {
  const byId = new Map(loadInflightRecords().map(r => [r.issueId, r]));
  const now = new Date().toISOString();
  const records: InflightEntry[] = list.map(id => byId.get(id) ?? { issueId: id, startedAt: now });
  saveInflightRecords(records);
}

// Crash recovery: remove leaked inflight entries whose run never cleaned up.
// No-op while a run holds the lock; reaps entries older than INFLIGHT_TTL_MS, and
// legacy/unknown (null startedAt) entries. Returns the issueIds of the entries reaped.
function reapStaleInflight(): string[] {
  if (isLocked()) return []; // a live run holds the lock; never touch inflight mid-run
  const records = loadInflightRecords();
  if (records.length === 0) return [];
  const now = Date.now();
  const kept: InflightEntry[] = [];
  const reaped: string[] = [];
  for (const r of records) {
    const startedMs = r.startedAt ? new Date(r.startedAt).getTime() : NaN;
    const isStale = Number.isNaN(startedMs) || (now - startedMs) > INFLIGHT_TTL_MS;
    if (isStale) reaped.push(r.issueId);
    else kept.push(r);
  }
  if (reaped.length > 0) {
    saveInflightRecords(kept);
    // A reaped inflight entry means its (possibly detached) run leaked — drop its sentinel too.
    for (const id of reaped) clearDetachedSentinel(id);
    log('REAPER', `reapStaleInflight: cleared ${reaped.length} leaked inflight entr${reaped.length === 1 ? 'y' : 'ies'}: ${reaped.join(', ')}`);
  }
  // Independently sweep detached sentinels whose recorded PID is no longer alive (the detached
  // run finished or crashed without removing its own sentinel). No-op while a run holds the lock.
  reapDeadDetachedSentinels();
  return reaped;
}

// Remove detached sentinels whose recorded PID is dead. Returns the cleared issueIds.
function reapDeadDetachedSentinels(): string[] {
  const cleared: string[] = [];
  try {
    if (!fs.existsSync(DETACHED_DIR)) return cleared;
    for (const file of fs.readdirSync(DETACHED_DIR)) {
      if (!file.endsWith('.json')) continue;
      let record: DetachedSentinel | null = null;
      try {
        record = JSON.parse(fs.readFileSync(path.join(DETACHED_DIR, file), 'utf8'));
      } catch {
        record = null;
      }
      if (!record || !record.issueId) continue;
      if (record.pid == null) continue; // unknown pid: leave for the inflight-TTL path
      let isDead = false;
      try {
        process.kill(record.pid, 0);
      } catch (e: any) {
        if (e.code === 'ESRCH') isDead = true;
      }
      if (isDead) {
        clearDetachedSentinel(record.issueId);
        removeInflight(record.issueId);
        cleared.push(record.issueId);
      }
    }
    if (cleared.length > 0) {
      log('REAPER', `reapDeadDetachedSentinels: cleared ${cleared.length} finished detached run(s): ${cleared.join(', ')}`);
    }
  } catch (err: any) {
    log('REAPER', `reapDeadDetachedSentinels ERROR: ${err.message}`);
  }
  return cleared;
}

// SOT-915: detect detached long-run completion via the per-issue done-marker and feed the result
// back through the normal enqueue/Resume post-processing (processCompletedRun). This closes the
// "launch → complete → post-process" loop for detached runs without occupying Claude:
//   - exit 0 + verified   → success cleanup (clear cooldown / remove usage-limit label)
//   - usage-limit          → cooldown set + resume metadata saved + re-enqueued with retryAt
//   - non-zero / failed    → recorded (the abnormal exit is logged)
// A no-op while a run holds the lock. Each marker's outcome is applied once, then the marker, log,
// sentinel and inflight entry are cleared. Returns the issueIds processed.
async function reapCompletedDetachedRuns(): Promise<string[]> {
  if (isLocked()) return []; // never act mid-run
  const processed: string[] = [];
  if (!fs.existsSync(DETACHED_DIR)) return processed;
  let files: string[] = [];
  try {
    files = fs.readdirSync(DETACHED_DIR).filter(f => f.endsWith('.done.json'));
  } catch (err: any) {
    log('REAPER', `reapCompletedDetachedRuns readdir ERROR: ${err.message}`);
    return processed;
  }
  for (const file of files) {
    const fullPath = path.join(DETACHED_DIR, file);
    let issueId: string | null = null;
    try {
      let done: DetachedDone | null = null;
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (parsed && typeof parsed.issueId === 'string') {
          done = { issueId: parsed.issueId, exitCode: Number(parsed.exitCode), endedAt: parsed.endedAt };
        }
      } catch {
        done = null;
      }
      if (!done || !done.issueId) {
        // Unparseable / orphan marker: drop it so it doesn't accumulate.
        try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
        log('REAPER', `reapCompletedDetachedRuns: dropped unparseable done-marker ${file}`);
        continue;
      }
      issueId = done.issueId;
      const exitCode = Number.isFinite(done.exitCode) ? done.exitCode : 1;
      const logFile = detachedLogFile(issueId);
      let runOutput = '';
      try {
        if (fs.existsSync(logFile)) runOutput = fs.readFileSync(logFile, 'utf8');
      } catch { /* ignore — empty output */ }

      // Minimal QueueItem for re-injection. Priority/parent grouping are intentionally null:
      // a usage-limit resume re-enqueue gets its priority refreshed from Linear on the next drain.
      const item: QueueItem = {
        issueId,
        issueIdentifier: null,
        trigger: 'detached',
        retryAt: null,
        enqueuedAt: new Date().toISOString(),
        lastAttemptAt: null,
        attemptCount: 0,
        reason: null,
        priority: null,
        priorityLabel: null,
        priorityRank: 0,
        linearFetchedAt: null,
        parentIssueId: null,
        parentIssueIdentifier: null,
        queueGroup: null,
        queueGroupOrder: null
      };

      const r = await processCompletedRun(item, exitCode, runOutput);
      await notifyDetachedCompleted({
        issueId,
        lane: resolveLane(),
        exitCode,
        outcome: detachedOutcomeForKind(r.resultKind)
      }).catch(() => {});
      log('REAPER', `reapCompletedDetachedRuns: post-processed detached completion exit=${exitCode}`, { issue: issueId });
      processed.push(issueId);
    } catch (err: any) {
      log('REAPER', `reapCompletedDetachedRuns ERROR for ${file}: ${err.message}`, issueId ? { issue: issueId } : undefined);
    } finally {
      // Clean up this completed run's tracking regardless of post-processing outcome.
      if (issueId) {
        clearDetachedDone(issueId);
        clearDetachedLog(issueId);
        clearDetachedSentinel(issueId);
        removeInflight(issueId);
      }
    }
  }
  return processed;
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
  const records = loadInflightRecords();
  if (!records.some(r => r.issueId === issueId)) {
    records.push({ issueId, startedAt: new Date().toISOString() });
    saveInflightRecords(records);
  }
}

function removeInflight(issueId: string): void {
  const records = loadInflightRecords().filter(r => r.issueId !== issueId);
  saveInflightRecords(records);
}

function isInflight(issueId: string): boolean {
  return loadInflight().includes(issueId);
}

// --- Detached long-run sentinels (SOT-914) -------------------------------------------------
// A sentinel marks an issue whose run was launched detached (the heavy process keeps running
// after the JS lock is released). The reaper clears sentinels for dead PIDs / reaped inflight.

interface DetachedSentinel {
  issueId: string;
  pid: number | null;
  startedAt: string;
}

function sanitizeIssueIdForFile(issueId: string): string {
  return issueId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function detachedSentinelFile(issueId: string): string {
  return path.join(DETACHED_DIR, `${sanitizeIssueIdForFile(issueId)}.json`);
}

function writeDetachedSentinel(issueId: string, pid: number | undefined): void {
  try {
    if (!fs.existsSync(DETACHED_DIR)) fs.mkdirSync(DETACHED_DIR, { recursive: true });
    const record: DetachedSentinel = { issueId, pid: pid ?? null, startedAt: new Date().toISOString() };
    const target = detachedSentinelFile(issueId);
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, target);
  } catch (err: any) {
    log('RUNNER', `writeDetachedSentinel ERROR: ${err.message}`, { issue: issueId });
  }
}

function clearDetachedSentinel(issueId: string): void {
  try {
    const target = detachedSentinelFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedSentinel ERROR: ${err.message}`, { issue: issueId });
  }
}

function loadDetachedSentinel(issueId: string): DetachedSentinel | null {
  try {
    const target = detachedSentinelFile(issueId);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return null;
  }
}

// --- Detached completion done-markers (SOT-915) --------------------------------------------
// A detached long-run (SOT-914) is launched fully detached: the parent JS process may not be
// alive when the heavy run finishes, so the child itself records its outcome durably. On exit
// the child writes a per-issue log (its stdout+stderr) and a done-marker carrying the exit code.
// The completion reaper consumes these and re-injects the result into the normal enqueue/Resume
// post-processing (see reapCompletedDetachedRuns).

interface DetachedDone {
  issueId: string;
  exitCode: number;
  endedAt: string;
}

function detachedLogFile(issueId: string): string {
  return path.join(DETACHED_DIR, `${sanitizeIssueIdForFile(issueId)}.log`);
}

function detachedDoneFile(issueId: string): string {
  return path.join(DETACHED_DIR, `${sanitizeIssueIdForFile(issueId)}.done.json`);
}

function loadDetachedDone(issueId: string): DetachedDone | null {
  try {
    const target = detachedDoneFile(issueId);
    if (!fs.existsSync(target)) return null;
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed.issueId !== 'string') return null;
    return { issueId: parsed.issueId, exitCode: Number(parsed.exitCode), endedAt: parsed.endedAt };
  } catch {
    return null;
  }
}

function clearDetachedDone(issueId: string): void {
  try {
    const target = detachedDoneFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedDone ERROR: ${err.message}`, { issue: issueId });
  }
}

function clearDetachedLog(issueId: string): void {
  try {
    const target = detachedLogFile(issueId);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch (err: any) {
    log('RUNNER', `clearDetachedLog ERROR: ${err.message}`, { issue: issueId });
  }
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

// Marker embedded in the auto-finalization comment so we never finalize a parent twice.
const PARENT_FINALIZED_MARKER = '<!-- auto-parent-finalized -->';

// When a CHILD issue reaches a terminal state, advance its parent to In Review if all
// of the parent's children are now terminal. Child issues are processed in independent
// Linear-webhook single-issue runs, so without this nobody returns to finalize the
// parent and it stays stuck In Progress (see SOT-840 / SOT-829). Fail-open: never throws.
async function finalizeParentIfChildrenComplete(childIdentifier: string, parentId: string | null): Promise<boolean> {
  if (!parentId) return false;
  try {
    const data: any = await linearQuery(
      `query($id: String!) {
        issue(id: $id) {
          id
          identifier
          state { name type }
          team { id }
          children(first: 100) { nodes { identifier state { name type } } }
        }
      }`,
      { id: parentId }
    );
    const parent = data.issue;
    if (!parent) {
      log('WEBHOOK', `finalizeParent: parent ${parentId} not found, skip`, { issue: childIdentifier });
      return false;
    }

    if (isTerminalState(parent.state)) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already terminal (${parent.state?.name}), skip`, { issue: parent.identifier });
      return false;
    }
    if ((parent.state?.name || '').toLowerCase() === 'in review') {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already In Review, skip`, { issue: parent.identifier });
      return false;
    }

    const children = parent.children?.nodes || [];
    if (children.length === 0) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} has no children, skip`, { issue: parent.identifier });
      return false;
    }

    const pending = children.filter((c: any) => !isTerminalState(c.state));
    if (pending.length > 0) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} has non-terminal children: ${pending.map((c: any) => c.identifier).join(',')}, skip`, { issue: parent.identifier });
      return false;
    }

    // Idempotency: bail if we already posted the finalization marker.
    const commentsData: any = await linearQuery(
      'query($id: String!) { issue(id: $id) { comments(first: 50) { nodes { body } } } }',
      { id: parent.id }
    );
    const existingComments = commentsData.issue?.comments?.nodes || [];
    if (existingComments.some((c: any) => (c.body || '').includes(PARENT_FINALIZED_MARKER))) {
      log('WEBHOOK', `finalizeParent: ${parent.identifier} already finalized (marker present), skip`, { issue: parent.identifier });
      return false;
    }

    // Resolve the team's "In Review" workflow state by name (both In Progress and In
    // Review are type "started", so we must match on name, not type).
    const statesData: any = await linearQuery(
      'query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } } }',
      { teamId: parent.team.id }
    );
    const stateNodes = statesData.workflowStates?.nodes || [];
    const reviewState = stateNodes.find((s: any) => (s.name || '').toLowerCase() === 'in review');
    if (!reviewState) {
      log('WEBHOOK', `finalizeParent: no In Review state for team ${parent.team.id}, skip`, { issue: parent.identifier });
      return false;
    }

    await linearQuery(
      'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
      { id: parent.id, stateId: reviewState.id }
    );

    const childList = children.map((c: any) => `- ${c.identifier} (${c.state?.name})`).join('\n');
    const body = `${PARENT_FINALIZED_MARKER}
## 親Issue自動ファイナライズ

全ての子Issueが完了したため、親Issueを **In Review** に更新しました（trigger: ${childIdentifier} 完了）。

### 子Issue
${childList}

人間のレビュー後に Done へ移行してください。`;
    await linearQuery(
      'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }',
      { issueId: parent.id, body }
    );

    log('WEBHOOK', `finalizeParent: ${parent.identifier} -> In Review (all ${children.length} children terminal, trigger ${childIdentifier})`, { issue: parent.identifier });
    return true;
  } catch (err: any) {
    log('ERROR', `finalizeParentIfChildrenComplete failed: ${err.message}`, { issue: parentId || '' });
    return false;
  }
}

interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  isLongRun?: boolean;
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
          labels { nodes { name } }
        }
      }
    `;
    const data: any = await linearQuery(query, { id: issueId });

    if (!data.issue) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'issue not found before run' };
    }

    const { archivedAt, state } = data.issue;
    const isLongRun = (data.issue.labels?.nodes || []).some((l: any) => l && l.name === LONG_RUN_LABEL);

    if (archivedAt) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'archived issue before run' };
    }

    const isTerminal = isTerminalState(state);

    if (isTerminal) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'terminal state before run' };
    }

    // In Review は人間のレビュー待ちの保留状態。自動実行の対象外とし、キューからも除去する
    // （reaper が "started" 扱いで再投入し続けるのを防ぐ）。
    if (isHoldState(state)) {
      removeFromQueue(issueId);
      return { eligible: false, reason: 'hold state (In Review) before run' };
    }

    return { eligible: true, isLongRun };
  } catch (err: any) {
    // Fail open for execution, fail closed for long-run: if Linear API is unavailable, allow
    // execution to proceed but on the normal synchronous path (isLongRun stays undefined/false).
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

// Build the environment for a run_auto.sh launch: inject WEBHOOK_ISSUE_ID and resolve the
// Linear project -> target repo (fail-open). Shared by triggerRun and triggerRunDetached.
async function buildRunEnv(issueId: string): Promise<Record<string, string | undefined>> {
  // SECURITY: Pass issueId only via environment variable, never as shell argument
  const env: Record<string, string | undefined> = { ...process.env, WEBHOOK_ISSUE_ID: issueId };

  // Linearプロジェクトから開発対象レポジトリを判定し、解決できればプロンプトへ注入する。
  // 取得・解決失敗時は env を変えず従来動作にフォールバックする（autonomous loop を止めない）。
  try {
    const projectName = await getIssueProjectName(issueId);
    if (projectName) {
      const resolved = resolveRepoForProject(projectName);
      if (resolved) {
        env.WEBHOOK_PROJECT_NAME = resolved.project;
        env.WEBHOOK_TARGET_REPO = resolved.localPath;
        log('RUNNER', `resolved target repo: project="${projectName}" -> ${resolved.localPath}`, { issue: issueId });
      } else if (isNewProject(projectName)) {
        // 「New」プロジェクト: 新規レポジトリを作成して開発対象にする。
        // 失敗時は内側 catch で fail-open（env を変えず従来動作）。
        try {
          const meta = await getIssueMeta(issueId);
          const repoName = deriveNewRepoName({
            title: meta.title,
            identifier: meta.identifier,
            body: meta.description,
          });
          const created = await ensureRepoForNewProject({ repoName });
          env.WEBHOOK_PROJECT_NAME = repoName;
          env.WEBHOOK_TARGET_REPO = created.localPath;
          log(
            'RUNNER',
            `new project "New" -> ${created.created ? 'created' : 'reused'} repo ${created.repo} (${created.localPath})`,
            { issue: issueId }
          );
        } catch (createErr: any) {
          log('RUNNER', `new-project repo creation failed (fail-open): ${createErr.message}`, { issue: issueId });
        }
      } else {
        log('RUNNER', `no repo mapping for project="${projectName}" (fail-open, no TARGET_REPO injected)`, { issue: issueId });
      }
    }
  } catch (err: any) {
    log('RUNNER', `project->repo resolution error (fail-open): ${err.message}`, { issue: issueId });
  }
  return env;
}

async function triggerRun(issueId: string, options: TriggerOptions = {}): Promise<TriggerResult> {
  const env = await buildRunEnv(issueId);

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

// long-run detached launch (SOT-914): spawn run_auto.sh in its own process group, fully detach
// (unref + stdio ignore) and resolve IMMEDIATELY without awaiting close. The caller releases the
// JS lock right away so the runner can advance; the detached run is tracked by an inflight entry
// + a sentinel, and reclaimed by the reaper. Returns the child pid (undefined on spawn failure).
async function triggerRunDetached(issueId: string, options: TriggerOptions = {}): Promise<{ pid: number | undefined }> {
  const env = await buildRunEnv(issueId);
  const projectRoot = path.join(__dirname, '..');
  const startedAt = new Date().toISOString();

  if (!fs.existsSync(DETACHED_DIR)) fs.mkdirSync(DETACHED_DIR, { recursive: true });
  const logFile = detachedLogFile(issueId);
  const doneFile = detachedDoneFile(issueId);
  // Clear any stale markers from a previous launch of the same issue.
  clearDetachedDone(issueId);
  clearDetachedLog(issueId);

  // The child records its own outcome durably (the parent may not be alive at completion):
  // redirect run_auto.sh output to the per-issue log, then atomically write a done-marker
  // carrying the exit code. SECURITY: issueId and file paths are passed via env only, never as
  // shell arguments; `--resume` is the sole inline arg (a static literal).
  const resumeFlag = options.resume ? ' --resume' : '';
  const wrapper =
    'ec=0\n' +
    `bash scripts/ai/run_auto.sh${resumeFlag} > "$DETACHED_LOG_FILE" 2>&1 || ec=$?\n` +
    'printf \'{"issueId":"%s","exitCode":%s,"endedAt":"%s"}\' "$DETACHED_ISSUE_ID" "$ec" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DETACHED_DONE_FILE.tmp"\n' +
    'mv "$DETACHED_DONE_FILE.tmp" "$DETACHED_DONE_FILE"\n';

  try {
    const child = spawn('bash', ['-c', wrapper], {
      env: {
        ...env,
        DETACHED_LOG_FILE: logFile,
        DETACHED_DONE_FILE: doneFile,
        DETACHED_ISSUE_ID: issueId
      },
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore'
    });
    // Don't let the detached child keep the parent's event loop alive.
    child.unref();
    child.on('error', (err: any) => {
      log('RUNNER', `Detached run_auto.sh spawn error=${err.message} startedAt=${startedAt}`, { issue: issueId });
    });
    log('RUNNER', `Spawned DETACHED run_auto.sh for issueId=${issueId} pid=${child.pid} startedAt=${startedAt}${options.resume ? ' (resume)' : ''}`, { issue: issueId });
    return { pid: child.pid };
  } catch (err: any) {
    log('RUNNER', `Failed to spawn DETACHED run_auto.sh error=${err.message} startedAt=${startedAt}`, { issue: issueId });
    return { pid: undefined };
  }
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

// Outcome of a runItem call.
// - lockConflict: the run was blocked by the global run_auto.sh OS flock (another run is active);
//   drainQueue uses this to stop the current pass instead of hammering the same item.
// - detached: the issue was launched in long-run detached mode (SOT-914); the JS lock should be
//   released immediately but the inflight entry + sentinel must be KEPT (the reaper owns cleanup).
interface RunItemOutcome {
  lockConflict: boolean;
  detached: boolean;
}

async function runItem(item: QueueItem): Promise<RunItemOutcome> {
  const { issueId } = item;

  // Check current Linear state before executing
  const eligibility = await getIssueExecutionEligibility(issueId);
  if (!eligibility.eligible) {
    log('RUN', `skipped: ${eligibility.reason}`, { trigger: item.trigger || 'queue', issue: issueId });
    return { lockConflict: false, detached: false };
  }

  const isResume = item.reason === 'usage_limit';

  // long-run detached mode (SOT-914): launch detached, record inflight + sentinel, and return
  // immediately so the caller releases the lock right away (lock hold ≈ startup time, not sim time).
  if (eligibility.isLongRun) {
    log('RUN', `long-run detected (label="${LONG_RUN_LABEL}") — launching detached`, { trigger: item.trigger || 'queue', issue: issueId });
    addInflight(issueId); // idempotent; ensures tracking regardless of caller
    const { pid } = await triggerRunDetached(issueId, { resume: isResume });
    writeDetachedSentinel(issueId, pid);
    await notifyDetachedLaunched({ issueId, lane: resolveLane(), pid, resume: isResume }).catch(() => {});
    log('RUN', `detached run started pid=${pid ?? 'unknown'} — releasing lock`, { trigger: item.trigger || 'queue', issue: issueId });
    return { lockConflict: false, detached: true };
  }

  if (isResume) {
    log('RESUME', 'issue-rerun start', { issue: issueId, retryAt: item.retryAt || null });
    log('RUN', 'start (resume)', { trigger: item.trigger || 'queue', issue: issueId });
  } else {
    log('RUN', 'start', { trigger: item.trigger || 'queue', issue: issueId });
  }

  const { code, output } = await triggerRun(issueId, { resume: isResume });
  const { lockConflict } = await processCompletedRun(item, code, output);
  return { lockConflict, detached: false };
}

// Post-process a finished run: verify completion, classify the result, and apply the matching
// side effects (success cleanup / usage-limit cooldown+resume re-enqueue / failure logging).
// Extracted from runItem so both the synchronous path AND the detached-completion reaper
// (reapCompletedDetachedRuns, SOT-915) feed their results through the SAME post-processing.
// Returns lockConflict so the synchronous drain can stop the pass on a global-flock conflict.
async function processCompletedRun(item: QueueItem, code: number, output: string): Promise<{ lockConflict: boolean; resultKind: string }> {
  const { issueId } = item;
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

    case RUN_RESULT.LOCK_CONFLICT: {
      // Another run_auto.sh holds the global OS flock. Re-enqueue with a short
      // backoff (not null) so drainQueue's future-retryAt guard stops the pass
      // instead of re-spawning run_auto.sh in a tight loop (console flood).
      const backoffRetryAt = new Date(Date.now() + LOCK_CONFLICT_BACKOFF_MS).toISOString();
      log('RUNNER', `SKIPPED_LOCKED received from run_auto.sh — re-enqueuing with backoff retryAt=${backoffRetryAt}`, { issue: issueId });
      enqueue(issueId, item.trigger || 'queue', backoffRetryAt, {
        issueIdentifier: item.issueIdentifier || null,
        reason: 'lock_conflict',
        priority: item.priority ?? null,
        priorityLabel: item.priorityLabel ?? null,
        parentIssueId: item.parentIssueId ?? null,
        parentIssueIdentifier: item.parentIssueIdentifier ?? null,
        queueGroup: item.queueGroup ?? null,
        queueGroupOrder: item.queueGroupOrder ?? null
      });
      return { lockConflict: true, resultKind: result.kind }; // signal drainQueue to stop this pass
    }

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
  return { lockConflict: false, resultKind: result.kind };
}

// Map a processCompletedRun result kind to a Discord notification outcome (SOT-917).
function detachedOutcomeForKind(kind: string): DetachedOutcome {
  switch (kind) {
    case RUN_RESULT.TASK_COMPLETED:
      return 'success';
    case RUN_RESULT.COMPLETION_UNVERIFIED:
      return 'unverified';
    case RUN_RESULT.USAGE_LIMIT_RETRY:
      return 'usage_limit';
    default:
      return 'failed';
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
    let outcome: RunItemOutcome = { lockConflict: false, detached: false };
    try {
      addInflight(item.issueId);
      setCurrentIssue(item);
      outcome = await runItem(item);
      processedCount++;
      // Track this item's issueId as the last processed group anchor for child issues
      lastProcessedGroup = item.issueId || item.issueIdentifier || null;
    } catch (err: any) {
      log('QUEUE', `drain error: ${err.message}`, { issue: item.issueId });
      lastProcessedGroup = null;
    } finally {
      clearCurrentIssue();
      // For a detached long-run, the heavy process is still running — KEEP the inflight entry
      // (and its sentinel) so the reaper, not this finally, owns cleanup. Always release the lock.
      if (!outcome.detached) removeInflight(item.issueId);
      releaseLock();
    }

    // A global run_auto.sh flock is held by another active run — no queued item can
    // run right now. Stop this drain pass; the backed-off item retries later.
    if (outcome.lockConflict) {
      log('QUEUE', 'drain: run_auto.sh lock held by another run, stopping pass (backed off)', { issue: item.issueId });
      break;
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
  DEFAULT_LANE,
  SERIALIZE_SCOPE_REPO,
  SERIALIZE_SCOPE_BRANCH,
  resolveSerializeScope,
  serializationLaneKey,
  resolveLane,
  laneLockFile,
  laneQueueFile,
  LOCK_FILE,
  QUEUE_FILE,
  HISTORY_FILE,
  MAX_QUEUE_HISTORY,
  COOLDOWN_FILE,
  USAGE_LIMIT_FILE,
  LOG_FILE,
  STALE_LOCK_MS,
  LINEAR_API_URL,
  USAGE_LIMIT_RETRY_BUFFER_SECONDS,
  MAX_DRAIN_ITEMS,
  QUEUE_ITEM_TTL_DAYS,
  INFLIGHT_FILE,
  INFLIGHT_TTL_MS,
  LONG_RUN_LABEL,
  DETACHED_DIR,
  log,
  linearQuery,
  acquireLock,
  releaseLock,
  forceReleaseLock,
  isLocked,
  hasPendingIssues,
  fetchActiveIssues,
  postUsageLimitComment,
  buildUsageLimitCommentBody,
  addUsageLimitLabel,
  removeUsageLimitLabel,
  addCheckLabel,
  setUsageLimitCooldownUntil,
  clearUsageLimitCooldown,
  getUsageLimitCooldownUntil,
  notifyUsageLimitToAllActiveIssues,
  removeUsageLimitLabelFromAllIssues,
  loadQueue,
  saveQueue,
  loadQueueHistory,
  recordQueueHistory,
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
  loadInflightRecords,
  saveInflightRecords,
  addInflight,
  removeInflight,
  isInflight,
  reapStaleInflight,
  reapDeadDetachedSentinels,
  reapCompletedDetachedRuns,
  detachedSentinelFile,
  writeDetachedSentinel,
  clearDetachedSentinel,
  loadDetachedSentinel,
  detachedLogFile,
  detachedDoneFile,
  loadDetachedDone,
  clearDetachedDone,
  clearDetachedLog,
  processCompletedRun,
  isQueuedOrRunning,
  getCurrentIssue,
  clearCurrentIssue,
  setIssueInProgress,
  finalizeParentIfChildrenComplete,
  getIssueExecutionEligibility,
  getIssueProjectName,
  triggerRun,
  triggerRunDetached,
  runItem,
  drainQueue,
  RUN_RESULT,
  classifyRunResult
};
