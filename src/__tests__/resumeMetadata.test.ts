import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIssueRerunMetadata,
  buildSessionContinueMetadata,
  saveResumeMetadata,
  formatResumeLogLines
} from '../lib/resumeMetadata.js';

describe('resumeMetadata', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-metadata-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('buildIssueRerunMetadata sets issue-rerun mode and default next action hint', () => {
    const metadata = buildIssueRerunMetadata({
      issueId: 'SOT-647',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z'
    });

    expect(metadata).toMatchObject({
      issueId: 'SOT-647',
      resumeMode: 'issue-rerun',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z',
      nextActionHint: '前回ログを読んで未完了作業から再開する'
    });
  });

  it('buildSessionContinueMetadata sets session-continue mode and tmux fields', () => {
    const metadata = buildSessionContinueMetadata({
      issueId: 'SOT-647',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z',
      tmuxSession: 'dev',
      tmuxWindow: 'worker',
      tmuxPane: '%7',
      foregroundProcess: 'claude'
    });

    expect(metadata).toMatchObject({
      issueId: 'SOT-647',
      resumeMode: 'session-continue',
      tmuxSession: 'dev',
      tmuxWindow: 'worker',
      tmuxPane: '%7',
      foregroundProcess: 'claude'
    });
  });

  it('saveResumeMetadata writes JSON under baseDir/resume/<issueId>.json', () => {
    const metadata = buildIssueRerunMetadata({
      issueId: 'SOT-647',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z'
    });

    const filePath = saveResumeMetadata(metadata, tmpDir);

    expect(filePath).toBe(path.join(tmpDir, 'resume', 'SOT-647.json'));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(metadata);
  });

  it('formatResumeLogLines includes queue length for issue-rerun metadata', () => {
    const metadata = buildIssueRerunMetadata({
      issueId: 'SOT-647',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z',
      resetAt: '2026-06-16T15:30:00.000Z',
      retryAt: '2026-06-16T15:40:00.000Z',
      branch: 'feat/SOT-637-usage-limit-resume',
      gitStatus: ' M src/runner.js'
    });

    expect(formatResumeLogLines(metadata, { queueLength: 3 })).toEqual(
      expect.arrayContaining([
        '[RESUME] issue=SOT-647',
        '[RESUME] mode=issue-rerun',
        '[RESUME] queueLength=3'
      ])
    );
  });

  it('formatResumeLogLines includes send-continue action for session-continue metadata', () => {
    const metadata = buildSessionContinueMetadata({
      issueId: 'SOT-647',
      stoppedReason: 'usage_limit',
      stoppedAt: '2026-06-16T12:00:00.000Z',
      retryAt: '2026-06-16T15:40:00.000Z',
      tmuxSession: 'dev',
      tmuxWindow: 'worker',
      tmuxPane: '%7',
      foregroundProcess: 'claude'
    });

    expect(formatResumeLogLines(metadata)).toEqual(
      expect.arrayContaining([
        '[RESUME] issue=SOT-647',
        '[RESUME] mode=session-continue',
        '[RESUME] tmuxPane=%7',
        '[RESUME] action=send-continue'
      ])
    );
  });
});
