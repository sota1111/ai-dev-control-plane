'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { spawn, execSync } from 'node:child_process';
import * as appEnv from './config/env.js';
import { classifyUsageLimit } from './lib/usageLimitParser.js';
import { buildIssueRerunMetadata, saveResumeMetadata, formatResumeLogLines } from './lib/resumeMetadata.js';
import * as queueOrdering from './lib/queueOrdering.js';
import { resolveRepoForProject } from './lib/projectRepo.js';
import { notifyDetachedLaunched, DetachedOutcome } from './lib/laneNotifier.js';
import { resolveLaneWorkingDir } from './lib/worktree.js';
import {
  isNewProject,
  deriveNewRepoName,
  ensureRepoForNewProject,
} from './lib/projectRepoCreate.js';
import {
  configureRunnerLock,
  acquireLock,
  releaseLock,
  acquireLaneLock,
  releaseLaneLock,
  forceReleaseLock,
  isLocked,
} from './lib/runnerLock.js';
import {
  configureCooldown,
  buildUsageLimitCommentBody,
  postUsageLimitComment,
  addUsageLimitLabel,
  removeUsageLimitLabel,
  addCheckLabel,
  setUsageLimitCooldownUntil,
  clearUsageLimitCooldown,
  getUsageLimitCooldownUntil,
} from './lib/cooldown.js';
import {
  configureDetachedState,
  loadInflightRecords,
  saveInflightRecords,
  loadInflight,
  saveInflight,
  reapStaleInflight,
  reapDeadDetachedSentinels,
  reapCompletedDetachedRuns,
  addInflight,
  removeInflight,
  isInflight,
  sanitizeIssueIdForFile,
  detachedSentinelFile,
  writeDetachedSentinel,
  clearDetachedSentinel,
  loadDetachedSentinel,
  detachedLogFile,
  detachedDoneFile,
  loadDetachedDone,
  clearDetachedDone,
  clearDetachedLog,
} from './lib/detachedState.js';
import {
  configureLinearApi,
  linearQuery,
  getIssueProjectName,
  getIssueGitBranch,
  getIssueMeta,
  getIssueQueueMetadata,
  hasPendingIssues,
  fetchActiveIssues,
  setIssueInProgress,
  finalizeParentIfChildrenComplete,
  getIssueExecutionEligibility,
} from './lib/linearApi.js';
import {
  configureQueueStore,
  loadQueueHistory,
  recordQueueHistory,
  loadQueue,
  normalizeQueue,
  syncQueueWithLinear,
  refreshQueuePriorities,
  pruneExpiredQueueItems,
  saveQueue,
  enqueue,
  dequeue,
  removeFromQueue,
  isQueued,
} from './lib/queueStore.js';

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
 * Stable operation mode master switch (SOT-947). When `RUNNER_STABLE_MODE` is enabled, the runner is
 * forced into a fully-serial "stable運用" mode: it overrides ALL parallel/detach toggles to their
 * serial values — `RUNNER_MAX_PARALLEL` clamps to 1 (no N-slot pool), `RUNNER_SERIALIZE_SCOPE` forces
 * 'repo' (no per-branch lanes), `RUNNER_DEFAULT_DETACH` forces false, and the `long-run` label detach
 * in `runItem` is disabled (long-run issues run synchronously in the foreground). This is a single
 * kill-switch the human can flip to temporarily disable every concurrency path without unsetting each
 * variable. Default false ⇒ all other toggles behave exactly as before (byte-for-byte 後方互換).
 * Accepts '1' or 'true' (trim, case-insensitive), mirroring `resolveDefaultDetach`.
 */
function resolveStableMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.RUNNER_STABLE_MODE || '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Resolve the active serialization scope. Reads `RUNNER_SERIALIZE_SCOPE` from the given env
 * (or `process.env`); anything other than the explicit 'branch' value maps to 'repo' so the
 * default stays the backward-compatible per-repo serialization. Under `RUNNER_STABLE_MODE` the
 * scope is forced to 'repo' (SOT-947) so 同一 repo is always serial regardless of the env value.
 */
