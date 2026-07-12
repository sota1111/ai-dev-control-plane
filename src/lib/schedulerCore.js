'use strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '..', '..', 'docs', 'ai', 'auto_logs');
const AUTO_RUNNER_LOG = path.join(LOG_DIR, 'auto_runner.log');
const SCHEDULER_LOG = path.join(LOG_DIR, 'scheduler.log');

// Lane support (SOT-913): keep lock/queue paths in sync with src/runner.ts so the
// scheduler and runner resolve identical files for any given RUNNER_LANE. Default
// lane keeps the historical paths (runner.lock / runner.queue.json).
const DEFAULT_LANE = 'default';

/**
 * Resolve the runner lane from an explicit value, an env object, or
 * `process.env.RUNNER_LANE`. Sanitized to `[a-zA-Z0-9_-]`; empty/unknown → DEFAULT_LANE.
 * @param {string | NodeJS.ProcessEnv} [laneOrEnv]
 * @returns {string}
 */
function resolveLane(laneOrEnv) {
  let raw;
  if (typeof laneOrEnv === 'string') {
    raw = laneOrEnv;
  } else if (laneOrEnv && typeof laneOrEnv === 'object') {
    raw = laneOrEnv.RUNNER_LANE;
  } else {
    raw = process.env.RUNNER_LANE;
  }
  const sanitized = (raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return sanitized && sanitized !== DEFAULT_LANE ? sanitized : DEFAULT_LANE;
}

/**
 * Lock file path for a given lane (default lane → historical `runner.lock`).
 * @param {string} [lane]
 * @returns {string}
 */
function laneLockFile(lane) {
  const l = resolveLane(lane);
  return path.join(LOG_DIR, l === DEFAULT_LANE ? 'runner.lock' : `runner.${l}.lock`);
}

/**
 * Queue file path for a given lane (default lane → historical `runner.queue.json`).
 * @param {string} [lane]
 * @returns {string}
 */
function laneQueueFile(lane) {
  const l = resolveLane(lane);
  return path.join(LOG_DIR, l === DEFAULT_LANE ? 'runner.queue.json' : `runner.${l}.queue.json`);
}

const LOCK_FILE = laneLockFile();
const PID_FILE = '/tmp/l-concierge-scheduler.pid';
const LINEAR_STATE_FILE = path.join(LOG_DIR, 'linear_state.txt');
const QUEUE_FILE = laneQueueFile();

/**
 * Returns configuration from environment variables.
 * @param {NodeJS.ProcessEnv} env
 */
function getConfig(env) {
  return {
    interval: parseInt(env.INTERVAL || '3600', 10),
    checkInterval: parseInt(env.CHECK_INTERVAL || '60', 10),
    webhookMode: env.WEBHOOK_MODE === 'true'
  };
}

/**
 * Builds the GraphQL query for active issues.
 */
function buildActiveIssuesQuery() {
  return `
    query {
      issues(filter: { state: { type: { in: ["unstarted", "started"] } } }, orderBy: priority, first: 10) {
        nodes {
          id
          identifier
          title
          createdAt
        }
      }
    }
  `;
}

/**
 * Parses active issue identifiers from Linear API response.
 * @param {any} data
 * @returns {string[]}
 */
function parseActiveIdentifiers(data) {
  if (!data || !data.issues || !data.issues.nodes) {
    return [];
  }
  return data.issues.nodes
    .map((node) => node.identifier)
    .filter((id) => !!id);
}

/**
 * Parses active issues with their Linear creation time from the API response (SOT-1637).
 * Returns [{ identifier, createdAt }] so the scheduler can carry createdAt onto queue items and
 * execute todos in creation order. Nodes without an identifier are dropped.
 * @param {any} data
 * @returns {{ identifier: string, createdAt: string | null }[]}
 */
function parseActiveIssueMeta(data) {
  if (!data || !data.issues || !data.issues.nodes) {
    return [];
  }
  return data.issues.nodes
    .filter((node) => !!node.identifier)
    .map((node) => ({ identifier: node.identifier, createdAt: node.createdAt || null }));
}

/**
 * Formats status lines for the CLI.
 * @param {{
 *   running: boolean,
 *   pid?: string,
 *   schedulerLog: string,
 *   linearState?: string,
 *   hasLinearKey: boolean,
 *   checkInterval: number,
 *   interval: number
 * }} params
 * @returns {string[]}
 */
function formatStatusLines({
  running,
  pid,
  schedulerLog,
  linearState,
  hasLinearKey,
  checkInterval,
  interval,
}) {
  const lines = [];
  if (running) {
    lines.push(`Scheduler is running (PID: ${pid})`);
    lines.push(`Log: ${schedulerLog}`);
    if (linearState) {
      lines.push(`Last Linear updatedAt: ${linearState}`);
    } else {
      lines.push(`Last Linear updatedAt: (not yet checked)`);
    }
    if (hasLinearKey) {
      lines.push(`Mode: Linear polling (CHECK_INTERVAL=${checkInterval}s)`);
    } else {
      lines.push(`Mode: Fixed interval fallback (INTERVAL=${interval}s) — set LINEAR_API_KEY to enable Linear polling`);
    }
  } else {
    if (pid) {
      lines.push(`Scheduler not running (stale PID file)`);
    } else {
      lines.push(`Scheduler is not running`);
    }
  }
  return lines;
}

export {
  LOG_DIR,
  AUTO_RUNNER_LOG,
  SCHEDULER_LOG,
  DEFAULT_LANE,
  resolveLane,
  laneLockFile,
  laneQueueFile,
  LOCK_FILE,
  PID_FILE,
  LINEAR_STATE_FILE,
  QUEUE_FILE,
  getConfig,
  buildActiveIssuesQuery,
  parseActiveIdentifiers,
  parseActiveIssueMeta,
  formatStatusLines,
};
