// Linearプロジェクト名から開発対象レポジトリを判定する解決モジュール。
//
// 権威マッピングは `config/project_repos.json`（Linear project name → repo / localPath）。
// project_repos.json に無いプロジェクトは、既存の `config/auth/apps.json` の `name` を
// フォールバック参照する（データの二重管理を避けるため）。不明なプロジェクトは null を返す。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// repo root = src/lib/.. /.. (this file lives in src/lib/)
const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'project_repos.json');
const APPS_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'auth', 'apps.json');

export interface ProjectRepo {
  project: string;
  repo: string | null;
  localPath: string;
}

/**
 * `config/project_repos.json` を読み込み・検証して ProjectRepo[] を返す。
 * 設定が壊れている場合は明確な Error を投げる。
 */
export function loadProjectRepoConfig(configPath: string = DEFAULT_CONFIG_PATH): ProjectRepo[] {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err: any) {
    throw new Error(`project_repos config not found at ${configPath}: ${err.message}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`project_repos config is not valid JSON (${configPath}): ${err.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`project_repos config must be an array (${configPath})`);
  }

  return parsed.map((entry: any, i: number) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`project_repos[${i}] must be an object (${configPath})`);
    }
    if (typeof entry.project !== 'string' || entry.project.trim() === '') {
      throw new Error(`project_repos[${i}].project must be a non-empty string (${configPath})`);
    }
    if (typeof entry.localPath !== 'string' || entry.localPath.trim() === '') {
      throw new Error(`project_repos[${i}].localPath must be a non-empty string (${configPath})`);
    }
    return {
      project: entry.project,
      repo: typeof entry.repo === 'string' ? entry.repo : null,
      localPath: entry.localPath,
    };
  });
}

// config/auth/apps.json をフォールバック参照用に読み込む（失敗時は空配列）。
function loadAppsFallback(): ProjectRepo[] {
  try {
    const raw = fs.readFileSync(APPS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((a: any) => a && typeof a.name === 'string' && typeof a.localPath === 'string')
      .map((a: any) => ({
        project: a.name,
        repo: typeof a.repo === 'string' ? a.repo : null,
        localPath: a.localPath,
      }));
  } catch {
    return [];
  }
}

/**
 * Linearプロジェクト名から ProjectRepo を解決する。
 * - 一致は前後空白を除去し、大文字小文字を無視して行う。
 * - project_repos.json に無い場合は config/auth/apps.json の name にフォールバック。
 * - 不明・空のプロジェクト名は null（例外は投げない）。
 */
export function resolveRepoForProject(
  projectName: string,
  config?: ProjectRepo[]
): ProjectRepo | null {
  if (typeof projectName !== 'string') return null;
  const key = projectName.trim().toLowerCase();
  if (key === '') return null;

  const primary = config ?? loadProjectRepoConfig();
  const direct = primary.find((e) => e.project.trim().toLowerCase() === key);
  if (direct) return direct;

  // フォールバック: apps.json（呼び出し側が config を渡した場合はスキップ）
  if (!config) {
    const fallback = loadAppsFallback().find((e) => e.project.trim().toLowerCase() === key);
    if (fallback) return fallback;
  }

  return null;
}
