'use strict';

const path = require('path');
const fs = require('fs');
const runner = require('../runner');
const { handleStatus, handleQueue, handleCooldown } = require('./discordCommandHandlers');

export {};

const ISSUE_ID_PATTERN = /^SOT-\d+$/i;
const MAX_DISCORD_LENGTH = 1900;

function truncate(str: string, maxLen: number = MAX_DISCORD_LENGTH): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

async function handleStatusIntent(): Promise<string> {
  const result = await handleStatus();
  return result.content;
}

async function handleQueueIntent(): Promise<string> {
  const result = await handleQueue();
  return result.content;
}

async function handleCooldownIntent(): Promise<string> {
  const result = await handleCooldown();
  return result.content;
}

async function handleIssueStatusIntent(issueId: string): Promise<string> {
  try {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          state { name type }
          updatedAt
        }
      }
    `;
    const data = await runner.linearQuery(query, { id: issueId });
    if (!data || !data.issue) {
      return `❌ Issue **${issueId}** が見つかりませんでした。`;
    }
    const issue = data.issue;
    const updatedAt = new Date(issue.updatedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    return truncate([
      `## ${issue.identifier}: ${issue.title}`,
      `**Status**: ${issue.state.name} (${issue.state.type})`,
      `**最終更新**: ${updatedAt}`,
    ].join('\n'));
  } catch (err: any) {
    runner.log('DISCORD', `handleIssueStatusIntent error: ${err.message}`);
    if (err.message && err.message.includes('LINEAR_API_KEY')) {
      return '❌ Linear API キーが設定されていません。';
    }
    return `❌ Linear APIエラー: ${err.message}`;
  }
}

async function handleLogSummaryIntent(issueId: string): Promise<string> {
  try {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      return `❌ Issue IDは SOT-xxx 形式で指定してください。`;
    }

    const logsDir = runner.LOG_DIR;
    const issueIdLower = issueId.toLowerCase();

    // Find log files related to this issue
    let logFiles: string[] = [];
    if (fs.existsSync(logsDir)) {
      const allFiles = fs.readdirSync(logsDir);
      logFiles = allFiles
        .filter((f: string) => f.toLowerCase().includes(issueIdLower) && (f.endsWith('.log') || f.endsWith('.txt') || f.endsWith('.md')))
        .sort()
        .reverse()
        .slice(0, 3);
    }

    if (logFiles.length === 0) {
      return `ℹ **${issueId}** のログファイルが見つかりませんでした。\nログディレクトリ: \`${logsDir}\``;
    }

    const summaries: string[] = [];
    for (const file of logFiles) {
      const filePath = path.join(logsDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter((l: string) => l.trim());
        // Get last 20 lines
        const lastLines = lines.slice(-20).join('\n');
        summaries.push(`**${file}**:\n\`\`\`\n${lastLines.slice(0, 500)}\n\`\`\``);
      } catch {
        summaries.push(`**${file}**: 読み取りエラー`);
      }
    }

    return truncate(`## ${issueId} 最新ログ\n\n` + summaries.join('\n\n'));
  } catch (err: any) {
    runner.log('DISCORD', `handleLogSummaryIntent error: ${err.message}`);
    return `❌ エラーが発生しました: ${err.message}`;
  }
}

async function handleCommentPostIntent(issueId: string, commentText: string): Promise<string> {
  // This is a read-only suggestion — actual posting requires explicit /reply command
  return truncate([
    `📝 **${issueId}** へのコメント投稿候補:`,
    `> "${commentText}"`,
    '',
    'コメントを投稿するには `/reply` コマンドを使用してください:',
    `\`/reply issue:${issueId} body:<コメント本文>\``,
  ].join('\n'));
}

async function handleRetrySuggestIntent(issueId: string): Promise<string> {
  try {
    const queued = runner.isQueued(issueId);
    if (queued) {
      return `ℹ **${issueId}** はすでに実行キューに存在します。`;
    }
    return truncate([
      `🔄 **${issueId}** を再実行キューへ投入しますか？`,
      '',
      '実行するには `/retry` コマンドを使用してください:',
      `\`/retry issue:${issueId}\``,
    ].join('\n'));
  } catch (err: any) {
    runner.log('DISCORD', `handleRetrySuggestIntent error: ${err.message}`);
    return `❌ エラーが発生しました: ${err.message}`;
  }
}

function handleDangerousIntent(): string {
  return '🚫 **この操作は拒否されました。**\n秘密情報の表示、任意コマンドの実行、ファイル削除などの危険操作は許可されていません。';
}

function handleUnknownIntent(originalText: string): string {
  return truncate([
    '❓ **入力内容を理解できませんでした。**',
    '',
    '以下のような質問・指示を入力してください:',
    '• 今どのタスクを実行中？',
    '• キューに残っているタスクはある？',
    '• usage-limit はいつ復帰？',
    '• SOT-xxx は何で止まっている？',
    '• SOT-xxx の最新ログを要約して',
    '• SOT-xxx に返信して',
    '• SOT-xxx を再実行候補に入れて',
    '',
    `（入力: "${originalText.slice(0, 100)}${originalText.length > 100 ? '...' : ''}"）`,
  ].join('\n'));
}

module.exports = {
  handleStatusIntent,
  handleQueueIntent,
  handleCooldownIntent,
  handleIssueStatusIntent,
  handleLogSummaryIntent,
  handleCommentPostIntent,
  handleRetrySuggestIntent,
  handleDangerousIntent,
  handleUnknownIntent,
};
