'use strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, '..', '..', 'docs', 'ai', 'auto_logs');
const AUTO_RUNNER_LOG = path.join(LOG_DIR, 'auto_runner.log');
const SCHEDULER_LOG = path.join(LOG_DIR, 'scheduler.log');
const LOCK_FILE = path.join(LOG_DIR, 'runner.lock');
const PID_FILE = '/tmp/l-concierge-scheduler.pid';
const LINEAR_STATE_FILE = path.join(LOG_DIR, 'linear_state.txt');
const QUEUE_FILE = path.join(LOG_DIR, 'runner.queue.json');

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
  LOCK_FILE,
  PID_FILE,
  LINEAR_STATE_FILE,
  QUEUE_FILE,
  getConfig,
  buildActiveIssuesQuery,
  parseActiveIdentifiers,
  formatStatusLines,
};
