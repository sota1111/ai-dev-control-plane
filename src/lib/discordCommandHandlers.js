'use strict';

const runner = require('../runner');
const { isPaused, setPaused, clearPause, getPauseInfo } = require('./discordPauseState');

const ISSUE_ID_PATTERN = /^SOT-\d+$/i;
const MAX_BODY_LENGTH = 1000;
const MAX_DISCORD_LENGTH = 1900; // safe margin under Discord's 2000 char limit

function truncate(str, maxLen = MAX_DISCORD_LENGTH) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function validateIssueId(issueId) {
  if (!issueId || !ISSUE_ID_PATTERN.test(issueId.trim())) {
    return { valid: false, error: `Issue IDは SOT-xxx 形式で指定してください（例: SOT-123）。` };
  }
  return { valid: true, id: issueId.trim().toUpperCase() };
}

async function handleStatus() {
  try {
    const locked = runner.isLocked();
    const queue = runner.loadQueue();
    const cooldown = runner.getUsageLimitCooldownUntil();
    const paused = isPaused();
    const pauseInfo = paused ? getPauseInfo() : null;

    let lockInfo = '🔓 ロックなし（アイドル状態）';
    if (locked) {
      lockInfo = '🔒 実行中（runner.lock 取得済み）';
    }

    let cooldownInfo = 'なし';
    if (cooldown) {
      const retryAt = new Date(cooldown.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const issueRef = cooldown.issueIdentifier || cooldown.issueId || '不明';
      cooldownInfo = `⏳ ${issueRef} — 復帰予定: ${retryAt}`;
    }

    let pauseStatus = paused
      ? `⏸ 一時停止中（${pauseInfo && pauseInfo.pausedAt ? new Date(pauseInfo.pausedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '不明'}）`
      : '▶ 実行可能';

    const content = [
      '## 実行状態',
      `**ロック**: ${lockInfo}`,
      `**キュー**: ${queue.length} 件`,
      `**Cooldown**: ${cooldownInfo}`,
      `**Pause状態**: ${pauseStatus}`,
    ].join('\n');

    return { content: truncate(content) };
  } catch (err) {
    runner.log('DISCORD', `handleStatus error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleQueue() {
  try {
    const queue = runner.loadQueue();
    if (queue.length === 0) {
      return { content: '## 実行キュー\nキューは空です。' };
    }
    const lines = queue.map((item, i) => {
      const at = item.enqueuedAt ? new Date(item.enqueuedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
      return `${i + 1}. **${item.issueId}** — ${item.trigger || 'unknown'} (${at})`;
    });
    const content = `## 実行キュー (${queue.length}件)\n` + lines.join('\n');
    return { content: truncate(content) };
  } catch (err) {
    runner.log('DISCORD', `handleQueue error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleCooldown() {
  try {
    const cooldown = runner.getUsageLimitCooldownUntil();
    if (!cooldown) {
      return { content: '## Usage-Limit Cooldown\ncooldown中のIssueはありません。' };
    }
    const retryAt = new Date(cooldown.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const issueRef = cooldown.issueIdentifier || cooldown.issueId || '不明';
    const content = [
      '## Usage-Limit Cooldown',
      `**Issue**: ${issueRef}`,
      `**復帰予定時刻**: ${retryAt}`,
    ].join('\n');
    return { content };
  } catch (err) {
    runner.log('DISCORD', `handleCooldown error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handlePause() {
  try {
    if (isPaused()) {
      return { content: '⏸ すでに一時停止中です。再開するには `/resume` を使用してください。' };
    }
    setPaused('Discord /pause command');
    runner.log('DISCORD', 'Runner paused via Discord /pause command');
    return { content: '⏸ **新規実行を一時停止しました。**\n実行中のプロセスは継続します。再開するには `/resume` を使用してください。' };
  } catch (err) {
    runner.log('DISCORD', `handlePause error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleResume() {
  try {
    const wasCleared = clearPause();
    if (!wasCleared) {
      return { content: '▶ 一時停止状態ではありません。' };
    }
    runner.log('DISCORD', 'Runner resumed via Discord /resume command');
    return { content: '▶ **一時停止を解除しました。**\n新規実行が再開されます。' };
  } catch (err) {
    runner.log('DISCORD', `handleResume error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleReply(interaction) {
  try {
    const options = (interaction.data && interaction.data.options) || [];
    const issueOpt = options.find(o => o.name === 'issue');
    const bodyOpt = options.find(o => o.name === 'body');

    const issueIdRaw = issueOpt && issueOpt.value;
    const body = bodyOpt && bodyOpt.value;

    const validation = validateIssueId(issueIdRaw);
    if (!validation.valid) {
      return { content: `❌ ${validation.error}` };
    }
    const issueId = validation.id;

    if (!body || body.trim().length === 0) {
      return { content: '❌ コメント本文が空です。' };
    }
    if (body.length > MAX_BODY_LENGTH) {
      return { content: `❌ コメント本文が長すぎます（最大${MAX_BODY_LENGTH}文字、現在${body.length}文字）。` };
    }

    const mutation = `
      mutation CreateComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id }
        }
      }
    `;

    const result = await runner.linearQuery(mutation, { issueId, body: body.trim() });
    if (result && result.commentCreate && result.commentCreate.success) {
      runner.log('DISCORD', `Reply posted to ${issueId} via Discord`);
      return { content: `✅ **${issueId}** にコメントを投稿しました。` };
    } else {
      return { content: `❌ コメントの投稿に失敗しました。` };
    }
  } catch (err) {
    runner.log('DISCORD', `handleReply error: ${err.message}`);
    if (err.message && err.message.includes('LINEAR_API_KEY')) {
      return { content: '❌ Linear API キーが設定されていません。' };
    }
    return { content: `❌ エラーが発生しました: ${err.message}` };
  }
}

async function handleRetry(interaction) {
  try {
    const options = (interaction.data && interaction.data.options) || [];
    const issueOpt = options.find(o => o.name === 'issue');
    const issueIdRaw = issueOpt && issueOpt.value;

    const validation = validateIssueId(issueIdRaw);
    if (!validation.valid) {
      return { content: `❌ ${validation.error}` };
    }
    const issueId = validation.id;

    const wasQueued = runner.isQueued(issueId);
    runner.enqueue(issueId, 'discord-retry');
    runner.log('DISCORD', `${issueId} enqueued via Discord /retry (wasQueued=${wasQueued})`);

    // Trigger drain asynchronously — do not block the Discord response
    setImmediate(() => {
      runner.drainQueue().catch(err => {
        runner.log('DISCORD', `drainQueue error after /retry: ${err.message}`);
      });
    });

    if (wasQueued) {
      return { content: `ℹ **${issueId}** はすでにキューに存在します。ドレインを開始します。` };
    }
    return { content: `✅ **${issueId}** を実行キューへ投入しました。ドレインを開始します。` };
  } catch (err) {
    runner.log('DISCORD', `handleRetry error: ${err.message}`);
    return { content: `❌ エラーが発生しました: ${err.message}` };
  }
}

module.exports = {
  handleStatus,
  handleQueue,
  handleCooldown,
  handlePause,
  handleResume,
  handleReply,
  handleRetry,
};
