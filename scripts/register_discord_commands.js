#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;

if (!DISCORD_BOT_TOKEN || !DISCORD_APPLICATION_ID) {
  console.error('ERROR: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set in .env');
  process.exit(1);
}

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
    name: 'cooldown',
    description: 'usage-limit cooldown中のIssueと再実行予定時刻を表示します',
  },
  {
    name: 'pause',
    description: '新規実行を一時停止します（実行中のプロセスは継続）',
  },
  {
    name: 'resume',
    description: '一時停止を解除して新規実行を再開します',
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
    name: 'ask',
    description: '自然言語でai-dev-control-planeに質問・指示を送ります（モーダルが開きます）',
  },
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`;
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
  console.log(`Successfully registered ${result.length} commands:`);
  for (const cmd of result) {
    console.log(`  /${cmd.name} (id: ${cmd.id})`);
  }
}

registerCommands().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
