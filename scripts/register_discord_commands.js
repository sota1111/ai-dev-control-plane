#!/usr/bin/env node
// ESM: package.json has "type": "module", and src/config/secrets.js is ESM,
// so this script must use import (not require).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getRequiredSecret, initSecrets } from '../src/config/secrets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const commands = [
  {
    name: 'status',
    description: '現在の実行中Issue、ロック状態、キュー数、usage-limit cooldownを表示します',
  },
  {
    name: 'queue',
    description: '実行キュー (runner.queue.json) の内容を表示します',
  },
  {
    name: 'pastqueue',
    description: '直近10件の過去キュー（処理済みIssue）を /queue と同じ形式で表示します',
  },
  {
    name: 'reorder',
    description: 'Todo+In Progressの全Issueを取得し、実行キューを優先度順に再構築します',
  },
  {
    name: 'cooldown',
    description: 'usage-limit cooldown中のIssueと再実行予定時刻を表示します',
  },
  {
    name: 'pause',
    description: '新規実行を一時停止します（実行中のプロセスは継続）',
  },
  {
    name: 'resume',
    description: '一時停止の解除、または中断されたセッションを再開します',
    options: [
      {
        name: 'pause',
        description: '一時停止を解除します（従来の /resume）',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'issue',
        description: '指定 Issue を usage-limit 後の再開モードで再実行します',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'id',
            description: 'Linear Issue ID (例: SOT-123)',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'session',
        description: 'tmux pane の Claude Code セッションに continue を送信します',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'pane',
            description: 'tmux pane ID (例: %1)',
            type: 3, // STRING
            required: true,
          },
          {
            name: 'issue',
            description: 'Linear Issue ID (例: SOT-123)',
            type: 3, // STRING
            required: false,
          },
        ],
      },
    ],
  },
  {
    name: 'reply',
    description: '指定Linear IssueへDiscordからコメントを投稿します',
    options: [
      {
        name: 'issue',
        description: 'Linear Issue ID (例: SOT-123)',
        type: 3, // STRING
        required: true,
      },
      {
        name: 'body',
        description: '投稿するコメント本文（最大1000文字）',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'retry',
    description: '指定Linear Issueを再実行キューへ投入します',
    options: [
      {
        name: 'issue',
        description: 'Linear Issue ID (例: SOT-123)',
        type: 3, // STRING
        required: true,
      },
    ],
  },
  {
    name: 'recover',
    description: '停止した自動実行を強制復帰します（cooldown解除/pause解除/inflight回収/再スキャン/ドレイン）',
    options: [
      {
        name: 'force',
        description: 'runner.lockを強制解放しinflight/current-issueも強制クリア（生存だが固まったロック向け）',
        type: 5, // BOOLEAN
        required: false,
      },
    ],
  },
  {
    name: 'ask',
    description: '自然言語でai-dev-control-planeに質問・指示を送ります（モーダルが開きます）',
  },
];

async function registerCommands() {
  await initSecrets(['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID']);
  let DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID;
  try {
    DISCORD_BOT_TOKEN = getRequiredSecret('DISCORD_BOT_TOKEN');
    DISCORD_APPLICATION_ID = getRequiredSecret('DISCORD_APPLICATION_ID');
  } catch {
    console.error('ERROR: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set in .env');
    process.exit(1);
  }

  // DISCORD_GUILD_ID が設定されていれば guild スコープで登録する（即時反映）。
  // 未設定ならグローバル登録（全サーバーで使えるが反映に最大1時間かかる）。
  const guildId = (process.env.DISCORD_GUILD_ID || '').trim();
  const url = guildId
    ? `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;
  const scope = guildId ? `guild ${guildId} (即時反映)` : 'global (反映に最大1時間)';
  console.log(`Registering ${commands.length} commands to ${scope}...`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`ERROR: Failed to register commands: ${response.status} ${text}`);
    process.exit(1);
  }

  const result = await response.json();
  console.log(`Successfully registered ${result.length} commands (${scope}):`);
  for (const cmd of result) {
    console.log(`  /${cmd.name} (id: ${cmd.id})`);
  }
}

registerCommands().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
