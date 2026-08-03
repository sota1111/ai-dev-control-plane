// Linearプロジェクト名から開発対象レポジトリを判定する解決モジュール。
//
// 権威マッピングは `config/project_repos.json`（Linear project name → repo / localPath）。
// project_repos.json に無いプロジェクトは、既存の `config/auth/apps.json` の `name` を
// フォールバック参照する（データの二重管理を避けるため）。
// それでも見つからないプロジェクトは、命名規約 `/workspaces/<project-slug>` から repo を
// **自動導出**する（SOT-2128 の REPO_RESOLUTION_UNAVAILABLE 対策）。導出は checkout が実在
// （`<localPath>/.git` あり）する場合だけ成功し、無ければ従来どおり null（fail-closed：
// 誤レポジトリ実行を防ぐ安全側）。不明・空のプロジェクト名は null を返す。

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

// 自動導出の既定（config/auth/apps.json や project_repos.json と同じ命名規約）。
const DEFAULT_WORKSPACE_ROOT = '/workspaces';
const DEFAULT_OWNER = 'sota1111';

/**
 * GitHub repo 名として安全な slug に変換する（小文字・英数・ハイフン）。
 * 既存の projectRepoCreate.slugify と同一規則（循環 import を避けるためここに複製）。
 */
function slugifyProject(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

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

export interface DeriveRepoOpts {
  /** checkout を探すルート（既定 `/workspaces`）。 */
  workspaceRoot?: string;
  /** repo owner（既定 `sota1111`）。repo フィールド（メタ情報）にのみ使う。 */
  owner?: string;
  /**
   * localPath が有効な checkout かの判定（テスト注入用）。既定は `<localPath>/.git` の存在確認。
   * ここを通った場合だけ自動紐付けが成立する（実在しない dir へ誤ルーティングしないため）。
   */
  exists?: (localPath: string) => boolean;
}

const defaultCheckoutExists = (localPath: string): boolean => {
  try {
    return fs.existsSync(path.join(localPath, '.git'));
  } catch {
    return false;
  }
};

/**
 * Linearプロジェクト名から命名規約で ProjectRepo を自動導出する（明示マッピングが無いとき用）。
 * `<workspaceRoot>/<slug(project)>` に checkout が実在する場合だけ mapping を返し、無ければ null。
 * 純関数（`exists` 以外の副作用なし・config を書かない）。永続化は呼び出し側（runner）が行う。
 */
export function deriveRepoForProject(
  projectName: string,
  opts: DeriveRepoOpts = {}
): ProjectRepo | null {
  if (typeof projectName !== 'string') return null;
  const slug = slugifyProject(projectName.trim());
  if (!slug) return null;
  const workspaceRoot = opts.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const owner = opts.owner ?? DEFAULT_OWNER;
  const exists = opts.exists ?? defaultCheckoutExists;
  const localPath = path.join(workspaceRoot, slug);
  if (!exists(localPath)) return null;
  return { project: projectName.trim(), repo: `${owner}/${slug}`, localPath };
}

/**
 * Linearプロジェクト名から ProjectRepo を解決する。
 * - 一致は前後空白を除去し、大文字小文字を無視して行う。
 * - project_repos.json に無い場合は config/auth/apps.json の name にフォールバック。
 * - それでも無ければ命名規約から自動導出（checkout 実在時のみ・SOT-2128）。
 * - 不明・空のプロジェクト名は null（例外は投げない）。
 *
 * `config` を明示指定した呼び出し（テスト等）では apps.json フォールバックと自動導出はスキップし、
 * 渡された config だけで判定する（決定的）。
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

  // フォールバック: apps.json + 命名規約の自動導出（呼び出し側が config を渡した場合はスキップ）
  if (!config) {
    const fallback = loadAppsFallback().find((e) => e.project.trim().toLowerCase() === key);
    if (fallback) return fallback;
    const derived = deriveRepoForProject(projectName);
    if (derived) return derived;
  }

  return null;
}
