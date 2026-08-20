import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseRunnerParallelConfig,
  loadRunnerParallelConfig,
  DEFAULT_RUNNER_PARALLEL_CONFIG,
  RUNNER_CONFIG_RELATIVE_PATH,
} from '../lib/runnerConfig.js';

describe('runnerConfig', () => {
  describe('parseRunnerParallelConfig', () => {
    test('valid config is parsed', () => {
      expect(
        parseRunnerParallelConfig({ maxParallel: 2, serializeScope: 'branch', stableMode: true })
      ).toEqual({ maxParallel: 2, serializeScope: 'branch', stableMode: true });
    });

    test('snake_case keys are accepted', () => {
      expect(
        parseRunnerParallelConfig({ max_parallel: 3, serialize_scope: 'repo', stable_mode: true })
      ).toEqual({ maxParallel: 3, serializeScope: 'repo', stableMode: true });
    });

    test('missing/invalid fields fall back to serial defaults', () => {
      expect(parseRunnerParallelConfig({})).toEqual(DEFAULT_RUNNER_PARALLEL_CONFIG);
      expect(parseRunnerParallelConfig(null)).toEqual(DEFAULT_RUNNER_PARALLEL_CONFIG);
      expect(parseRunnerParallelConfig({ maxParallel: 0 }).maxParallel).toBe(1);
      expect(parseRunnerParallelConfig({ maxParallel: -5 }).maxParallel).toBe(1);
      expect(parseRunnerParallelConfig({ maxParallel: 'x' }).maxParallel).toBe(1);
      expect(parseRunnerParallelConfig({ serializeScope: 'nonsense' }).serializeScope).toBe('repo');
      expect(parseRunnerParallelConfig({ stableMode: 'yes' }).stableMode).toBe(false);
    });

    test('maxParallel is floored to an integer', () => {
      expect(parseRunnerParallelConfig({ maxParallel: 2.9 }).maxParallel).toBe(2);
    });
  });

  describe('loadRunnerParallelConfig', () => {
    test('missing file → serial defaults (fail-open, backward compatible)', () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnercfg-'));
      expect(loadRunnerParallelConfig(emptyDir)).toEqual(DEFAULT_RUNNER_PARALLEL_CONFIG);
    });

    test('malformed JSON → serial defaults (never throws)', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnercfg-'));
      fs.mkdirSync(path.dirname(path.join(dir, RUNNER_CONFIG_RELATIVE_PATH)), { recursive: true });
      fs.writeFileSync(path.join(dir, RUNNER_CONFIG_RELATIVE_PATH), '{ not json');
      expect(loadRunnerParallelConfig(dir)).toEqual(DEFAULT_RUNNER_PARALLEL_CONFIG);
    });

    test('reads a valid file from the given root', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runnercfg-'));
      fs.mkdirSync(path.dirname(path.join(dir, RUNNER_CONFIG_RELATIVE_PATH)), { recursive: true });
      fs.writeFileSync(
        path.join(dir, RUNNER_CONFIG_RELATIVE_PATH),
        JSON.stringify({ maxParallel: 4, serializeScope: 'branch', stableMode: false })
      );
      expect(loadRunnerParallelConfig(dir)).toEqual({
        maxParallel: 4,
        serializeScope: 'branch',
        stableMode: false,
      });
    });
  });

  describe('shipped config/runner.json', () => {
    test('enables the pool (maxParallel >= 2, repo scope, stableMode off)', () => {
      const cfg = loadRunnerParallelConfig();
      expect(cfg.maxParallel).toBeGreaterThanOrEqual(2);
      expect(cfg.serializeScope).toBe('repo');
      expect(cfg.stableMode).toBe(false);
    });
  });
});
