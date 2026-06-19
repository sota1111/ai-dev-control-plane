#!/usr/bin/env tsx
// Linearプロジェクト名から開発対象レポジトリを解決する CLI。
//
// 使い方:
//   tsx src/project-repo-cli.ts "<projectName>" [--json]
//
// 成功: 解決した localPath を stdout に出力（--json で全フィールドを JSON 出力）、exit 0。
// 不明プロジェクト or 引数なし: stderr にメッセージ、exit 1。

import { resolveRepoForProject } from './lib/projectRepo.js';

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter((a) => !a.startsWith('--'));
  const projectName = positional[0];

  if (!projectName) {
    process.stderr.write('Usage: tsx src/project-repo-cli.ts "<projectName>" [--json]\n');
    return 1;
  }

  const resolved = resolveRepoForProject(projectName);
  if (!resolved) {
    process.stderr.write(`No repository mapping found for project: ${projectName}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(JSON.stringify(resolved) + '\n');
  } else {
    process.stdout.write(resolved.localPath + '\n');
  }
  return 0;
}

process.exit(main(process.argv));
