'use strict';

const fs = require('fs');
const path = require('path');
const runner = require('../runner');

const PAUSE_FILE = path.join(runner.LOG_DIR, 'runner.pause');

function isPaused() {
  return fs.existsSync(PAUSE_FILE);
}

function setPaused(reason = 'Discord /pause command') {
  fs.writeFileSync(PAUSE_FILE, JSON.stringify({
    pausedAt: new Date().toISOString(),
    reason,
  }), 'utf8');
}

function clearPause() {
  if (fs.existsSync(PAUSE_FILE)) {
    fs.unlinkSync(PAUSE_FILE);
    return true;
  }
  return false;
}

function getPauseInfo() {
  if (!fs.existsSync(PAUSE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PAUSE_FILE, 'utf8'));
  } catch {
    return { pausedAt: 'unknown', reason: 'unknown' };
  }
}

module.exports = { isPaused, setPaused, clearPause, getPauseInfo, PAUSE_FILE };
