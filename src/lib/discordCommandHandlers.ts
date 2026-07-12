'use strict';

import * as runner from '../runner.js';
import * as queueOrdering from './queueOrdering.js';
import { isPaused, setPaused, clearPause, getPauseInfo } from './discordPauseState.js';
import * as sessionContinue from './sessionContinue.js';
import { isHoldState } from './issueState.js';
import { formatOutcomeSummary } from './outcomeStats.js';

const ISSUE_ID_PATTERN = /^SOT-\d+$/i;
const MAX_BODY_LENGTH = 1000;
const MAX_DISCORD_LENGTH = 1900; // safe margin under Discord's 2000 char limit

interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: any;
  options?: DiscordInteractionOption[];
}

interface DiscordInteraction {
  data?: {
    options?: DiscordInteractionOption[];
  };
}

interface CommandResult {
  content: string;
}

function truncate(str: string, maxLen: number = MAX_DISCORD_LENGTH): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

function validateIssueId(issueId: string | null | undefined): { valid: boolean; error?: string; id?: string } {
  if (!issueId || !ISSUE_ID_PATTERN.test(issueId.trim())) {
    return { valid: false, error: `Issue IDは SOT-xxx 形式で指定してください（例: SOT-123）。` };
  }
  return { valid: true, id: issueId.trim().toUpperCase() };
}

