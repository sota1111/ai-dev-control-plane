const fs = require('fs');
const path = require('path');

/**
 * Builds metadata for rerunning an issue.
 */
function buildIssueRerunMetadata({
  issueId,
  stoppedReason,
  stoppedAt,
  resetAt,
  retryAt,
  branch,
  lastCommit,
  gitStatus,
  previousRunLog,
  previousExitCode,
  nextActionHint
}) {
  return {
    issueId,
    resumeMode: 'issue-rerun',
    stoppedReason,
    stoppedAt,
    resetAt: resetAt || null,
    retryAt: retryAt || null,
    branch: branch || null,
    lastCommit: lastCommit || null,
    gitStatus: gitStatus || null,
    previousRunLog: previousRunLog || null,
    previousExitCode: previousExitCode !== undefined ? previousExitCode : null,
    nextActionHint: nextActionHint || '前回ログを読んで未完了作業から再開する'
  };
}

/**
 * Builds metadata for continuing a session.
 */
function buildSessionContinueMetadata({
  issueId,
  stoppedReason,
  stoppedAt,
  resetAt,
  retryAt,
  tmuxSession,
  tmuxWindow,
  tmuxPane,
  foregroundProcess,
  lastDetectedLimitMessage
}) {
  return {
    issueId: issueId || null,
    resumeMode: 'session-continue',
    stoppedReason,
    stoppedAt,
    resetAt: resetAt || null,
    retryAt: retryAt || null,
    tmuxSession: tmuxSession || null,
    tmuxWindow: tmuxWindow || null,
    tmuxPane: tmuxPane || null,
    foregroundProcess: foregroundProcess || null,
    lastDetectedLimitMessage: lastDetectedLimitMessage || null
  };
}

/**
 * Returns the path for resume metadata JSON.
 */
function resumeMetadataPath(issueId, baseDir) {
  const root = baseDir || path.join(__dirname, '..', '..', 'docs', 'ai', 'auto_logs');
  const sanitize = (id) => {
    if (!id) return 'session_' + Date.now().toString().slice(-6);
    return id.replace(/[\\/:*?"<>|]/g, '_');
  };
  return path.join(root, 'resume', sanitize(issueId) + '.json');
}

/**
 * Saves resume metadata to a JSON file atomically.
 */
function saveResumeMetadata(metadata, baseDir) {
  const filePath = resumeMetadataPath(metadata.issueId, baseDir);
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = JSON.stringify(metadata, null, 2);
  const tmpPath = filePath + '.tmp';

  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);

  return filePath;
}

/**
 * Formats metadata into [RESUME] log lines.
 */
function formatResumeLogLines(metadata, extra = {}) {
  const lines = [];
  const { resumeMode } = metadata;

  if (resumeMode === 'issue-rerun') {
    lines.push(`[RESUME] issue=${metadata.issueId || ''}`);
    lines.push(`[RESUME] mode=${resumeMode}`);
    lines.push(`[RESUME] reason=${metadata.stoppedReason || ''}`);
    lines.push(`[RESUME] resetAt=${metadata.resetAt || ''}`);
    lines.push(`[RESUME] retryAt=${metadata.retryAt || ''}`);
    lines.push(`[RESUME] branch=${metadata.branch || ''}`);
    const status = (metadata.gitStatus || '').replace(/\r?\n/g, '; ');
    lines.push(`[RESUME] gitStatus=${status}`);
    lines.push(`[RESUME] previousRunLog=${metadata.previousRunLog || ''}`);
    if (extra.queueLength != null) {
      lines.push(`[RESUME] queueLength=${extra.queueLength}`);
    }
  } else if (resumeMode === 'session-continue') {
    lines.push(`[RESUME] issue=${metadata.issueId || ''}`);
    lines.push(`[RESUME] mode=${resumeMode}`);
    lines.push(`[RESUME] tmuxSession=${metadata.tmuxSession || ''}`);
    lines.push(`[RESUME] tmuxWindow=${metadata.tmuxWindow || ''}`);
    lines.push(`[RESUME] tmuxPane=${metadata.tmuxPane || ''}`);
    lines.push(`[RESUME] foregroundProcess=${metadata.foregroundProcess || ''}`);
    lines.push(`[RESUME] resetAt=${metadata.resetAt || ''}`);
    lines.push(`[RESUME] retryAt=${metadata.retryAt || ''}`);
    lines.push(`[RESUME] action=${extra.action || 'send-continue'}`);
  }

  return lines;
}

module.exports = {
  buildIssueRerunMetadata,
  buildSessionContinueMetadata,
  resumeMetadataPath,
  saveResumeMetadata,
  formatResumeLogLines
};
