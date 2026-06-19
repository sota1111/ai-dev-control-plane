'use strict';

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import dotenv from 'dotenv';
import { getSecret, initSecrets } from './config/secrets.js';
import { DiscordNotifier } from './lib/discordNotifier.js';
import { verifyDiscordSignature } from './lib/discordInteractions.js';
import { routeInteraction } from './lib/discordCommandRouter.js';
import { isTerminalState, isHoldState } from './lib/issueState.js';
import { resolveNotifyWebhook } from './lib/cooldownNotifier.js';
import * as runner from './runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const _discordNotifier = getSecret('DISCORD_WEBHOOK_URL')
  ? new DiscordNotifier(getSecret('DISCORD_WEBHOOK_URL'))
  : null;

if (_discordNotifier) {
  _discordNotifier.start();
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function(chunk: any, ...args: any[]) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStdoutWrite(chunk, ...args);
  };
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function(chunk: any, ...args: any[]) {
    _discordNotifier.add(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return _origStderrWrite(chunk, ...args);
  };
}

const WEBHOOK_EVENTS_FILE = path.join(runner.LOG_DIR, 'linear.webhook-events.json');
const WEBHOOK_EVENT_TTL_MS = 60 * 60 * 1000; // 1 hour

// Distinguish parent-received signals from child process signals
process.on('SIGTERM', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGTERM at ${new Date().toISOString()} — user-initiated stop, shutting down gracefully`);
  if (_discordNotifier) _discordNotifier.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[WEBHOOK:PARENT] Server received SIGINT at ${new Date().toISOString()} — user-initiated stop (Ctrl+C), shutting down gracefully`);
  if (_discordNotifier) _discordNotifier.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  // Log but DO NOT exit — keep server alive
  console.error(`[WEBHOOK:PARENT] uncaughtException at ${new Date().toISOString()}: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
  // Log but DO NOT exit — keep server alive
  const msg = reason instanceof Error ? reason.stack : String(reason);
  console.error(`[WEBHOOK:PARENT] unhandledRejection at ${new Date().toISOString()}: ${msg}`);
});

const app = express();
app.use(express.json({
  verify: (req: any, res: any, buf: Buffer) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// Error handler for JSON parsing errors
app.use((err: any, req: any, res: any, next: any) => {
  if (err instanceof SyntaxError && (err as any).status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
const QUEUE_DRAIN_INTERVAL_MS = parseInt(process.env.QUEUE_DRAIN_INTERVAL_MS || '300000', 10); // 既定5分

let _periodicDrainRunning = false; // in-process 再入ガード（interval callback の重なり防止）
let _reaperRunning = false;        // reaper 再入ガード
let _prevReaperCooldownActive = false; // 前tick時点で cooldown 中だったか（cooldown明け検知用）

// 期限到来済み（due）のキュー項目が1つでもあるか
function hasDueQueueItem(): boolean {
  const now = Date.now();
  return runner.loadQueue().some(
    (item: any) => !item.retryAt || new Date(item.retryAt).getTime() <= now
  );
}

// 起動/回収サマリの通知文言を組み立てる純粋関数（テスト容易化のため分離）。
// 案B: 回収した取り残しIssueの識別子も文言に含める。
// 例: 「🔄 bootstrap: 取り残し処理を1件回収 (SOT-839)」
// 報告対象が無い（enqueued=0 かつ reaped=0）ときは null を返し、呼び出し側は通知しない。
function formatBootstrapSummary(
  source: string,
  counts: { enqueued: number; reaped: number; reapedIds?: string[] }
): string | null {
  if (counts.enqueued === 0 && counts.reaped === 0) return null;
  const parts: string[] = [];
  if (counts.enqueued > 0) parts.push(`未処理Issueを${counts.enqueued}件再投入`);
  if (counts.reaped > 0) {
    const ids = counts.reapedIds && counts.reapedIds.length > 0 ? ` (${counts.reapedIds.join(', ')})` : '';
    parts.push(`取り残し処理を${counts.reaped}件回収${ids}`);
  }
  return `🔄 ${source}: ${parts.join(' / ')}`;
}

// 起動スキャン・回収サマリを NOTIFY 側 Discord webhook に1行通知する（運用ログ）。
// 非fatal: 失敗してもスキャン/drain本処理を妨げない。報告対象が無い（enqueued=0かつreaped=0）
// ときは何もしない。NOTIFY 未設定時は一般 webhook にフォールバックする。
async function notifyBootstrapSummary(
  source: string,
  counts: { enqueued: number; reaped: number; reapedIds?: string[] }
): Promise<void> {
  const message = formatBootstrapSummary(source, counts);
  if (message === null) return;
  try {
    const url = resolveNotifyWebhook(getSecret('DISCORD_WEBHOOK_URL_NOTIFY'), getSecret('DISCORD_WEBHOOK_URL'));
    if (!url) return;
    const notifier = new DiscordNotifier(url);
    notifier.add(message);
    await notifier.stop();
  } catch (err: any) {
    runner.log('BOOTSTRAP', `notifyBootstrapSummary error (non-fatal): ${err.message}`);
  }
}

// Linear をスキャンし、未キューの active(Todo/In Progress) Issue を実行キューへ投入する。
// runBootstrapScan と reaper の共通処理。投入した件数を返す。
async function scanAndEnqueueActiveIssues(trigger: string): Promise<number> {
  let issues: any[] = [];
  try {
    issues = await runner.fetchActiveIssues(50);
  } catch (err: any) {
    runner.log('SCAN', `fetchActiveIssues error: ${err.message}`);
    return 0;
  }

  runner.log('SCAN', `${trigger}: found ${issues.length} active issue(s)`);
  if (issues.length === 0) return 0;

  const cooldown = runner.getUsageLimitCooldownUntil();
  const cooldownRetryAt = cooldown ? cooldown.retryAt : null;

  let enqueuedCount = 0;
  for (const issue of issues) {
    const { identifier, priority, priorityLabel, parentIssueId, parentIssueIdentifier, stateName } = issue;

    if (runner.isQueued(identifier)) {
      runner.log('SCAN', `${trigger}: skip ${identifier} (already queued)`);
      continue;
    }

    // In Review は人間のレビュー待ちの保留状態。type が "started" のため fetchActiveIssues に
    // 含まれるが、自動実行の対象外なので再投入しない（SOT-841 のような終端Issueの再実行ループ防止）。
    if (isHoldState({ name: stateName })) {
      runner.log('SCAN', `${trigger}: skip ${identifier} (hold state In Review)`);
      continue;
    }

    const retryAt = cooldownRetryAt || null;
    runner.enqueue(identifier, trigger, retryAt, {
      priority,
      priorityLabel,
      parentIssueId,
      parentIssueIdentifier
    });
    runner.log('SCAN', `${trigger}: enqueued ${identifier}${retryAt ? ` retryAt=${retryAt}` : ''}`);
    enqueuedCount++;
  }

  return enqueuedCount;
}

// 取り残されたIssueの回収（reaper）。
// webhook は新規イベントでしか発火しないため、cooldown中に In Progress のまま取り残されたIssueは
// 定期drain（メモリ内キューしか見ない）からは不可視になる。reaper は Linear を再スキャンして
// そうしたIssueを実行キューへ再投入する。主トリガーは cooldown 明けの遷移、加えてアイドル時の
// セーフティネットとしても動作する。
async function runReaperTick(): Promise<void> {
  if (_reaperRunning) return;
  if (process.env.WEBHOOK_REAPER_ENABLED === 'false') return; // 既定有効・明示falseで無効化

  // cooldown 明け検知のため、early-return の前に前回状態を更新する
  const cooldownActive = runner.getUsageLimitCooldownUntil() !== null;
  const cooldownJustCleared = _prevReaperCooldownActive && !cooldownActive;
  _prevReaperCooldownActive = cooldownActive;

  // クラッシュ回収: 取り残された inflight エントリをTTLで回収する。
  // cooldown中/アイドル時でも安全（実行中ロック時は reapStaleInflight 側でno-op）。
  let reapedIds: string[] = [];
  try {
    reapedIds = runner.reapStaleInflight();
  } catch (err: any) {
    runner.log('REAPER', `reapStaleInflight error (non-fatal): ${err.message}`);
  }
  if (reapedIds.length > 0) {
    await notifyBootstrapSummary('reaper', { enqueued: 0, reaped: reapedIds.length, reapedIds });
  }

  if (runner.isLocked()) return;        // 実行中はスキップ
  if (cooldownActive) return;           // cooldown中はスキップ（明けてから回収）
  if (!getSecret('LINEAR_API_KEY')) return; // APIキー未設定ならスキップ

  // トリガー: cooldown明け、またはアイドル（dueなキュー項目なし）時のセーフティネット。
  // アイドル時に限定することで Linear API 呼び出しを稼働中に多発させない。
  if (!cooldownJustCleared && hasDueQueueItem()) return;

  _reaperRunning = true;
  try {
    const enqueued = await scanAndEnqueueActiveIssues('webhook-reaper');
    if (enqueued > 0) {
      runner.log('REAPER', `reaper: re-enqueued ${enqueued} stranded issue(s), draining`);
      await notifyBootstrapSummary('reaper', { enqueued, reaped: 0 });
      try {
        await runner.syncQueueWithLinear();
      } catch (err: any) {
        runner.log('REAPER', `reaper: syncQueueWithLinear error (non-fatal): ${err.message}`);
      }
      await runner.drainQueue();
    }
  } catch (err: any) {
    runner.log('REAPER', `reaper error: ${err.message}`);
  } finally {
    _reaperRunning = false;
  }
}

// 1回分のアイドルdrainチェック。条件を満たすときだけ drainQueue を呼ぶ。
async function runPeriodicDrainTick(): Promise<void> {
  if (_periodicDrainRunning) return;                      // 多重起動防止（再入ガード）
  if (runner.isLocked()) return;                          // 実行中はスキップ
  if (runner.getUsageLimitCooldownUntil() !== null) return; // cooldown中はスキップ
  if (!hasDueQueueItem()) return;                          // 適格項目なし
  _periodicDrainRunning = true;
  try {
    runner.log('QUEUE', 'periodic drain: idle queue has due item(s), draining');
    await runner.drainQueue();
  } catch (err: any) {
    runner.log('QUEUE', `periodic drain error: ${err.message}`);
  } finally {
    _periodicDrainRunning = false;
  }
}

// interval を開始し、その timer を返す（テストで停止できるよう返り値を返すこと）
function startPeriodicDrain(intervalMs: number = QUEUE_DRAIN_INTERVAL_MS): NodeJS.Timeout {
  const timer = setInterval(() => {
    // reaper（Linear再スキャン→取り残しIssue回収）→ 既存の定期drain（メモリ内キュー）の順で実行
    runReaperTick()
      .catch((err) => {
        runner.log('REAPER', `reaper tick uncaught: ${err.message}`);
      })
      .finally(() => {
        runPeriodicDrainTick().catch((err) => {
          runner.log('QUEUE', `periodic drain tick uncaught: ${err.message}`);
        });
      });
  }, intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref(); // プロセス終了を妨げない
  return timer;
}

function loadDedupeStore(): Record<string, string> {
  try {
    if (!fs.existsSync(WEBHOOK_EVENTS_FILE)) return {};
    const content = fs.readFileSync(WEBHOOK_EVENTS_FILE, 'utf8');
    const store = JSON.parse(content);
    // Prune expired entries (older than 1 hour)
    const now = Date.now();
    const pruned: Record<string, string> = {};
    for (const [key, receivedAt] of Object.entries(store)) {
      if (now - new Date(receivedAt as string).getTime() < WEBHOOK_EVENT_TTL_MS) {
        pruned[key] = receivedAt as string;
      }
    }
    return pruned;
  } catch (err) {
    return {};
  }
}

function saveDedupeStore(store: Record<string, string>): void {
  try {
    if (!fs.existsSync(runner.LOG_DIR)) fs.mkdirSync(runner.LOG_DIR, { recursive: true });
    const tmp = WEBHOOK_EVENTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, WEBHOOK_EVENTS_FILE);
  } catch (err: any) {
    runner.log('WEBHOOK', `saveDedupeStore ERROR: ${err.message}`);
  }
}

function getEventKey(body: any, issueId: string): string {
  if (body.id) return body.id;
  // Fallback: hash of type+action+issueId+updatedAt
  const raw = JSON.stringify({
    type: body.type || '',
    action: body.action || '',
    issueId: issueId || '',
    updatedAt: body.data && body.data.updatedAt ? body.data.updatedAt : ''
  });
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function isDedupeEvent(key: string): boolean {
  const store = loadDedupeStore();
  return !!store[key];
}

function markDedupeEvent(key: string): void {
  const store = loadDedupeStore();
  store[key] = new Date().toISOString();
  saveDedupeStore(store);
}

function verifyLinearSignature(req: any): boolean {
  if (!getSecret('LINEAR_WEBHOOK_SECRET')) {
    return true; // development mode: skip verification
  }
  const signature = req.headers['linear-signature'];
  if (!signature) {
    runner.log('WEBHOOK', 'No linear-signature header found');
    return false;
  }
  const expected = crypto
    .createHmac('sha256', getSecret('LINEAR_WEBHOOK_SECRET') as string)
    .update(req.rawBody || '')
    .digest('hex');
  return signature === expected;
}

if (!getSecret('LINEAR_WEBHOOK_SECRET')) {
  console.warn('[WEBHOOK] WARNING: LINEAR_WEBHOOK_SECRET not set. Running in development mode without signature verification.');
}

app.get('/health', (req: any, res: any) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/webhooks/linear', (req: any, res: any) => {
  const body = req.body;
  
  // express.json() handles parsing, but we check if it succeeded
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (!verifyLinearSignature(req)) {
    runner.log('WEBHOOK', 'Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  runner.log('WEBHOOK', `Received event type=${body.type || 'unknown'} action=${body.action || 'unknown'} at ${new Date().toISOString()}`);

  // Deduplicate: ignore retransmitted events
  const eventKey = getEventKey(body, body.data && body.data.identifier ? body.data.identifier : body.data && body.data.id ? body.data.id : '');
  if (isDedupeEvent(eventKey)) {
    runner.log('WEBHOOK', `ignored: duplicate event key=${eventKey}`);
    return res.status(200).json({ status: 'ignored', reason: 'duplicate event' });
  }
  markDedupeEvent(eventKey);

  if (body.type !== "Issue") {
    return res.status(200).json({ status: "ignored", reason: "not an issue event" });
  }

  const action = body.action || "";
  const issueId = body.data?.identifier || body.data?.id;
  const stateName = body.data?.state?.name || "";
  const stateType = body.data?.state?.type || "";
  const archivedAt = body.data?.archivedAt || null;

  runner.log('WEBHOOK', `Issue event: identifier=${issueId || 'unknown'} action=${action} state.name=${stateName} state.type=${stateType} labels=${(body.data?.labels || []).map((l: any) => l.name).join(',')}`);

  if (!["create", "update"].includes(action)) {
    return res.status(200).json({ status: "ignored", reason: "unhandled action" });
  }

  if (!issueId) {
    return res.status(200).json({ status: "ignored", reason: "no issue id" });
  }

  if (isTerminalState({ type: stateType, name: stateName })) {
    runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=terminal state`, { issue: issueId });
    runner.removeFromQueue(issueId);
    // A child issue just reached a terminal state. Children are processed in their own
    // single-issue runs, so nobody finalizes the parent — advance it to In Review here
    // if all of its children are now done (SOT-840). Fire-and-forget; never blocks the ack.
    const parentId = body.data?.parent?.identifier ?? body.data?.parent?.id ?? null;
    if (parentId) {
      setImmediate(async () => {
        try {
          await runner.finalizeParentIfChildrenComplete(issueId, parentId);
        } catch (e: any) {
          runner.log("WEBHOOK", `finalizeParent error: ${e.message}`, { issue: issueId });
        }
      });
    }
    return res.status(200).json({ status: "ignored", reason: `terminal state: ${stateName || stateType}` });
  }

  if (archivedAt) {
    runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=archived issue`, { issue: issueId });
    runner.removeFromQueue(issueId);
    return res.status(200).json({ status: "ignored", reason: "archived issue" });
  }

  // For update events: only proceed if a meaningful field changed.
  // Label-only changes (e.g. AI removing usage-limit label) are non-meaningful.
  if (action === "update") {
    const updatedFrom = body.updatedFrom;
    const meaningfulFields = ["stateId", "title", "description", "priority", "assigneeId", "dueDate", "estimate", "parentId"];
    const hasMeaningfulChange = updatedFrom && meaningfulFields.some(f => f in updatedFrom);

    if (updatedFrom && !hasMeaningfulChange) {
      runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=non-meaningful update`, { issue: issueId });
      return res.status(200).json({ status: "ignored", reason: "non-meaningful update" });
    }
  }

  // 既に処理中またはキュー内にある場合はスキップ
  if (runner.isQueuedOrRunning(issueId)) {
    return res.status(200).json({ status: "ignored", reason: `already queued or running: ${issueId}` });
  }

  res.status(200).json({ status: "accepted", issueId: issueId });

  setImmediate(async () => {
    try {
      const issuePriority = body.data?.priority ?? null;
      const issuePriorityLabel = body.data?.priorityLabel ?? null;
      const parentIssueId = body.data?.parent?.id ?? null;
      const parentIssueIdentifier = body.data?.parent?.identifier ?? null;
      const isUrgent = issuePriority === 1;

      const cooldown = runner.getUsageLimitCooldownUntil();
      if (cooldown) {
        const cooldownRetryAt = cooldown.retryAt;
        runner.enqueue(issueId, 'webhook', cooldownRetryAt, {
          priority: issuePriority,
          priorityLabel: issuePriorityLabel,
          parentIssueId,
          parentIssueIdentifier
        });
        runner.log('WEBHOOK', `usage limit cooldown active, queued until ${cooldownRetryAt}`, { issue: issueId });
        return;
      }

      if (!isUrgent && runner.isLocked()) {
        // Non-Urgent while locked: enqueue for later drain
        runner.enqueue(issueId, 'webhook', null, {
          priority: issuePriority,
          priorityLabel: issuePriorityLabel,
          parentIssueId,
          parentIssueIdentifier
        });
        runner.log('WEBHOOK', `non-Urgent issue (priority=${issuePriority}) queued while locked, queue size=${runner.loadQueue().length}`, { issue: issueId });
        return;
      }

      // Linear 全体チェック: Todo/In Progress Issue がなければ起動しない
      let hasPending = true;
      try {
        hasPending = await runner.hasPendingIssues();
      } catch (e: any) {
        runner.log('WEBHOOK', `hasPendingIssues error (fail-open): ${e.message}`, { issue: issueId });
      }
      if (!hasPending) {
        runner.log('WEBHOOK', 'no pending issues in Linear, skipping run', { issue: issueId });
        return;
      }

      // キューに追加してすぐ取り出す
      runner.enqueue(issueId, 'webhook', null, {
        priority: issuePriority,
        priorityLabel: issuePriorityLabel,
        parentIssueId,
        parentIssueIdentifier
      });
      // Refresh queued items' priority from Linear before selecting. Priority-only changes do not
      // fire a webhook, so a recently-bumped Urgent/High issue would otherwise stay behind a lower
      // priority item. Fail-open: never block execution on a refresh error.
      try {
        await runner.refreshQueuePriorities();
      } catch (e: any) {
        runner.log('WEBHOOK', `refreshQueuePriorities error (fail-open): ${e.message}`, { issue: issueId });
      }

      const item = runner.dequeue();
      if (!item) return;
      const queuedIssueId = item.issueId;

      // ロック取得
      const locked = runner.acquireLock({ trigger: 'webhook', issue: queuedIssueId });
      if (!locked) {
        runner.log('WEBHOOK', 'SKIPPED_LOCKED — re-enqueuing', { issue: queuedIssueId });
        runner.enqueue(queuedIssueId, 'webhook', null, {
          priority: item.priority ?? null,
          priorityLabel: item.priorityLabel ?? null,
          parentIssueId: item.parentIssueId ?? null,
          parentIssueIdentifier: item.parentIssueIdentifier ?? null
        });
        return;
      }

      try {
        await runner.runItem(item);
      } finally {
        runner.releaseLock();
        // After main task: drain remaining queue
        const queueSize = runner.loadQueue().length;
        if (queueSize > 0) {
          runner.log('QUEUE', `main task done, draining ${queueSize} remaining item(s)`);
          await runner.drainQueue();
        } else {
          runner.log('QUEUE', 'main task done, queue empty — no drain needed');
        }
      }
    } catch (err: any) {
      runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
    }
  });
});