function resolveSerializeScope(env: NodeJS.ProcessEnv = process.env): string {
  if (resolveStableMode(env)) return SERIALIZE_SCOPE_REPO;
  const raw = (env.RUNNER_SERIALIZE_SCOPE || '').trim().toLowerCase();
  return raw === SERIALIZE_SCOPE_BRANCH ? SERIALIZE_SCOPE_BRANCH : SERIALIZE_SCOPE_REPO;
}

/**
 * N-slot parallel pool size (SOT-931 案A, 3rd step). `RUNNER_MAX_PARALLEL` controls how many queued
 * items `drainQueue()` may dispatch concurrently into DISTINCT serialization lanes. Default 1 keeps
 * the historical fully-serial drain (一切の挙動不変). Values < 1 or non-numeric clamp to 1. Under
 * `RUNNER_STABLE_MODE` the pool is forced to 1 (SOT-947) regardless of the env value.
 */
function resolveMaxParallel(env: NodeJS.ProcessEnv = process.env): number {
  if (resolveStableMode(env)) return 1;
  const n = parseInt((env.RUNNER_MAX_PARALLEL || '').trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Default-detach toggle (SOT-934 案A, final step). When `RUNNER_DEFAULT_DETACH` is enabled, a NORMAL
 * run (no `long-run` label) is also launched detached in `runItem` — exactly like a long-run — so the
 * JS/lane lock is released immediately and the webhook returns without occupying a slot for the whole
 * run. Completion still flows through the existing done-marker → reapCompletedDetachedRuns →
 * processCompletedRun path. Default false ⇒ normal runs stay on the synchronous foreground path
 * (現行挙動と byte-for-byte 同一・後方互換). Accepts '1' or 'true' (trim, case-insensitive). Under
 * `RUNNER_STABLE_MODE` this is forced false (SOT-947) regardless of the env value.
 */
function resolveDefaultDetach(env: NodeJS.ProcessEnv = process.env): boolean {
  if (resolveStableMode(env)) return false;
  const v = (env.RUNNER_DEFAULT_DETACH || '').trim().toLowerCase();
  return v === '1' || v === 'true';
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
const USAGE_LIMIT_RETRY_BUFFER_SECONDS = appEnv.usageLimitRetryBufferSeconds();
const MAX_DRAIN_ITEMS = 20;  // safety guard against infinite drain loops
// run_auto.sh のOS flock（同時に1プロセスのみ）を別の実行が保持しているとき、
// drain から起動した run_auto.sh は exit 75 を返す。グローバルロックなので他のキュー項目も
// 同様に弾かれる。即時 null 再投入だと drain が同一Issueを MAX_DRAIN_ITEMS 回連打して
// コンソールを溢れさせるため、この秒数だけ retryAt バックオフを付けて再投入し drain を止める。
const LOCK_CONFLICT_BACKOFF_MS = appEnv.lockConflictBackoffMs();
const LOG_FILE = path.join(LOG_DIR, 'auto_runner.log');
const STALE_LOCK_MS = 30 * 60 * 1000;  // 30 minutes
const LINEAR_API_URL = 'https://api.linear.app/graphql';
const QUEUE_ITEM_TTL_DAYS = appEnv.queueItemTtlDays();
const INFLIGHT_FILE = path.join(LOG_DIR, 'runner.inflight.json');
const CURRENT_ISSUE_FILE = path.join(LOG_DIR, 'current-issue.json');
// Leaked inflight entries (process crashed without cleanup) older than this are reaped.
const INFLIGHT_TTL_MS = appEnv.inflightTtlMs(); // 2 hours
// long-run detached execution (SOT-914 / SOT-911 案②): issues carrying this Linear label are
// launched detached so the JS lock is released immediately (lock hold ≈ startup time, not sim time).
const LONG_RUN_LABEL = appEnv.longRunLabel();
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

// Lock operations (acquire/release/forceRelease/isLocked) live in ./lib/runnerLock.ts.
// They depend on LOG_DIR / LOCK_FILE / STALE_LOCK_MS / laneLockFile / log, which are owned here and
// injected once below to avoid a circular import (configure at module init, used only at runtime).
configureRunnerLock({
  logDir: LOG_DIR,
  lockFile: LOCK_FILE,
  staleLockMs: STALE_LOCK_MS,
  laneLockFile,
  log,
});

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

// Linear GraphQL API access + issue metadata/state helpers live in ./lib/linearApi.ts.
// They depend on log / LINEAR_API_URL / LONG_RUN_LABEL and the queue helper removeFromQueue,
// owned here and injected once to avoid a circular import (removeFromQueue is a hoisted function
// declaration, so referencing it before its definition is safe).
configureLinearApi({
  log,
  linearApiUrl: LINEAR_API_URL,
  longRunLabel: LONG_RUN_LABEL,
  removeFromQueue,
});

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

// Usage-limit cooldown + Linear label/comment helpers live in ./lib/cooldown.ts.
// They depend on log / linearQuery / LOG_DIR / COOLDOWN_FILE / USAGE_LIMIT_FILE /
// USAGE_LIMIT_RETRY_BUFFER_SECONDS, owned here and injected once to avoid a circular import.
configureCooldown({
  logDir: LOG_DIR,
  cooldownFile: COOLDOWN_FILE,
  usageLimitFile: USAGE_LIMIT_FILE,
  usageLimitRetryBufferSeconds: USAGE_LIMIT_RETRY_BUFFER_SECONDS,
  log,
  linearQuery,
});

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

// Persistent queue store (active queue + past-queue history) lives in ./lib/queueStore.ts.
// It depends on log / LOG_DIR / QUEUE_FILE / HISTORY_FILE / MAX_QUEUE_HISTORY / QUEUE_ITEM_TTL_DAYS,
// owned here and injected once to avoid a circular import. linearQuery / fetchActiveIssues /
// queueOrdering / isTerminalState are imported directly by queueStore from their own modules.
// laneQueueFile stays here (lane path infra, alongside laneLockFile); the resolved default-lane
// QUEUE_FILE is injected so the lane file-path contract (RUNNER_LANE / SOT-913〜917) is unchanged.
configureQueueStore({
  logDir: LOG_DIR,
  queueFile: QUEUE_FILE,
  historyFile: HISTORY_FILE,
  maxQueueHistory: MAX_QUEUE_HISTORY,
  queueItemTtlDays: QUEUE_ITEM_TTL_DAYS,
  log,
});

// Inflight tracking + detached sentinels/done-markers + their reapers live in ./lib/detachedState.ts.
// They depend on log / LOG_DIR / INFLIGHT_FILE / INFLIGHT_TTL_MS / DETACHED_DIR and the orchestration
// callbacks the completion reaper feeds into (processCompletedRun / resolveLane /
// detachedOutcomeForKind), owned here and injected once to avoid a circular import. The callbacks are
// hoisted function declarations, so referencing them here (before their definitions) is safe.
configureDetachedState({
  logDir: LOG_DIR,
  inflightFile: INFLIGHT_FILE,
  inflightTtlMs: INFLIGHT_TTL_MS,
  detachedDir: DETACHED_DIR,
  log,
  processCompletedRun,
  resolveLane,
  detachedOutcomeForKind,
});

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

interface TriggerOptions {
  resume?: boolean;
  // Per-dispatch environment overrides (SOT-933). The N-slot pool passes `{ RUNNER_LANE: <lane> }`
  // so each concurrent run resolves its own worktree lane WITHOUT mutating shared process.env.
  envOverrides?: Record<string, string | undefined>;
}

interface TriggerResult {
  code: number;
  output: string;
}

// Build the environment for a run_auto.sh launch: inject WEBHOOK_ISSUE_ID and resolve the
// Linear project -> target repo (fail-open). Shared by triggerRun and triggerRunDetached.
async function buildRunEnv(
  issueId: string,
  overrides: Record<string, string | undefined> = {}
): Promise<Record<string, string | undefined>> {
  // SECURITY: Pass issueId only via environment variable, never as shell argument.
  // `overrides` (e.g. per-dispatch RUNNER_LANE from the N-slot pool, SOT-933) win over process.env
  // but never over WEBHOOK_ISSUE_ID. Building a fresh object per call keeps concurrent dispatches
  // isolated (no shared process.env mutation).
  const env: Record<string, string | undefined> = { ...process.env, ...overrides, WEBHOOK_ISSUE_ID: issueId };

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

  // Lane worktree 供給 (SOT-932, 案A): RUNNER_SERIALIZE_SCOPE=branch などで非 default lane が
  // 導出される場合、同一 repo・別 branch の作業ツリー競合を避けるため、解決済み TARGET_REPO を
  // lane 専用の git worktree に差し替える。default lane（既定 repo スコープ）は repoRoot のまま
  // 不変（後方互換）。fail-open: worktree 供給に失敗しても元の localPath を維持し run を止めない。
  if (env.WEBHOOK_TARGET_REPO) {
    const lane = resolveLane(env);
    if (lane !== DEFAULT_LANE) {
      try {
        const workingDir = resolveLaneWorkingDir({ repoRoot: env.WEBHOOK_TARGET_REPO, lane }, env);
        if (workingDir !== env.WEBHOOK_TARGET_REPO) {
          log('RUNNER', `lane worktree: lane=${lane} -> ${workingDir}`, { issue: issueId });
          env.WEBHOOK_TARGET_REPO = workingDir;
        }
      } catch (err: any) {
        log('RUNNER', `lane worktree provisioning failed (fail-open): ${err.message}`, { issue: issueId });
      }
    }
  }

  return env;
}

async function triggerRun(issueId: string, options: TriggerOptions = {}): Promise<TriggerResult> {
  const env = await buildRunEnv(issueId, options.envOverrides);

  const projectRoot = path.join(__dirname, '..');
  const startedAt = new Date().toISOString();

  const args = ['scripts/ai/run_auto.sh'];
  if (options.resume) {
    args.push('--resume');
  }

  // detached: true puts child in its own process group (POSIX). Stable mode keeps
  // foreground runs attached so no detach-related process behavior remains active.
  const child = spawn('bash', args, {
    env,
    cwd: projectRoot,
    detached: !resolveStableMode(),
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
  const env = await buildRunEnv(issueId, options.envOverrides);
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

async function runItem(item: QueueItem, options: TriggerOptions = {}): Promise<RunItemOutcome> {
  const { issueId } = item;
  const envOverrides = options.envOverrides;
  // Lane this dispatch runs in: the per-dispatch override (N-slot pool, SOT-933) when present,
  // otherwise the process-level lane (default single-lane path, unchanged).
  const dispatchLane = resolveLane(envOverrides?.RUNNER_LANE ?? undefined);

  // Check current Linear state before executing
  const eligibility = await getIssueExecutionEligibility(issueId);
  if (!eligibility.eligible) {
    log('RUN', `skipped: ${eligibility.reason}`, { trigger: item.trigger || 'queue', issue: issueId });
    return { lockConflict: false, detached: false };
  }

  const isResume = item.reason === 'usage_limit';

  // Detached mode: launch detached, record inflight + sentinel, and return immediately so the caller
  // releases the lock right away (lock hold ≈ startup time, not run time). Triggered by either:
  //   - the `long-run` label (SOT-914), or
  //   - default-detach (SOT-934): RUNNER_DEFAULT_DETACH makes EVERY normal run detach too, so the
  //     webhook returns without occupying a slot for the whole run.
  // Both paths reuse the same triggerRunDetached + done-marker reaper completion flow.
  // SOT-947: under RUNNER_STABLE_MODE the long-run detach is disabled (long-run issues run
  // synchronously in the foreground). resolveDefaultDetach already returns false in stable mode, so
  // gating isLongRun here fully disables every detach path for stable serial operation.
  const stableMode = resolveStableMode();
  const longRunDetach = !!eligibility.isLongRun && !stableMode;
  const defaultDetach = resolveDefaultDetach();
  if (longRunDetach || defaultDetach) {
    const detachReason = longRunDetach
      ? `long-run detected (label="${LONG_RUN_LABEL}")`
      : 'default-detach enabled (RUNNER_DEFAULT_DETACH)';
    log('RUN', `${detachReason} — launching detached`, { trigger: item.trigger || 'queue', issue: issueId });
    addInflight(issueId); // idempotent; ensures tracking regardless of caller
    const { pid } = await triggerRunDetached(issueId, { resume: isResume, envOverrides });
    writeDetachedSentinel(issueId, pid);
    await notifyDetachedLaunched({ issueId, lane: dispatchLane, pid, resume: isResume }).catch(() => {});
    log('RUN', `detached run started pid=${pid ?? 'unknown'} — releasing lock`, { trigger: item.trigger || 'queue', issue: issueId });
    return { lockConflict: false, detached: true };
  }

  if (isResume) {
    log('RESUME', 'issue-rerun start', { issue: issueId, retryAt: item.retryAt || null });
    log('RUN', 'start (resume)', { trigger: item.trigger || 'queue', issue: issueId });
  } else {
    log('RUN', 'start', { trigger: item.trigger || 'queue', issue: issueId });
  }

  const { code, output } = await triggerRun(issueId, { resume: isResume, envOverrides });
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

// Resolve the serialization lane a queue item runs in (SOT-933). Items sharing a lane never run
// concurrently (the safety valve): under the default 'repo' scope a lane = repo (同一 repo 直列);
// under 'branch' scope a lane = repo--branch (別 branch 並行可・同一 branch 直列). Unknown target
// (no repo mapping) → DEFAULT_LANE so such items serialize through the shared single lock. Never
// throws; on any failure returns DEFAULT_LANE (strictly safe / more serial).
async function resolveConcurrencyLane(item: QueueItem, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const projectName = await getIssueProjectName(item.issueId);
    const resolved = projectName ? resolveRepoForProject(projectName) : null;
    const repo = resolved ? path.basename(resolved.localPath) : '';
    if (!repo) return DEFAULT_LANE;
    let branch: string | null = null;
    if (resolveSerializeScope(env) === SERIALIZE_SCOPE_BRANCH) {
      branch = await getIssueGitBranch(item.issueId);
    }
    return serializationLaneKey({ repo, branch }, env);
  } catch {
    return DEFAULT_LANE;
  }
}

// Generic N-slot, lane-serial pool scheduler (SOT-933). Dispatches `items` via `runOne`, running at
// most `maxParallel` at once and NEVER two items of the same lane concurrently (same lane waits for
// its predecessor — the 同一 branch 直列 safety valve). Pure orchestration: all side effects live in
// `runOne`, so this is deterministically unit-testable. Order within a lane is preserved (the
// earliest still-dispatchable item is always chosen first).
async function runLanePool<T extends { lane: string }>(
  items: T[],
  maxParallel: number,
  runOne: (entry: T) => Promise<void>
): Promise<void> {
  const slots = Math.max(1, maxParallel);
  const pending = [...items];
  const activeLanes = new Set<string>();
  const running = new Set<Promise<void>>();

  const fill = () => {
    let progressed = true;
    while (progressed && running.size < slots) {
      progressed = false;
      const idx = pending.findIndex((e) => !activeLanes.has(e.lane));
      if (idx === -1) break; // every remaining item is blocked by an in-flight same-lane run
      const entry = pending.splice(idx, 1)[0];
      activeLanes.add(entry.lane);
      const task = (async () => {
        try {
          await runOne(entry);
        } finally {
          activeLanes.delete(entry.lane);
        }
      })();
      running.add(task);
      // Self-remove once settled. Registered here (before the loop's Promise.race attaches its own
      // reaction), so this runs first and `running` is current when fill() re-checks capacity.
      void task.then(() => running.delete(task), () => running.delete(task));
      progressed = true;
    }
  };

  fill();
  while (running.size > 0) {
    await Promise.race(running);
    fill();
  }
}

// N-slot parallel drain (SOT-933). Used when RUNNER_MAX_PARALLEL>1. Pulls a batch of ready, eligible
// items (resolving each item's serialization lane), then runs them through runLanePool so distinct
// lanes drain concurrently while same-lane work stays serial. Completion is handled exactly as in the
// serial path (runItem → processCompletedRun / detached reaper); only dispatch is parallelized.
async function drainQueuePooled(maxParallel: number): Promise<void> {
  const batch: { item: QueueItem; lane: string }[] = [];
  let item: QueueItem | null;
  while (batch.length < MAX_DRAIN_ITEMS && (item = dequeue(null)) !== null) {
    // Future retryAt: put it back and stop pulling (ordering preserved; it runs in a later pass).
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
      log('QUEUE', `drain(pool): item ${item.issueId} has future retryAt=${item.retryAt}, stopping batch`);
      break;
    }
    const eligibility = await getIssueExecutionEligibility(item.issueId);
    if (!eligibility.eligible) {
      log('QUEUE', `drain(pool): skipped issueId=${item.issueId} reason=${eligibility.reason}`, { issue: item.issueId });
      continue;
    }
    const lane = await resolveConcurrencyLane(item);
    batch.push({ item, lane });
  }

  if (batch.length === 0) {
    log('QUEUE', 'drain complete (pool: nothing to dispatch)');
    return;
  }
  log('QUEUE', `drain(pool): dispatching ${batch.length} item(s) across up to ${maxParallel} slots`);

  await runLanePool(batch, maxParallel, async ({ item, lane }) => {
    // Distinct lanes get distinct locks (cross-process safety); same lane shares one lock (serial).
    const locked = acquireLaneLock(lane, { trigger: 'drain', issue: item.issueId });
    if (!locked) {
      log('QUEUE', 'drain(pool): SKIPPED_LOCKED — re-enqueuing', { issue: item.issueId, lane });
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
      return;
    }
    // A non-default lane runs in its own worktree (SOT-932) via the RUNNER_LANE env override.
    const envOverrides = lane === DEFAULT_LANE ? undefined : { RUNNER_LANE: lane };
    let outcome: RunItemOutcome = { lockConflict: false, detached: false };
    try {
      addInflight(item.issueId);
      outcome = await runItem(item, { envOverrides });
    } catch (err: any) {
      log('QUEUE', `drain(pool) error: ${err.message}`, { issue: item.issueId, lane });
    } finally {
      // Detached long-runs keep their inflight entry (reaper owns cleanup); always release the lane lock.
      if (!outcome.detached) removeInflight(item.issueId);
      releaseLaneLock(lane);
    }
  });

  log('QUEUE', `drain complete (pool, maxParallel=${maxParallel}, dispatched=${batch.length})`);
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

  // N-slot parallel pool (SOT-933): when RUNNER_MAX_PARALLEL>1, dispatch distinct lanes concurrently.
  // Default (1) falls through to the historical fully-serial loop below — behavior is unchanged.
  const maxParallel = resolveMaxParallel();
  if (maxParallel > 1) {
    await drainQueuePooled(maxParallel);
    return;
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
  resolveMaxParallel,
  resolveDefaultDetach,
  resolveStableMode,
  serializationLaneKey,
  resolveConcurrencyLane,
  runLanePool,
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
  acquireLaneLock,
  releaseLaneLock,
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
