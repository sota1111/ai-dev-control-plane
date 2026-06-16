'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { classifyUsageLimit } = require('./usageLimitParser');
const { buildSessionContinueMetadata, saveResumeMetadata, formatResumeLogLines } = require('./resumeMetadata');

/**
 * Default command runner using child_process.execSync.
 */
function defaultExec(cmd) {
  try {
    const stdout = execSync(cmd, { encoding: 'utf8' }).trim();
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Checks if a tmux pane exists.
 */
function paneExists(paneId, exec = defaultExec) {
  const result = exec('tmux list-panes -a -F "#{pane_id}"');
  if (!result.ok) return false;
  const panes = result.stdout.split('\n');
  return panes.includes(paneId);
}

/**
 * Gets info about a tmux pane.
 */
function getPaneInfo(paneId, exec = defaultExec) {
  const result = exec(`tmux display-message -p -t ${paneId} '#{session_name}|#{window_name}|#{pane_id}|#{pane_current_command}'`);
  if (!result.ok) return null;
  const [session, window, pane, foregroundProcess] = result.stdout.split('|');
  return { session, window, pane, foregroundProcess };
}

/**
 * Captures the content of a tmux pane.
 */
function capturePane(paneId, exec = defaultExec) {
  const result = exec(`tmux capture-pane -p -t ${paneId}`);
  if (!result.ok) return '';
  return result.stdout;
}

/**
 * Checks if the foreground process is Claude.
 */
function isClaudeForeground(foregroundProcess) {
  if (!foregroundProcess) return false;
  const proc = foregroundProcess.toLowerCase();
  // Claude Code often runs as 'claude' or 'node' (if via npx/node)
  // The instructions say prefer matching 'claude' but also accept 'node' if needed.
  return proc.includes('claude') || proc === 'node';
}

/**
 * Detects a usage limit in the pane output.
 */
function detectLimitInPane(paneId, nowMs = Date.now(), exec = defaultExec) {
  const text = capturePane(paneId, exec);
  if (!text) return { detected: false, classification: null, rawText: '' };
  const classification = classifyUsageLimit(text, nowMs);
  return {
    detected: classification.type !== 'unknown',
    classification: classification.type !== 'unknown' ? classification : null,
    rawText: text
  };
}

/**
 * Sends the 'continue' command to a tmux pane.
 */
function sendContinue(paneId, exec = defaultExec) {
  // Key sequence: Escape, 'continue', Enter
  const cmd1 = exec(`tmux send-keys -t ${paneId} Escape`);
  const cmd2 = exec(`tmux send-keys -t ${paneId} 'continue'`);
  const cmd3 = exec(`tmux send-keys -t ${paneId} Enter`);
  return { ok: cmd1.ok && cmd2.ok && cmd3.ok };
}

/**
 * State file path helper.
 */
function getSessionContinueStatePath(baseDir) {
  const root = baseDir || path.join(__dirname, '..', '..');
  return path.join(root, 'docs', 'ai', 'auto_logs', 'runner.session-continue.json');
}

/**
 * Reads the session-continue state.
 */
function readSessionContinueState(baseDir) {
  const filePath = getSessionContinueStatePath(baseDir);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Writes the session-continue state atomically.
 */
function writeSessionContinueState(state, baseDir) {
  const filePath = getSessionContinueStatePath(baseDir);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = JSON.stringify(state, null, 2);
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Orchestrates session-continue attempt.
 */
async function attemptSessionContinue({
  paneId,
  issueId = null,
  nowMs = Date.now(),
  baseDir,
  exec = defaultExec,
  notify = () => {},
  logger = () => {}
}) {
  const projectRoot = baseDir || path.join(__dirname, '..', '..');
  const autoLogsDir = path.join(projectRoot, 'docs', 'ai', 'auto_logs');

  if (!paneExists(paneId, exec)) {
    const msg = `[SESSION-CONTINUE] Pane ${paneId} not found.`;
    logger(msg);
    notify(msg);
    return { status: 'pane_missing' };
  }

  const paneInfo = getPaneInfo(paneId, exec);
  const detection = detectLimitInPane(paneId, nowMs, exec);

  if (!detection.detected) {
    return { status: 'no_limit' };
  }

  const { classification } = detection;
  const metadata = buildSessionContinueMetadata({
    issueId,
    stoppedReason: 'usage_limit',
    stoppedAt: new Date(nowMs).toISOString(),
    resetAt: classification.resetAt,
    retryAt: classification.retryAt,
    tmuxSession: paneInfo.session,
    tmuxWindow: paneInfo.window,
    tmuxPane: paneId,
    foregroundProcess: paneInfo.foregroundProcess,
    lastDetectedLimitMessage: classification.rawMessage
  });

  saveResumeMetadata(metadata, autoLogsDir);

  const state = {
    paneId,
    issueId,
    status: 'waiting',
    resetAt: classification.resetAt,
    retryAt: classification.retryAt,
    tmuxSession: paneInfo.session,
    tmuxWindow: paneInfo.window,
    foregroundProcess: paneInfo.foregroundProcess,
    updatedAt: new Date(nowMs).toISOString()
  };

  const logLines = formatResumeLogLines(metadata, { action: 'send-continue' });
  logLines.forEach(line => logger(line));

  const nowIso = new Date(nowMs).toISOString();
  const isFuture = classification.retryAt && classification.retryAt > nowIso;

  if (isFuture) {
    writeSessionContinueState(state, projectRoot);
    const msg = `[SESSION-CONTINUE] Limit detected in ${paneId}. Waiting until ${classification.retryAt}.`;
    logger(msg);
    notify(msg);
    return { status: 'waiting' };
  }

  if (!isClaudeForeground(paneInfo.foregroundProcess)) {
    state.status = 'foreground_mismatch';
    writeSessionContinueState(state, projectRoot);
    const msg = `[SESSION-CONTINUE] Foreground process in ${paneId} is '${paneInfo.foregroundProcess}', not Claude. Human action needed.`;
    logger(msg);
    notify(msg);
    return { status: 'foreground_mismatch' };
  }

  const sendResult = sendContinue(paneId, exec);
  if (sendResult.ok) {
    state.status = 'sent';
    writeSessionContinueState(state, projectRoot);
    const msg = `[SESSION-CONTINUE] Sent 'continue' to ${paneId}.`;
    logger(msg);
    notify(msg);
    return { status: 'sent' };
  } else {
    const msg = `[SESSION-CONTINUE] Failed to send 'continue' to ${paneId}.`;
    logger(msg);
    notify(msg);
    return { status: 'send_failed' };
  }
}

module.exports = {
  paneExists,
  getPaneInfo,
  capturePane,
  isClaudeForeground,
  detectLimitInPane,
  sendContinue,
  attemptSessionContinue,
  readSessionContinueState,
  writeSessionContinueState,
  defaultExec
};
