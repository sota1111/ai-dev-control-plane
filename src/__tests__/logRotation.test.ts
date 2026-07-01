import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseLogLevel,
  levelForTag,
  shouldLog,
  rotateIfNeeded,
  listLogFilesNewestFirst,
} from '../lib/logRotation.js';

// SOT-1421 — runner log rotation + levels.
describe('logRotation', () => {
  describe('parseLogLevel', () => {
    test('defaults to info for undefined / invalid', () => {
      expect(parseLogLevel(undefined)).toBe('info');
      expect(parseLogLevel('')).toBe('info');
      expect(parseLogLevel('nonsense')).toBe('info');
    });
    test('normalizes case and whitespace', () => {
      expect(parseLogLevel('WARN')).toBe('warn');
      expect(parseLogLevel(' debug ')).toBe('debug');
      expect(parseLogLevel('Error')).toBe('error');
    });
  });

  describe('levelForTag', () => {
    test('maps known severity tags, everything else to info', () => {
      expect(levelForTag('ERROR')).toBe('error');
      expect(levelForTag('WARN')).toBe('warn');
      expect(levelForTag('DEBUG')).toBe('debug');
      expect(levelForTag('RUNNER')).toBe('info');
      expect(levelForTag('RUN')).toBe('info');
      expect(levelForTag('OUTCOME')).toBe('info');
      expect(levelForTag('error')).toBe('error'); // case-insensitive
    });
  });

  describe('shouldLog', () => {
    test('info threshold allows info/warn/error, blocks debug', () => {
      expect(shouldLog('debug', 'info')).toBe(false);
      expect(shouldLog('info', 'info')).toBe(true);
      expect(shouldLog('warn', 'info')).toBe(true);
      expect(shouldLog('error', 'info')).toBe(true);
    });
    test('warn threshold blocks info and debug', () => {
      expect(shouldLog('info', 'warn')).toBe(false);
      expect(shouldLog('debug', 'warn')).toBe(false);
      expect(shouldLog('warn', 'warn')).toBe(true);
      expect(shouldLog('error', 'warn')).toBe(true);
    });
  });

  describe('rotateIfNeeded / listLogFilesNewestFirst', () => {
    let dir: string;
    let logFile: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logrot-'));
      logFile = path.join(dir, 'auto_runner.log');
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    test('rotates when file reaches maxBytes and preserves content in .1', () => {
      fs.writeFileSync(logFile, 'x'.repeat(100));
      const rotated = rotateIfNeeded(logFile, 50, 5);
      expect(rotated).toBe(true);
      expect(fs.existsSync(logFile)).toBe(false); // base moved to .1
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      expect(fs.readFileSync(`${logFile}.1`, 'utf8')).toBe('x'.repeat(100));
    });

    test('does nothing below threshold or when disabled', () => {
      fs.writeFileSync(logFile, 'small');
      expect(rotateIfNeeded(logFile, 1000, 5)).toBe(false);
      expect(fs.existsSync(`${logFile}.1`)).toBe(false);
      // maxBytes <= 0 disables rotation even for a large file
      fs.writeFileSync(logFile, 'x'.repeat(100));
      expect(rotateIfNeeded(logFile, 0, 5)).toBe(false);
      expect(fs.existsSync(`${logFile}.1`)).toBe(false);
    });

    test('missing file is a no-op', () => {
      expect(rotateIfNeeded(logFile, 10, 5)).toBe(false);
    });

    test('keeps at most maxFiles generations, dropping the oldest', () => {
      const maxFiles = 2;
      // Rotate three times; only base + .1 + .2 may exist, never .3.
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(logFile, `gen${i}-${'x'.repeat(100)}`);
        expect(rotateIfNeeded(logFile, 50, maxFiles)).toBe(true);
      }
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      expect(fs.existsSync(`${logFile}.2`)).toBe(true);
      expect(fs.existsSync(`${logFile}.3`)).toBe(false);
    });

    test('listLogFilesNewestFirst returns existing files newest-first, omitting gaps', () => {
      fs.writeFileSync(logFile, 'base');
      fs.writeFileSync(`${logFile}.1`, 'one');
      // no .2
      fs.writeFileSync(`${logFile}.3`, 'three');
      const files = listLogFilesNewestFirst(logFile, 5);
      expect(files).toEqual([logFile, `${logFile}.1`, `${logFile}.3`]);
    });

    test('listLogFilesNewestFirst returns empty when nothing exists', () => {
      expect(listLogFilesNewestFirst(logFile, 5)).toEqual([]);
    });
  });
});
