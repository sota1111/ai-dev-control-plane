const fs = require('fs');
const path = require('path');

export {};

interface IssueRerunMetadata {
  issueId: string;
  resumeMode: 'issue-rerun';
  stoppedReason?: string;
  stoppedAt: string;
  resetAt: string | null;
  retryAt: string | null;
  branch: string | null;
  lastCommit: string | null;
  gitStatus: string | null;
  previousRunLog: string | null;
  previousExitCode: number | null;
  nextActionHint: string;
}

interface SessionContinueMetadata {
  issueId: string | null;
  resumeMode: 'session-continue';
  stoppedReason?: string;
  stoppedAt: string;
  resetAt: string | null;
  retryAt: string | null;
  tmuxSession: string | null;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  foregroundProcess: string | null;
  lastDetectedLimitMessage: string | null;
}

type ResumeMetadata = IssueRerunMetadata | SessionContinueMetadata;

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
}: any): IssueRerunMetadata {
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
}: any): SessionContinueMetadata {
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
function resumeMetadataPath(issueId: string | null | undefined, baseDir?: string): string {
  const root = baseDir || path.join(__dirname, '..', '..', 'docs', 'ai', 'auto_logs');
  const sanitize = (id: string | null | undefined) => {
    if (!id) return 'session_' + Date.now().toString().slice(-6);
    return id.replace(/[\\/:*?"<>|]/g, '_');
  };
  return path.join(root, 'resume', sanitize(issueId) + '.json');
}

/**
 * Saves resume metadata to a JSON file atomically.
 */
function saveResumeMetadata(metadata: ResumeMetadata, baseDir?: string): string {
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
function formatResumeLogLines(metadata: ResumeMetadata, extra: any = {}): string[] {
  const lines: string[] = [];
  const { resumeMode } = metadata;

  if (resumeMode === 'issue-rerun') {
    const m = metadata as IssueRerunMetadata;
    lines.push(`[RESUME] issue=${m.issueId || ''}`);
    lines.push(`[RESUME] mode=${resumeMode}`);
    lines.push(`[RESUME] reason=${m.stoppedReason || ''}`);
    lines.push(`[RESUME] resetAt=${m.resetAt || ''}`);
    lines.push(`[RESUME] retryAt=${m.retryAt || ''}`);
    lines.push(`[RESUME] branch=${m.branch || ''}`);
    const status = (m.gitStatus || '').replace(/\r?\n/g, '; ');
    lines.push(`[RESUME] gitStatus=${status}`);
    lines.push(`[RESUME] previousRunLog=${m.previousRunLog || ''}`);
    if (extra.queueLength != null) {
      lines.push(`[RESUME] queueLength=${extra.queueLength}`);
    }
  } else if (resumeMode === 'session-continue') {
    const m = metadata as SessionContinueMetadata;
    lines.push(`[RESUME] issue=${m.issueId || ''}`);
    lines.push(`[RESUME] mode=${resumeMode}`);
    lines.push(`[RESUME] tmuxSession=${m.tmuxSession || ''}`);
    lines.push(`[RESUME] tmuxWindow=${m.tmuxWindow || ''}`);
    lines.push(`[RESUME] tmuxPane=${m.tmuxPane || ''}`);
    lines.push(`[RESUME] foregroundProcess=${m.foregroundProcess || ''}`);
    lines.push(`[RESUME] resetAt=${m.resetAt || ''}`);
    lines.push(`[RESUME] retryAt=${m.retryAt || ''}`);
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
