import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  attemptSessionContinue,
  isClaudeForeground
} from '../lib/sessionContinue.js';

describe('sessionContinue', () => {
  const PANE_ID = '%7';
  const NOW_MS = Date.UTC(2026, 5, 16, 18, 0, 0);
  const PAST_LIMIT_TEXT = "You've hit your session limit. Your limit will reset at Jun 15, 3:30pm (UTC).";
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-continue-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createExec({ panes = [PANE_ID], foreground = 'claude', capture = PAST_LIMIT_TEXT } = {}) {
    const calls: string[] = [];
    const exec = jest.fn((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'tmux list-panes -a -F "#{pane_id}"') {
        return { ok: true, stdout: panes.join('\n') };
      }
      if (cmd.startsWith('tmux display-message')) {
        return { ok: true, stdout: `dev|worker|${PANE_ID}|${foreground}` };
      }
      if (cmd.startsWith('tmux capture-pane')) {
        return { ok: true, stdout: capture };
      }
      if (cmd.startsWith('tmux send-keys')) {
        return { ok: true, stdout: '' };
      }
      return { ok: false, error: new Error(`Unexpected command: ${cmd}`) };
    });
    (exec as any).calls = calls;
    return exec;
  }

  it('returns pane_missing and does not send keys when the pane does not exist', async () => {
    const exec = createExec({ panes: ['%1', '%2'] });

    const result = await attemptSessionContinue({
      paneId: PANE_ID,
      issueId: 'SOT-647',
      nowMs: NOW_MS,
      baseDir: tmpDir,
      exec
    });

    expect(result).toEqual({ status: 'pane_missing' });
    expect((exec as any).calls.some((cmd: string) => cmd.startsWith('tmux send-keys'))).toBe(false);
  });

  it('returns foreground_mismatch and does not send keys when foreground is not Claude', async () => {
    const exec = createExec({ foreground: 'vim' });

    const result = await attemptSessionContinue({
      paneId: PANE_ID,
      issueId: 'SOT-647',
      nowMs: NOW_MS,
      baseDir: tmpDir,
      exec
    });

    expect(result).toEqual({ status: 'foreground_mismatch' });
    expect((exec as any).calls.some((cmd: string) => cmd.startsWith('tmux send-keys'))).toBe(false);
  });

  it('sends Escape, continue, and Enter when a past limit is detected in Claude', async () => {
    const exec = createExec({ foreground: 'claude' });

    const result = await attemptSessionContinue({
      paneId: PANE_ID,
      issueId: 'SOT-647',
      nowMs: NOW_MS,
      baseDir: tmpDir,
      exec
    });

    expect(result).toEqual({ status: 'sent' });
    expect((exec as any).calls.filter((cmd: string) => cmd.startsWith('tmux send-keys'))).toEqual([
      `tmux send-keys -t ${PANE_ID} Escape`,
      `tmux send-keys -t ${PANE_ID} 'continue'`,
      `tmux send-keys -t ${PANE_ID} Enter`
    ]);
  });

  it('returns no_limit for benign pane text', async () => {
    const exec = createExec({ capture: 'No errors. Waiting for the next command.' });

    const result = await attemptSessionContinue({
      paneId: PANE_ID,
      issueId: 'SOT-647',
      nowMs: NOW_MS,
      baseDir: tmpDir,
      exec
    });

    expect(result).toEqual({ status: 'no_limit' });
    expect((exec as any).calls.some((cmd: string) => cmd.startsWith('tmux send-keys'))).toBe(false);
  });

  it('identifies Claude foreground processes', () => {
    expect(isClaudeForeground('claude')).toBe(true);
    expect(isClaudeForeground('vim')).toBe(false);
    expect(isClaudeForeground('bash')).toBe(false);
    expect(isClaudeForeground(undefined)).toBe(false);
  });
});
