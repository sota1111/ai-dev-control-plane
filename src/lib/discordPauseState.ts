'use strict';

import fs from 'node:fs';
import path from 'node:path';
import * as runner from '../runner.js';

const PAUSE_FILE: string = path.join(runner.LOG_DIR, 'runner.pause');

interface PauseInfo {
  pausedAt: string;
  reason: string;
}

function isPaused(): boolean {
  return fs.existsSync(PAUSE_FILE);
}

function setPaused(reason: string = 'Discord /pause command'): void {
  fs.writeFileSync(PAUSE_FILE, JSON.stringify({
    pausedAt: new Date().toISOString(),
    reason,
  }), 'utf8');
}

function clearPause(): boolean {
  if (fs.existsSync(PAUSE_FILE)) {
    fs.unlinkSync(PAUSE_FILE);
    return true;
  }
  return false;
}

function getPauseInfo(): PauseInfo | null {
  if (!fs.existsSync(PAUSE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
  } catch {
    return { pausedAt: 'unknown', reason: 'unknown' };
  }
}

export { isPaused, setPaused, clearPause, getPauseInfo, PAUSE_FILE };