app.post('/webhooks/discord', (req: any, res: any) => {
  const publicKey = getSecret('DISCORD_PUBLIC_KEY');
  if (!publicKey) {
    runner.log('DISCORD', 'DISCORD_PUBLIC_KEY not configured — rejecting request');
    return res.status(401).json({ error: 'Discord public key not configured' });
  }

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = req.rawBody;

  if (!signature || !timestamp || !rawBody) {
    runner.log('DISCORD', 'Missing signature headers');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  if (!verifyDiscordSignature(publicKey, signature, timestamp, rawBody)) {
    runner.log('DISCORD', 'Signature verification failed');
    return res.status(401).json({ error: 'Invalid request signature' });
  }

  const interaction = req.body;

  routeInteraction(interaction)
    .then(({ status, body }: { status: number, body: any }) => {
      res.status(status).json(body);
    })
    .catch((err: any) => {
      runner.log('DISCORD', `Error handling interaction: ${err.message}`);
      res.status(200).json({
        type: 4,
        data: { content: 'エラーが発生しました。しばらくしてから再試行してください。', flags: 64 },
      });
    });
});

async function runBootstrapScan(): Promise<void> {
  // 既定有効・明示 false で無効化（reaper の WEBHOOK_REAPER_ENABLED と既定方針を揃える）。
  const enabled = process.env.WEBHOOK_BOOTSTRAP_SCAN_ENABLED !== 'false';
  if (!enabled) {
    runner.log('BOOTSTRAP', 'startup scan disabled (WEBHOOK_BOOTSTRAP_SCAN_ENABLED=false)');
    return;
  }

  if (!getSecret('LINEAR_API_KEY')) {
    runner.log('BOOTSTRAP', 'startup scan skipped: LINEAR_API_KEY not set');
    return;
  }

  const startedAt = new Date().toISOString();
  runner.log('BOOTSTRAP', `startup scan started at ${startedAt}`);

  // クラッシュ回収: 起動時に取り残された inflight を回収する。
  let reapedIds: string[] = [];
  try {
    reapedIds = runner.reapStaleInflight();
    if (reapedIds.length > 0) {
      runner.log('BOOTSTRAP', `startup: reaped ${reapedIds.length} leaked inflight entr${reapedIds.length === 1 ? 'y' : 'ies'}: ${reapedIds.join(', ')}`);
    }
  } catch (err: any) {
    runner.log('BOOTSTRAP', `startup reapStaleInflight error (non-fatal): ${err.message}`);
  }

  const enqueuedCount = await scanAndEnqueueActiveIssues('webhook-bootstrap');

  runner.log('BOOTSTRAP', `startup scan complete: enqueued=${enqueuedCount}`);

  await notifyBootstrapSummary('bootstrap', { enqueued: enqueuedCount, reaped: reapedIds.length, reapedIds });

  if (enqueuedCount > 0) {
    runner.log('BOOTSTRAP', 'startup scan: running syncQueueWithLinear before drain');
    try {
      await runner.syncQueueWithLinear();
    } catch (err: any) {
      runner.log('BOOTSTRAP', `startup scan: syncQueueWithLinear error (non-fatal): ${err.message}`);
    }
    runner.log('BOOTSTRAP', 'startup scan: starting drainQueue');
    try {
      await runner.drainQueue();
      runner.log('BOOTSTRAP', 'startup scan: drainQueue complete');
    } catch (err: any) {
      runner.log('BOOTSTRAP', `startup scan: drainQueue error: ${err.message}`);
    }
  } else {
    runner.log('BOOTSTRAP', 'startup scan: no new items enqueued, drain skipped');
  }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  (async () => {
    await initSecrets(['LINEAR_WEBHOOK_SECRET', 'DISCORD_PUBLIC_KEY', 'LINEAR_API_KEY', 'DISCORD_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL_NOTIFY']);
    app.listen(PORT, () => {
      console.log(`[WEBHOOK] Server listening on port ${PORT}`);
      setImmediate(() => {
        runBootstrapScan().catch((err) => {
          runner.log('BOOTSTRAP', `startup scan uncaught error: ${err.message}`);
        });
        runner.log('QUEUE', `periodic drain started, interval=${QUEUE_DRAIN_INTERVAL_MS}ms`);
        startPeriodicDrain();
      });
    });
  })();
}

export { app, runBootstrapScan, hasDueQueueItem, runPeriodicDrainTick, startPeriodicDrain, scanAndEnqueueActiveIssues, runReaperTick, formatBootstrapSummary };