// Shared row formatter for the active queue (/queue) and the past queue (/pastqueue),
// so both commands render identical content.
function formatQueueItem(
  item: any,
  index: number,
  activeMap: Map<string, { title: string; url: string }>,
  indent = '',
): string {
  const at = item.enqueuedAt ? new Date(item.enqueuedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
  const priorityStr = item.priorityLabel ? `[${item.priorityLabel}]` : '[No priority]';
  const rank = queueOrdering.effectiveRank(item);
  const groupStr = item.queueGroup
    ? `  ↳ 親: ${item.parentIssueIdentifier || item.parentIssueId || item.queueGroup}`
    : '';
  const retryStr = item.retryAt ? ` ⏳ ${new Date(item.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}` : '';

  const identifier = item.issueIdentifier || item.issueId;
  const meta = activeMap.get(identifier);
  const titleUrl = meta ? ` — ${meta.title} ${meta.url}` : '';

  return `${indent}${index}. **${identifier}** ${priorityStr} (rank ${rank}) — ${item.trigger || 'unknown'} (${at})${retryStr}${groupStr}${titleUrl}`;
}

// Build the {title,url} lookup map from Linear active issues. Tolerates failure.
// Keyed by BOTH the human identifier (e.g. SOT-123, used by queue items) and the internal issue id
// (UUID, used by running/inflight entries — see runner.getRunningIssues), so both /queue rows and the
// "現在実行中" lines can resolve a title/url regardless of which key the caller holds.
async function buildActiveMap(): Promise<Map<string, { title: string; url: string }>> {
  const activeMap = new Map<string, { title: string; url: string }>();
  try {
    const actives = await runner.fetchActiveIssues();
    for (const issue of (actives || [])) {
      if (issue.title && issue.url) {
        const meta = { title: issue.title, url: issue.url };
        if (issue.identifier) activeMap.set(issue.identifier, meta);
        if (issue.id) activeMap.set(issue.id, meta);
      }
    }
  } catch (err: any) {
    runner.log('DISCORD', `fetchActiveIssues failed: ${err.message}`);
  }
  return activeMap;
}

async function handleStatus(): Promise<CommandResult> {
  try {
    const locked = runner.isLocked();
    const currentIssue = runner.getCurrentIssue();
    const queue = runner.loadQueue();
    const cooldown = runner.getUsageLimitCooldownUntil();
    const paused = isPaused();
    const pauseInfo = paused ? getPauseInfo() : null;
    const sessionState = sessionContinue.readSessionContinueState();

    let lockInfo = '🔓 ロックなし（アイドル状態）';
    if (locked) {
      lockInfo = '🔒 実行中（runner.lock 取得済み）';
    }

    let runningInfo = '**実行中**: なし';
    if (currentIssue) {
      const now = Date.now();
      const startedAt = new Date(currentIssue.startedAt).getTime();
      const diffMs = Math.max(0, now - startedAt);
      const diffMin = Math.floor(diffMs / 60000);
      const diffSec = Math.floor((diffMs % 60000) / 1000);
      const elapsed = diffMin > 0 ? `${diffMin}m ${diffSec}s` : `${diffSec}s`;
      runningInfo = `**実行中**: ▶ ${currentIssue.issueIdentifier || currentIssue.issueId} (経過 ${elapsed})`;
    }

    let cooldownInfo = 'なし';
    if (cooldown) {
      const retryAt = new Date(cooldown.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
      const issueRef = cooldown.issueIdentifier || cooldown.issueId || '不明';
      cooldownInfo = `⏳ ${issueRef} — 復帰予定: ${retryAt}`;
    }

    let sessionInfo = 'なし';
    if (sessionState && (sessionState.status === 'waiting' || sessionState.status === 'foreground_mismatch')) {
      const resetAtJST = sessionState.resetAt ? new Date(sessionState.resetAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '不明';
      const retryAtJST = sessionState.retryAt ? new Date(sessionState.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '不明';
      sessionInfo = `pane ${sessionState.paneId} — ${sessionState.status} (reset ${resetAtJST}, retry ${retryAtJST})`;
    }

    let pauseStatus = paused
      ? `⏸ 一時停止中（${pauseInfo && pauseInfo.pausedAt ? new Date(pauseInfo.pausedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '不明'}）`
      : '▶ 実行可能';

    // SOT-1439 / P5: surface the last 24h of structured run outcomes (success / usage-limit / failure).
    // Defensive: only if the runner exposes the helper (older mocks may not) and never let it break /status.
    let outcomeInfo = 'なし';
    try {
      if (typeof (runner as any).getRecentOutcomeSummary === 'function') {
        const summary = (runner as any).getRecentOutcomeSummary(24 * 60 * 60 * 1000);
        outcomeInfo = formatOutcomeSummary(summary);
      }
    } catch (e: any) {
      runner.log('DISCORD', `handleStatus outcome summary error (non-fatal): ${e.message}`);
    }

    const content = [
      '## 実行状態',
      `**ロック**: ${lockInfo}`,
      runningInfo,
      `**キュー**: ${queue.length} 件`,
      `**Cooldown**: ${cooldownInfo}`,
      `**Session-Continue**: ${sessionInfo}`,
      `**Pause状態**: ${pauseStatus}`,
      `**直近24hのoutcome**: ${outcomeInfo}`,
    ].join('\n');

    return { content: truncate(content) };
  } catch (err: any) {
    runner.log('DISCORD', `handleStatus error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleQueue(): Promise<CommandResult> {
  try {
    const rawQueue = runner.loadQueue();
    // Running set comes from inflight state, not just the single current-issue marker: a detached
    // long-run keeps running (inflight) after the marker is cleared, so relying on the marker alone
    // made /queue report "キューは空です" while a task was still executing (SOT-1532).
    const running = runner.getRunningIssues();

    // A1: Fetch active issues for titles/urls
    const activeMap = await buildActiveMap();

    if (rawQueue.length === 0 && running.length === 0) {
      return { content: '## 実行キュー\nキューは空です。' };
    }

    // Use shared logic to determine real execution order
    const { ready, waiting } = queueOrdering.previewQueueOrder(rawQueue);

    const lines: string[] = [];
    for (const run of running) {
      const runId = run.issueIdentifier || run.issueId;
      const runMeta = activeMap.get(runId) || activeMap.get(run.issueId);
      const runTitleUrl = runMeta ? ` — ${runMeta.title} ${runMeta.url}` : '';
      lines.push(`0. ▶ 現在実行中: **${runId}**${runTitleUrl}`);
    }

    if (ready.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('### 実行待ち (Ready)');
      ready.forEach((item: any, index: number) => {
        lines.push(formatQueueItem(item, index + 1, activeMap));
      });
    }

    if (waiting.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('### 待機中 (Waiting)');
      waiting.forEach((item: any, index: number) => {
        // For waiting items, we list them in order of retryAt
        lines.push(formatQueueItem(item, index + 1, activeMap));
      });
    }

    const content = `## 実行キュー (${rawQueue.length}件)\n` + lines.join('\n');
    return { content: truncate(content) };
  } catch (err: any) {
    runner.log('DISCORD', `handleQueue error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

// /pastqueue: show the most recent 10 dequeued (processed) issues using the same
// row format as /queue.
async function handlePastQueue(): Promise<CommandResult> {
  try {
    const history = runner.loadQueueHistory();
    const items = history.slice(0, 10); // history is newest-first

    if (items.length === 0) {
      return { content: '## 過去キュー\n履歴がありません。' };
    }

    const activeMap = await buildActiveMap();

    const lines = items.map((item: any, index: number) => formatQueueItem(item, index + 1, activeMap));

    const content = `## 過去キュー (直近${items.length}件)\n` + lines.join('\n');
    return { content: truncate(content) };
  } catch (err: any) {
    runner.log('DISCORD', `handlePastQueue error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleReorder(): Promise<CommandResult> {
  try {
    const existing = runner.loadQueue();
    let actives: runner.IssueQueueMetadata[];
    try {
      actives = await runner.fetchActiveIssues();
    } catch (err: any) {
      runner.log('DISCORD', `fetchActiveIssues failed in /reorder: ${err.message}`);
      return { content: `Linear Issueの取得に失敗しました: ${err.message}` };
    }

    const now = new Date().toISOString();
    const rebuilt: runner.QueueItem[] = [];
    const processedActiveIds = new Set<string>();

    // Build lookup for existing items
    const existingMap = new Map<string, runner.QueueItem>();
    for (const item of existing) {
      if (item.issueId) existingMap.set(item.issueId, item);
      if (item.issueIdentifier) existingMap.set(item.issueIdentifier, item);
    }

    for (const active of actives) {
      const match = existingMap.get(active.id) || (active.identifier ? existingMap.get(active.identifier) : undefined);
      
      if (match) {
        rebuilt.push({
          ...match,
          priority: active.priority ?? null,
          priorityLabel: active.priorityLabel ?? null,
          priorityRank: runner.getPriorityRank(active.priority),
          linearFetchedAt: now,
          // Backfill Linear creation time for creation-order sorting (SOT-1637)
          createdAt: match.createdAt ?? active.createdAt ?? null,
          parentIssueId: active.parentIssueId ?? match.parentIssueId,
          parentIssueIdentifier: active.parentIssueIdentifier ?? match.parentIssueIdentifier,
        });
      } else {
        rebuilt.push({
          issueId: active.id,
          issueIdentifier: active.identifier,
          trigger: 'discord-reorder',
          retryAt: null,
          enqueuedAt: now,
          createdAt: active.createdAt ?? null,
          lastAttemptAt: null,
          attemptCount: 0,
          reason: null,
          priority: active.priority ?? null,
          priorityLabel: active.priorityLabel ?? null,
          priorityRank: runner.getPriorityRank(active.priority),
          linearFetchedAt: now,
          parentIssueId: active.parentIssueId ?? null,
          parentIssueIdentifier: active.parentIssueIdentifier ?? null,
          queueGroup: active.parentIssueId ?? null,
          queueGroupOrder: null
        });
      }
      processedActiveIds.add(active.id);
      if (active.identifier) processedActiveIds.add(active.identifier);
    }

    // Sort active items: priority ascending, then Linear creation order (SOT-1637;
    // createdAt falls back to enqueuedAt when unknown)
    rebuilt.sort((a, b) => {
      const rankA = queueOrdering.effectiveRank(a);
      const rankB = queueOrdering.effectiveRank(b);
      if (rankA !== rankB) return rankA - rankB;

      const timeA = queueOrdering.creationOrderTime(a);
      const timeB = queueOrdering.creationOrderTime(b);
      return timeA - timeB;
    });

    // Append non-active existing items (e.g. archived but still in queue, or terminal state but not sync'd)
    const nonActives = existing.filter(item => !processedActiveIds.has(item.issueId) && (!item.issueIdentifier || !processedActiveIds.has(item.issueIdentifier)));
    rebuilt.push(...nonActives);

    runner.saveQueue(rebuilt);

    const activeCount = actives.length;
    const preservedCount = nonActives.length;
    const lines = [
      '## キュー再構築完了',
      `Todo+In ProgressのIssueに基づき、キューを優先度順に再構築しました。`,
      `**総件数**: ${rebuilt.length} 件 (アクティブ: ${activeCount}, 非アクティブ保持: ${preservedCount})`,
      '',
      '### 上位実行予定:',
    ];

    rebuilt.slice(0, 5).forEach((item, i) => {
      const rank = queueOrdering.effectiveRank(item);
      const priority = item.priorityLabel ? `[${item.priorityLabel}]` : '[No priority]';
      lines.push(`${i + 1}. **${item.issueIdentifier || item.issueId}** ${priority} (rank ${rank})`);
    });

    return { content: truncate(lines.join('\n')) };
  } catch (err: any) {
    runner.log('DISCORD', `handleReorder error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleCooldown(): Promise<CommandResult> {
  try {
    const cooldown = runner.getUsageLimitCooldownUntil();
    if (!cooldown) {
      return { content: '## Usage-Limit Cooldown\ncooldown中のIssueはありません。' };
    }
    const retryAt = new Date(cooldown.retryAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const issueRef = cooldown.issueIdentifier || cooldown.issueId || '不明';
    const lines = [
      '## Usage-Limit Cooldown',
      `**Issue**: ${issueRef}`,
      `**復帰予定時刻**: ${retryAt}`,
    ];
    if (cooldown.limitType) {
      lines.push(`**種別**: ${cooldown.limitType}`);
    }
    return { content: lines.join('\n') };
  } catch (err: any) {
    runner.log('DISCORD', `handleCooldown error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handlePause(): Promise<CommandResult> {
  try {
    if (isPaused()) {
      return { content: '⏸ すでに一時停止中です。再開するには `/resume` を使用してください。' };
    }
    setPaused('Discord /pause command');
    runner.log('DISCORD', 'Runner paused via Discord /pause command');
    return { content: '⏸ **新規実行を一時停止しました。**\n実行中のプロセスは継続します。再開するには `/resume` を使用してください。' };
  } catch (err: any) {
    runner.log('DISCORD', `handlePause error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleResume(interaction?: DiscordInteraction): Promise<CommandResult | undefined> {
  try {
    const opts = (interaction && interaction.data && interaction.data.options) || [];
    const sub = opts.find(o => o.type === 1); // SUB_COMMAND

    if (!sub || sub.name === 'pause') {
      const wasCleared = clearPause();
      if (!wasCleared) {
        return { content: '▶ 一時停止状態ではありません。' };
      }
      runner.log('DISCORD', 'Runner resumed via Discord /resume command');
      return { content: '▶ **一時停止を解除しました。**\n新規実行が再開されます。' };
    } else if (sub.name === 'issue') {
      return await handleResumeIssue(sub.options || []);
    } else if (sub.name === 'session') {
      return await handleResumeSession(sub.options || []);
    }
  } catch (err: any) {
    runner.log('DISCORD', `handleResume error: ${err.message}`);
    return { content: `エラーが発生しました: ${err.message}` };
  }
}

async function handleResumeIssue(subOptions: DiscordInteractionOption[]): Promise<CommandResult> {
  const idOpt = subOptions.find(o => o.name === 'id');
  const issueIdRaw = idOpt && idOpt.value;

  const validation = validateIssueId(issueIdRaw);
  if (!validation.valid) {
    return { content: `❌ ${validation.error}` };
  }
  const issueId = validation.id!;

  runner.enqueue(issueId, 'discord-resume', null, { reason: 'usage_limit' });
  runner.log('DISCORD', `${issueId} enqueued via Discord /resume issue`);

  setImmediate(() => {
    runner.drainQueue().catch((err: any) => {
      runner.log('DISCORD', `drainQueue error after /resume issue: ${err.message}`);
    });
  });

  return { content: `✅ **${issueId}** を usage-limit 後の再開モードで実行キューへ投入しました。` };
}

async function handleResumeSession(subOptions: DiscordInteractionOption[]): Promise<CommandResult> {
  const paneOpt = subOptions.find(o => o.name === 'pane');
  const issueOpt = subOptions.find(o => o.name === 'issue');

  const paneId = paneOpt && paneOpt.value;
  const issueId = issueOpt && issueOpt.value;

  if (!paneId) {
    return { content: '❌ pane ID を指定してください。' };
  }

  const result = await sessionContinue.attemptSessionContinue({
    paneId,
    issueId: issueId || null,
    notify: () => { },
    logger: (m: string) => runner.log('DISCORD', m)
  });

  let message = '';
  switch (result.status) {
    case 'sent':
      message = `▶ **${paneId}** に continue を送信しました。`;
      break;
    case 'waiting':
      message = `⏳ **${paneId}** で usage-limit を検知。retryAt まで待機します。`;
      break;
    case 'foreground_mismatch':
      message = `⚠ **${paneId}** の foreground が Claude Code ではありません。送信しません（人手対応）。`;
      break;
    case 'pane_missing':
      message = `❌ pane **${paneId}** が見つかりません。`;
      break;
    case 'no_limit':
      message = `ℹ **${paneId}** に usage-limit は検知されませんでした。`;
      break;
    default:
      message = `ステータス: ${result.status}`;
  }

  return { content: message };
}

async function handleReply(interaction: DiscordInteraction): Promise<CommandResult> {
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
    const issueId = validation.id!;

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
  } catch (err: any) {
    runner.log('DISCORD', `handleReply error: ${err.message}`);
    if (err.message && err.message.includes('LINEAR_API_KEY')) {
      return { content: '❌ Linear API キーが設定されていません。' };
    }
    return { content: `❌ エラーが発生しました: ${err.message}` };
  }
}

async function handleRetry(interaction: DiscordInteraction): Promise<CommandResult> {
  try {
    const options = (interaction.data && interaction.data.options) || [];
    const issueOpt = options.find(o => o.name === 'issue');
    const issueIdRaw = issueOpt && issueOpt.value;

    const validation = validateIssueId(issueIdRaw);
    if (!validation.valid) {
      return { content: `❌ ${validation.error}` };
    }
    const issueId = validation.id!;

    const wasQueued = runner.isQueued(issueId);
    runner.enqueue(issueId, 'discord-retry');
    runner.log('DISCORD', `${issueId} enqueued via Discord /retry (wasQueued=${wasQueued})`);

    // Trigger drain asynchronously — do not block the Discord response
    setImmediate(() => {
      runner.drainQueue().catch((err: any) => {
        runner.log('DISCORD', `drainQueue error after /retry: ${err.message}`);
      });
    });

    if (wasQueued) {
      return { content: `ℹ **${issueId}** はすでにキューに存在します。ドレインを開始します。` };
    }
    return { content: `✅ **${issueId}** を実行キューへ投入しました。ドレインを開始します。` };
  } catch (err: any) {
    runner.log('DISCORD', `handleRetry error: ${err.message}`);
    return { content: `❌ エラーが発生しました: ${err.message}` };
  }
}

// /recover: 何らかの要因で自動実行が止まったときの強制復帰コマンド。
// 「止まる」主因（cooldown居残り・一時停止のかけっぱなし・leaked inflight・webhook取りこぼし・
// 終端Issueの居残り）をまとめて解消し、Linearの actionable Issue を再投入してドレインを起動する。
//
// soft（既定）: 副作用が安全な操作のみ。
//   - usage-limit cooldown をクリア
//   - pause を解除
//   - stale inflight を回収（実行中ロック時は触らない）
//   - Linear の Todo/In Progress を再スキャンして未投入分を enqueue（In Review は除外）
//   - 終端/archived をキューから除去（syncQueueWithLinear）
//   - drainQueue を起動
// force: 上記に加えて runner.lock を無条件解放し inflight / current-issue を強制クリアする。
//   ロック保持者が「生存しているが固まっている」ケース向け（dead/stale は acquireLock が自動回収する）。
//   run_auto.sh の OS flock が実際の二重起動を防ぐため、JSロックの強制解放は比較的安全。
/**
 * SOT-1560 — recover ONE circuit-breaker-halted issue from Discord. The breaker parks a runaway issue
 * in On Hold; recovering it means a human deliberately un-parks it: move it back to In Progress (so the
 * reaper/queue treats it as actionable again) and enqueue just that issue, then drain. Never throws.
 */
async function handleRecoverIssue(issueIdRaw: string): Promise<CommandResult> {
  const validation = validateIssueId(issueIdRaw);
  if (!validation.valid) {
    return { content: `❌ ${validation.error}` };
  }
  const issueId = validation.id!;

  try {
    // Move it off On Hold back into the active flow. Fail-open: enqueue regardless so a Linear hiccup
    // does not block manual recovery.
    let moved = false;
    try {
      await runner.setIssueInProgress(issueId);
      moved = true;
    } catch (err: any) {
      runner.log('DISCORD', `handleRecoverIssue setIssueInProgress failed for ${issueId}: ${err.message}`);
    }

    runner.enqueue(issueId, 'discord-recover-issue', null, { reason: 'circuit_breaker' });
    runner.log('DISCORD', `${issueId} recovered from circuit-breaker halt via Discord /recover issue (moved=${moved})`);

    setImmediate(() => {
      runner.drainQueue().catch((err: any) => {
        runner.log('DISCORD', `drainQueue error after /recover issue: ${err.message}`);
      });
    });

    const stateLine = moved
      ? '- 🔓 On Hold → In Progress に戻しました'
      : '- ⚠ Linear 状態の更新に失敗（キュー投入は継続）';
    return {
      content: [
        `## 🚑 ブレーカー復旧: ${issueId}`,
        stateLine,
        `- 📥 実行キューへ再投入しました — ドレインを開始しました。`,
      ].join('\n'),
    };
  } catch (err: any) {
    runner.log('DISCORD', `handleRecoverIssue error: ${err.message}`);
    return { content: `❌ ${issueId} の復旧中にエラーが発生しました: ${err.message}` };
  }
}

async function handleRecover(interaction?: DiscordInteraction): Promise<CommandResult> {
  const actions: string[] = [];
  try {
    const opts = (interaction && interaction.data && interaction.data.options) || [];
    const forceOpt = opts.find(o => o.name === 'force');
    const force = forceOpt ? forceOpt.value === true : false;

    // SOT-1560: `/recover issue:<id>` — explicitly recover a SPECIFIC circuit-breaker-halted issue.
    // The breaker moves a runaway issue to On Hold; the bulk re-scan below deliberately skips On Hold
    // (isHoldState) so it never re-runs a halted issue automatically. A human recovers it on purpose
    // here: move it back to In Progress and enqueue exactly that one issue (no bulk re-scan).
    const issueOpt = opts.find(o => o.name === 'issue');
    if (issueOpt && issueOpt.value) {
      return await handleRecoverIssue(issueOpt.value);
    }

    // 1. usage-limit cooldown のクリア
    const cd = runner.getUsageLimitCooldownUntil();
    runner.clearUsageLimitCooldown();
    if (cd) {
      const ref = cd.issueIdentifier || cd.issueId || '不明';
      actions.push(`⏳ cooldown を解除しました（${ref}）`);
    } else {
      actions.push('⏳ cooldown: なし');
    }

    // 2. 一時停止(pause)の解除
    if (isPaused()) {
      clearPause();
      actions.push('▶ pause を解除しました');
    } else {
      actions.push('▶ pause: なし');
    }

    // 3. ロック / inflight の回収
    if (force) {
      const removed = runner.forceReleaseLock();
      const before = runner.loadInflight();
      runner.saveInflight([]);
      runner.clearCurrentIssue();
      actions.push(
        `🧹 force: runner.lock を強制解放（${removed ? `was ${removed}` : 'ロックなし'}）/ inflight ${before.length}件クリア / current-issue クリア`,
      );
    } else {
      const reaped = runner.reapStaleInflight();
      if (runner.isLocked()) {
        actions.push('🔒 実行中ロックあり: inflight は保持（強制したい場合は force:true）');
      } else if (reaped.length > 0) {
        actions.push(`🧹 leaked inflight を ${reaped.length}件回収（${reaped.join(', ')}）`);
      } else {
        actions.push('🧹 leaked inflight: なし');
      }
    }

    // 4. Linear の actionable Issue を再スキャンして未投入分を enqueue
    let enqueuedCount = 0;
    try {
      const actives = await runner.fetchActiveIssues();
      for (const issue of (actives || [])) {
        if (isHoldState({ name: issue.stateName ?? undefined })) continue; // In Review は対象外
        const identifier = issue.identifier || issue.id;
        if (!identifier) continue;
        if (runner.isQueuedOrRunning(identifier)) continue;
        runner.enqueue(identifier, 'discord-recover', null, {
          priority: issue.priority ?? null,
          priorityLabel: issue.priorityLabel ?? null,
          parentIssueId: issue.parentIssueId ?? null,
          parentIssueIdentifier: issue.parentIssueIdentifier ?? null,
        });
        enqueuedCount++;
      }
      actions.push(`📥 Linear 再スキャン: ${enqueuedCount}件を再投入（actionable ${actives ? actives.length : 0}件中）`);
    } catch (err: any) {
      runner.log('DISCORD', `handleRecover fetchActiveIssues failed: ${err.message}`);
      actions.push(`⚠ Linear 再スキャンに失敗（既存キューで続行）: ${err.message}`);
    }

    // 5. 終端/archived をキューから除去
    try {
      await runner.syncQueueWithLinear();
    } catch (err: any) {
      runner.log('DISCORD', `handleRecover syncQueueWithLinear failed: ${err.message}`);
    }

    const queueLen = runner.loadQueue().length;

    // 6. ドレインを非同期で起動（Discord 応答はブロックしない）
    setImmediate(() => {
      runner.drainQueue().catch((err: any) => {
        runner.log('DISCORD', `drainQueue error after /recover: ${err.message}`);
      });
    });

    runner.log('DISCORD', `Recover executed via Discord /recover (force=${force}, enqueued=${enqueuedCount})`);

    const header = force ? '## 🚑 強制復帰 (force)' : '## 🚑 強制復帰';
    const content = [
      header,
      ...actions.map(a => `- ${a}`),
      '',
      `**現在のキュー**: ${queueLen} 件 — ドレインを開始しました。`,
    ].join('\n');

    return { content: truncate(content) };
  } catch (err: any) {
    runner.log('DISCORD', `handleRecover error: ${err.message}`);
    const partial = actions.length > 0 ? `\n実施済み:\n${actions.map(a => `- ${a}`).join('\n')}` : '';
    return { content: `❌ 復帰処理中にエラーが発生しました: ${err.message}${partial}` };
  }
}

export {
  handleStatus,
  handleQueue,
  handlePastQueue,
  handleReorder,
  handleCooldown,
  handlePause,
  handleResume,
  handleReply,
  handleRetry,
  handleRecover,
};
