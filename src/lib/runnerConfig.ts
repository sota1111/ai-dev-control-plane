/**
 * Runner concurrency / parallel-execution config loader (config/runner.json).
 *
 * The parallel-drain settings (N-slot pool size, serialization scope, stable-mode kill-switch) are
 * kept OUT of `.env` — they live in a committed `config/runner.json` so the steady-state concurrency
 * policy is version-controlled and reviewable, consistent with the other `config/*.json` files
 * (worker_roles.json, auto_accept.json, …). Runtime env vars still OVERRIDE the config when explicitly
 * set (RUNNER_MAX_PARALLEL / RUNNER_SERIALIZE_SCOPE / RUNNER_STABLE_MODE) for temporary operational
 * changes without editing the committed file.
 *
 * Pure + fail-open: a missing / unreadable / malformed config yields the backward-compatible serial
 * defaults ({ maxParallel: 1, serializeScope: 'repo', stableMode: false }), so removing the file
 * reverts to the historical fully-serial drain.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SerializeScope = 'repo' | 'branch';

export interface RunnerParallelConfig {
  /** N-slot pool size: distinct-lane items dispatched concurrently. 1 = fully serial. */
  maxParallel: number;
  /** 'repo' = 同一repo直列/別repo並行 (default). 'branch' = 別branchも別lane. */
  serializeScope: SerializeScope;
  /** true forces fully-serial (emergency kill-switch). */
  stableMode: boolean;
}

/** Backward-compatible serial defaults (used when the config is missing/invalid). */
export const DEFAULT_RUNNER_PARALLEL_CONFIG: RunnerParallelConfig = {
  maxParallel: 1,
  serializeScope: 'repo',
  stableMode: false,
};

/** Repo-root-relative location of the committed runner config. */
export const RUNNER_CONFIG_RELATIVE_PATH = 'config/runner.json';

function repoRoot(): string {
  // src/lib/runnerConfig.ts → repo root is two levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
}

/**
 * Parse a raw JSON value into a validated RunnerParallelConfig. Unknown / out-of-range fields fall
 * back to the serial default for that field (never throws). Exported for tests.
 */
export function parseRunnerParallelConfig(raw: unknown): RunnerParallelConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RUNNER_PARALLEL_CONFIG };
  const o = raw as Record<string, unknown>;
  const mpRaw = o.maxParallel ?? o.max_parallel;
  const maxParallel =
    typeof mpRaw === 'number' && Number.isFinite(mpRaw) && mpRaw >= 1
      ? Math.floor(mpRaw)
      : DEFAULT_RUNNER_PARALLEL_CONFIG.maxParallel;
  const scopeRaw = o.serializeScope ?? o.serialize_scope;
  const serializeScope: SerializeScope = scopeRaw === 'branch' ? 'branch' : 'repo';
  const stableMode = o.stableMode === true || o.stable_mode === true;
  return { maxParallel, serializeScope, stableMode };
}

/** Read + parse config/runner.json from the repo root. Fail-open to the serial defaults. */
export function loadRunnerParallelConfig(rootDir: string = repoRoot()): RunnerParallelConfig {
  try {
    const file = path.join(rootDir, RUNNER_CONFIG_RELATIVE_PATH);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parseRunnerParallelConfig(raw);
  } catch {
    return { ...DEFAULT_RUNNER_PARALLEL_CONFIG };
  }
}
