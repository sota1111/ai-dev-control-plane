/**
 * Lane worktree 供給（SOT-932, 案A 第2ステップ）。
 *
 * `RUNNER_SERIALIZE_SCOPE=branch` のとき、lane キーは `repo--branch` で導出される
 * （SOT-931 / src/runner.ts:serializationLaneKey）。同一 repo・別 branch を同時に書くと
 * 共有クローンの作業ツリーが競合・破損するため、非 default lane には専用の git worktree
 * （自動採番 branch）を割り当て、別 branch を独立チェックアウトで安全に並行実行できるようにする。
 *
 * 後方互換: default lane（= `RUNNER_SERIALIZE_SCOPE=repo` の既定経路）は worktree を一切使わず、
 * 元の repo ルートをそのまま working dir として返す。同一 branch は同一 lane = 同一 worktree =
 * 直列（安全弁）。worktree の作成・削除は冪等。
 */

import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

/** Default lane name (mirrors runner.DEFAULT_LANE). A default lane never gets a worktree. */
export const DEFAULT_LANE = 'default';

/** Sanitize an arbitrary token to the safe charset `[a-zA-Z0-9_-]` (cannot escape the base dir). */
export function sanitizeLaneToken(raw?: string | null): string {
  return (raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function isDefaultLane(lane?: string | null): boolean {
  const l = sanitizeLaneToken(lane);
  return l === '' || l === DEFAULT_LANE;
}

/**
 * Base directory that holds all worktrees for a given repo. Kept OUTSIDE the repo working tree
 * (sibling `.runner-worktrees/<repo-name>`) so worktrees are never tracked by the repo itself.
 * Overridable via `RUNNER_WORKTREE_BASE` (a per-repo subdir is still appended). Pure (no FS).
 */
export function laneWorktreeBaseDir(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const repoName = path.basename(repoRoot);
  const override = (env.RUNNER_WORKTREE_BASE || '').trim();
  if (override) {
    return path.join(override, repoName);
  }
  return path.join(path.dirname(repoRoot), '.runner-worktrees', repoName);
}

/**
 * Deterministic worktree path for a lane: `<base>/<sanitized-lane>`. Pure (no FS).
 * The sanitized lane cannot contain `/`/`..` so the path can never escape the base dir.
 */
export function laneWorktreePath(
  opts: { repoRoot: string; lane: string; baseDir?: string },
  env: NodeJS.ProcessEnv = process.env
): string {
  const base = opts.baseDir || laneWorktreeBaseDir(opts.repoRoot, env);
  return path.join(base, sanitizeLaneToken(opts.lane));
}

/** Auto-numbered branch name for a lane's worktree (deterministic, lane-safe). */
export function laneWorktreeBranch(lane: string): string {
  return `runner/lane/${sanitizeLaneToken(lane)}`;
}

/** Injectable command runner (so tests can avoid real git). Returns stdout (unused on success). */
export type WorktreeExec = (cmd: string) => string;

const defaultExec: WorktreeExec = (cmd: string) => execSync(cmd, { encoding: 'utf8' });

export interface ProvisionResult {
  /** Working directory the caller should use (worktree path, or repoRoot for default lane). */
  path: string;
  /** Whether a worktree was newly created on this call. */
  created: boolean;
  /** Whether this lane uses a dedicated worktree at all (false for default lane). */
  worktree: boolean;
}

interface ProvisionOpts {
  repoRoot: string;
  lane: string;
  baseDir?: string;
  exec?: WorktreeExec;
}

/** True when `git worktree list` already contains the given path. Best-effort. */
function worktreeAlreadyRegistered(repoRoot: string, wtPath: string, exec: WorktreeExec): boolean {
  try {
    const out = exec(`git -C ${JSON.stringify(repoRoot)} worktree list --porcelain`);
    const resolved = path.resolve(wtPath);
    return out
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .some((l) => path.resolve(l.slice('worktree '.length).trim()) === resolved);
  } catch {
    return false;
  }
}

/**
 * Provision a dedicated git worktree for a non-default lane, idempotently.
 *
 * - default lane → no worktree; returns repoRoot (backward compatible).
 * - existing worktree (dir present or registered) → reuse (`created:false`).
 * - otherwise → `git worktree add -B <laneBranch> <path> HEAD` (`created:true`).
 *
 * Never throws on idempotent re-create. `git worktree add` is run with `-B` so the auto-numbered
 * lane branch is created or reset as needed; the same lane always maps to the same worktree+branch,
 * so 同一 branch は直列 (one worktree) and 別 branch は別 worktree (並行可).
 */
export function provisionLaneWorktree(opts: ProvisionOpts, env: NodeJS.ProcessEnv = process.env): ProvisionResult {
  const { repoRoot, lane } = opts;
  if (isDefaultLane(lane)) {
    return { path: repoRoot, created: false, worktree: false };
  }
  const exec = opts.exec || defaultExec;
  const wtPath = laneWorktreePath({ repoRoot, lane, baseDir: opts.baseDir }, env);

  if (fs.existsSync(wtPath) || worktreeAlreadyRegistered(repoRoot, wtPath, exec)) {
    return { path: wtPath, created: false, worktree: true };
  }

  const branch = laneWorktreeBranch(lane);
  exec(
    `git -C ${JSON.stringify(repoRoot)} worktree add -B ${JSON.stringify(branch)} ${JSON.stringify(wtPath)} HEAD`
  );
  return { path: wtPath, created: true, worktree: true };
}

/**
 * Remove a lane's worktree idempotently. No-op for the default lane. Swallows "not a working tree"
 * / missing-path errors so cleanup is safe to call unconditionally.
 */
export function removeLaneWorktree(opts: ProvisionOpts, env: NodeJS.ProcessEnv = process.env): { removed: boolean } {
  const { repoRoot, lane } = opts;
  if (isDefaultLane(lane)) {
    return { removed: false };
  }
  const exec = opts.exec || defaultExec;
  const wtPath = laneWorktreePath({ repoRoot, lane, baseDir: opts.baseDir }, env);
  try {
    exec(`git -C ${JSON.stringify(repoRoot)} worktree remove --force ${JSON.stringify(wtPath)}`);
    return { removed: true };
  } catch {
    // Already gone / not a registered worktree: idempotent no-op.
    return { removed: false };
  }
}

/**
 * Convenience: resolve the working directory to use for a lane WITHOUT mutating git state when the
 * lane is default. Non-default lanes are provisioned (created if needed). Fail-open: on any error
 * the original repoRoot is returned so a run is never blocked by worktree issues.
 */
export function resolveLaneWorkingDir(opts: ProvisionOpts, env: NodeJS.ProcessEnv = process.env): string {
  if (isDefaultLane(opts.lane)) {
    return opts.repoRoot;
  }
  try {
    return provisionLaneWorktree(opts, env).path;
  } catch {
    return opts.repoRoot;
  }
}
