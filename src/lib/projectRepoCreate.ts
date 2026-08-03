// Linear「New」プロジェクト用の新規レポジトリ作成モジュール。
//
// Linear issue が属するプロジェクト名が "New" のとき、既存レポジトリではなく
// owner `sota1111` 配下に空の public レポジトリを新規作成し、`/workspaces/<name>` へ clone、
// `config/project_repos.json` へ追記する。トリガー判定・名前導出・config 追記は純関数として
// 切り出してユニットテスト可能にし、gh/git/fs 副作用は注入可能な runner 経由で実行する。

import fs from 'node:fs';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadProjectRepoConfig, ProjectRepo } from './projectRepo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'project_repos.json');

export const NEW_PROJECT_MARKER = 'New';
export const DEFAULT_OWNER = 'sota1111';
export const DEFAULT_WORKSPACE_ROOT = '/workspaces';

/** プロジェクト名が「New」マーカーか（前後空白除去・大小無視）。 */
export function isNewProject(projectName: string | null | undefined): boolean {
  if (typeof projectName !== 'string') return false;
  return projectName.trim().toLowerCase() === NEW_PROJECT_MARKER.toLowerCase();
}

/** GitHub repo 名として安全な slug に変換する（小文字・英数・ハイフン）。 */
export function slugify(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface DeriveRepoNameOpts {
  title?: string | null;
  identifier?: string | null;
  body?: string | null;
}

/**
 * 新規 repo 名を決定する。
 * 「New」プロジェクト名は固定マーカーで一意名にならないため、issue 情報から導出する:
 *   1. 本文に `repo: <name>` 行があればそれ（人間が完全制御）
 *   2. なければタイトルの slug
 *   3. それも空なら `new-<識別子>`（例: new-sot-860）
 *   4. 最終フォールバック `new-repo`
 */
export function deriveNewRepoName(opts: DeriveRepoNameOpts): string {
  const { title, identifier, body } = opts;

  if (typeof body === 'string') {
    const m = body.match(/^\s*repo:\s*([A-Za-z0-9._-]+)\s*$/m);
    if (m) {
      const s = slugify(m[1]);
      if (s) return s;
    }
  }

  if (typeof title === 'string') {
    const s = slugify(title);
    if (s) return s;
  }

  const id = typeof identifier === 'string' ? slugify(identifier) : '';
  if (id) return `new-${id}`;

  return 'new-repo';
}

/**
 * config 配列に entry を upsert する（同一 project は置換、無ければ追加）。
 * 入力配列は変更せず、新しい配列を返す。
 */
export function upsertProjectRepoEntry(
  config: ProjectRepo[],
  entry: ProjectRepo
): ProjectRepo[] {
  const key = entry.project.trim().toLowerCase();
  const next = config.filter((e) => e.project.trim().toLowerCase() !== key);
  next.push(entry);
  return next;
}

/**
 * 自動導出した mapping を `config/project_repos.json` へ best-effort で永続化する（SOT-2128）。
 * すでに同名 project が存在する場合は何もしない（明示設定を上書きしない・冪等・書き込み最小化）。
 * 書き込んだら true、既存/失敗なら false。例外は投げない（呼び出し側は fail-open）。
 */
export function persistProjectRepoMapping(
  entry: ProjectRepo,
  configPath: string = DEFAULT_CONFIG_PATH
): boolean {
  const key = entry.project.trim().toLowerCase();
  if (!key) return false;
  try {
    let current: ProjectRepo[];
    try {
      current = loadProjectRepoConfig(configPath);
    } catch {
      current = [];
    }
    if (current.some((e) => e.project.trim().toLowerCase() === key)) return false;
    const next = upsertProjectRepoEntry(current, entry);
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

// 注入可能なコマンド実行インターフェース（テストでは gh/git を呼ばずモックする）。
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (cmd: string, args: string[], cwd?: string) => RunResult;

const defaultRunner: CommandRunner = (cmd, args, cwd) => {
  try {
    const stdout = childProcess.execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (err: any) {
    return {
      code: typeof err?.status === 'number' ? err.status : 1,
      stdout: err?.stdout?.toString?.() ?? '',
      stderr: err?.stderr?.toString?.() ?? (err?.message ?? ''),
    };
  }
};

export interface EnsureRepoOpts {
  repoName: string;
  owner?: string;
  workspaceRoot?: string;
  configPath?: string;
  run?: CommandRunner;
}

export interface NewRepoResult {
  repo: string; // owner/name
  localPath: string;
  created: boolean;
}

/**
 * 「New」プロジェクト用の repo を冪等に用意する。
 * - 既存 (`gh repo view`) なら作成スキップ。無ければ `gh repo create --public`。
 * - `<workspaceRoot>/<repoName>` に clone（無ければ）。空 repo には README で初回 push。
 * - `config/project_repos.json` に repo 名キーで追記/更新。
 * gh/git 失敗時は明確な Error を投げ、呼び出し側が fail-open できるようにする。
 */
export async function ensureRepoForNewProject(
  opts: EnsureRepoOpts
): Promise<NewRepoResult> {
  const owner = opts.owner ?? DEFAULT_OWNER;
  const workspaceRoot = opts.workspaceRoot ?? DEFAULT_WORKSPACE_ROOT;
  const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
  const run = opts.run ?? defaultRunner;
  const repoName = opts.repoName;
  const fullName = `${owner}/${repoName}`;
  const localPath = path.join(workspaceRoot, repoName);

  // 1. 既存判定（idempotent）
  const view = run('gh', ['repo', 'view', fullName, '--json', 'name']);
  const exists = view.code === 0;
  let created = false;

  // 2. 無ければ作成
  if (!exists) {
    const create = run('gh', [
      'repo',
      'create',
      fullName,
      '--public',
      '--description',
      'Created by ai-dev-control-plane for a Linear "New" project',
    ]);
    if (create.code !== 0) {
      throw new Error(`gh repo create ${fullName} failed: ${create.stderr || create.stdout}`);
    }
    created = true;
  }

  // 3. ローカル clone（無ければ）
  if (!fs.existsSync(localPath)) {
    const cloneUrl = `https://github.com/${fullName}.git`;
    const clone = run('git', ['clone', cloneUrl, localPath]);
    if (clone.code !== 0) {
      throw new Error(`git clone ${cloneUrl} failed: ${clone.stderr || clone.stdout}`);
    }
  }

  // 4. 空 repo には初回 commit/push（README が無ければ作成）
  const readmePath = path.join(localPath, 'README.md');
  if (fs.existsSync(localPath) && !fs.existsSync(readmePath)) {
    try {
      fs.writeFileSync(readmePath, `# ${repoName}\n`, 'utf8');
    } catch {
      /* localPath が無い等は下の git で検知させる */
    }
    run('git', ['add', 'README.md'], localPath);
    const commit = run('git', ['commit', '-m', 'chore: initialize repository'], localPath);
    // 空でなければ commit は失敗しうる（nothing to commit）。push は best-effort。
    if (commit.code === 0) {
      const push = run('git', ['push', 'origin', 'HEAD'], localPath);
      if (push.code !== 0) {
        throw new Error(`git push for ${fullName} failed: ${push.stderr || push.stdout}`);
      }
    }
  }

  // 5. config 追記（repo 名キーで upsert。「New」キーでは追記しない）
  let current: ProjectRepo[];
  try {
    current = loadProjectRepoConfig(configPath);
  } catch {
    current = [];
  }
  const entry: ProjectRepo = { project: repoName, repo: fullName, localPath };
  const next = upsertProjectRepoEntry(current, entry);
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');

  return { repo: fullName, localPath, created };
}
