'use strict';

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import dotenv from 'dotenv';
import { getSecret, initSecrets } from './config/secrets.js';
import * as appEnv from './config/env.js';
import { DiscordNotifier } from './lib/discordNotifier.js';
import { verifyDiscordSignature } from './lib/discordInteractions.js';
import { timingSafeEqualStr } from './lib/timingSafeEqual.js';
import { routeInteraction } from './lib/discordCommandRouter.js';
import { isTerminalState, isHoldState } from './lib/issueState.js';
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

const PORT = appEnv.port();
const QUEUE_DRAIN_INTERVAL_MS = appEnv.queueDrainIntervalMs(); // 既定5分

let _periodicDrainRunning = false; // in-process 再入ガード（interval callback の重なり防止）
let _reaperRunning = false;        // reaper 再入ガード
let _prevReaperCooldownActive = false; // 前tick時点で cooldown 中だったか（cooldown明け検知用）
let _lastStrandedScanAt = 0;       // 直近で取り残し In-Progress の Linear 再スキャンを行った epoch(ms)。0=未実施

// 取り残し回収の最大間隔（SOT-925 逸脱1）。ビジーなキューが続いても、この間隔が経過していれば
// 1回だけ Linear 再スキャンを許可し、In Progress のまま取り残された Issue の starvation を防ぐ。
// テストで per-test に差し替えられるよう、モジュールロード時の const にはせず関数内で都度読む。
function reaperStrandedMaxIntervalMs(): number {
  return appEnv.reaperStrandedMaxIntervalMs(); // 既定5分
}

// 期限到来済み（due）のキュー項目が1つでもあるか
function hasDueQueueItem(): boolean {
  const now = Date.now();
  return runner.loadQueue().some(
    (item: any) => !item.retryAt || new Date(item.retryAt).getTime() <= now
  );
}

// Linear をスキャンし、未キューの active(Todo/In Progress) Issue を実行キューへ投入する。
// runBootstrapScan と reaper の共通処理。投入した件数を返す。
async function scanAndEnqueueActiveIssues(trigger: string): Promise<number> {
  let issues: any[] = [];
  try {
    // SOT-1438 / P3: exclude hold-state (In Review) at the query layer so we don't fetch them and
    // then per-item skip+log them on every reaper/bootstrap tick (~6,430 no-op skip lines).
    issues = await runner.fetchActiveIssues(50, { excludeHold: true });
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
    const { identifier, priority, priorityLabel, parentIssueId, parentIssueIdentifier, stateName, createdAt } = issue;

    if (runner.isQueued(identifier)) {
      runner.log('SCAN', `${trigger}: skip ${identifier} (already queued)`);
      continue;
    }

    // In Review は人間のレビュー待ちの保留状態。SOT-1438/P3 で fetchActiveIssues({excludeHold})
    // がクエリ層で除外するため通常ここには来ないが、防御的バックストップとして残す（万一混入しても
    // 自動実行の対象外として再投入しない。SOT-841 のような終端Issueの再実行ループ防止）。
    if (isHoldState({ name: stateName })) {
      runner.log('SCAN', `${trigger}: skip ${identifier} (hold state In Review)`);
      continue;
    }

    // SOT-1547: a run that ended code=70 (human-wait: BLOCKED / NEEDS_USER_INPUT) leaves its issue in
    // Todo/In Progress. Without gating, this reaper/bootstrap rescan re-enqueues it every ~5 min and
    // burns the account-global usage limit with no progress. Skip while inside the human-wait backoff
    // (or past the retry cap); a human webhook (comment / state change) clears the suppression and the
    // issue becomes eligible again. Fail-open: on any store error isReaperEnqueueSuppressed()=false.
    if (runner.isReaperEnqueueSuppressed(identifier)) {
      const info = runner.humanWaitSuppressionInfo(identifier);
      runner.log('SCAN', `${trigger}: skip ${identifier} (code=70 human-wait suppressed count=${info.count} nextAt=${info.nextAt})`);
      continue;
    }

    const retryAt = cooldownRetryAt || null;
    runner.enqueue(identifier, trigger, retryAt, {
      priority,
      priorityLabel,
      parentIssueId,
      parentIssueIdentifier,
      createdAt
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
  if (!appEnv.webhookReaperEnabled()) return; // 既定有効・明示falseで無効化

  // cooldown 明け検知のため、early-return の前に前回状態を更新する
  const cooldownActive = runner.getUsageLimitCooldownUntil() !== null;
  const cooldownJustCleared = _prevReaperCooldownActive && !cooldownActive;
  _prevReaperCooldownActive = cooldownActive;

  // クラッシュ回収: 取り残された inflight エントリをTTLで回収する。
  // cooldown中/アイドル時でも安全（実行中ロック時は reapStaleInflight 側でno-op）。
  try {
    runner.reapStaleInflight();
  } catch (err: any) {
    runner.log('REAPER', `reapStaleInflight error (non-fatal): ${err.message}`);
  }
  // SOT-915: デタッチ long-run の完了(done-marker)を検知し、結果を既存の enqueue/Resume 後処理へ
  // 再投入する（実行中ロック時は内部で no-op）。
  try {
    await runner.reapCompletedDetachedRuns();
  } catch (err: any) {
    runner.log('REAPER', `reapCompletedDetachedRuns error (non-fatal): ${err.message}`);
  }
  if (runner.isLocked()) return;        // 実行中はスキップ
  if (cooldownActive) return;           // cooldown中はスキップ（明けてから回収）
  if (!getSecret('LINEAR_API_KEY')) return; // APIキー未設定ならスキップ

  // トリガー: cooldown明け、またはアイドル（dueなキュー項目なし）時のセーフティネット。
  // アイドル時に限定することで Linear API 呼び出しを稼働中に多発させない。
  //
  // SOT-925 逸脱1（取り残し回収の starvation 解消）: 待機タスクが連続するとキューに常に due 項目が
  // あり、従来は Linear 再スキャンが永久に抑止され、In Progress のまま取り残された Issue（SOT-921/922 の
  // ような再開漏れ）が回収されなかった。最後の取り残しスキャンから一定間隔（REAPER_STRANDED_MAX_INTERVAL_MS）
  // が経過していれば、ビジー時でも1回だけ再スキャンを許可する（API レート制限付き）。
  // なお isLocked()/cooldownActive の early-return は上で適用済みのため、実行中・cooldown 中は再スキャンしない。
  const strandedScanDue = (Date.now() - _lastStrandedScanAt) >= reaperStrandedMaxIntervalMs();
  if (!cooldownJustCleared && hasDueQueueItem() && !strandedScanDue) return;

  _reaperRunning = true;
  _lastStrandedScanAt = Date.now(); // 取り残しスキャンを実施したのでレート制限の起点を更新
  try {
    const enqueued = await scanAndEnqueueActiveIssues('webhook-reaper');
    if (enqueued > 0) {
      runner.log('REAPER', `reaper: re-enqueued ${enqueued} stranded issue(s), draining`);
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
  // Constant-time comparison to avoid an HMAC timing side-channel (SOT-935).
  return timingSafeEqualStr(signature, expected);
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

  // SOT-1547: a new human comment is a genuine "resume" signal. Comment events are otherwise dropped
  // by the Issue-only gate below, so clear the code=70 human-wait suppression here — the next reaper
  // tick then re-enqueues the issue (its existing resume path). No direct enqueue: comments never
  // enqueued directly, and the reaper cadence is the historical comment-driven resume mechanism.
  if (body.type === "Comment") {
    const commentIssueId = body.data?.issue?.identifier || body.data?.issue?.id;
    if (commentIssueId && ["create", "update"].includes(body.action || "")) {
      if (runner.clearHumanWaitSuppression(commentIssueId)) {
        runner.log('WEBHOOK', `code=70 human-wait suppression cleared by new comment; eligible for reaper resume`, { issue: commentIssueId });
      }
    }
    return res.status(200).json({ status: "ignored", reason: "comment event" });
  }

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

  if (isHoldState({ type: stateType, name: stateName })) {
    // A child issue just moved to In Review (hold). Implementation children stop at In Review
    // (not Done), so the terminal-state branch above never fires for them — finalize the parent
    // here too so it advances to In Review once all children are complete (SOT-1551). In Review
    // is itself a hold state, so this issue is not queued for a run. Fire-and-forget; never blocks.
    runner.log("WEBHOOK", `ignored: identifier=${issueId} action=${action} state.name=${stateName} state.type=${stateType} reason=hold state (In Review)`, { issue: issueId });
    runner.removeFromQueue(issueId);
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
    return res.status(200).json({ status: "ignored", reason: `hold state: ${stateName || stateType}` });
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

  // 同一 issue のイベントバーストを1回の処理に集約する（SOT-1437 / P2）。
  // WEBHOOK_DEBOUNCE_MS=0（既定）のときは従来通り setImmediate で即時処理し、後方互換を保つ。
  const meta: IssueEventMeta = {
    priority: body.data?.priority ?? null,
    priorityLabel: body.data?.priorityLabel ?? null,
    parentIssueId: body.data?.parent?.id ?? null,
    parentIssueIdentifier: body.data?.parent?.identifier ?? null,
    createdAt: body.data?.createdAt ?? null,
  };
  scheduleIssueEvent(issueId, meta);
});

interface IssueEventMeta {
  priority: number | null;
  priorityLabel: string | null;
  parentIssueId: string | null;
  parentIssueIdentifier: string | null;
  createdAt: string | null;
}

// 同一 issue に対する未発火の debounce タイマー（issueId -> timer）。coalesce（最新イベント優先）用。
const _debounceTimers = new Map<string, NodeJS.Timeout>();

// debounce/coalesce の窓に従って issue イベント処理をスケジュールする。
// - 窓 <= 0: 従来の即時処理（setImmediate）。
// - 窓 > 0: 同一 issue の既存タイマーを解除して張り直し（＝バーストを1回に集約、最新 meta が勝つ）。
function scheduleIssueEvent(issueId: string, meta: IssueEventMeta): void {
  const windowMs = appEnv.webhookDebounceMs();
  if (windowMs <= 0) {
    setImmediate(() => {
      processIssueEvent(issueId, meta).catch((err: any) => {
        runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
      });
    });
    return;
  }

  const existing = _debounceTimers.get(issueId);
  if (existing) {
    clearTimeout(existing);
    runner.log('WEBHOOK', `debounce: coalescing burst for ${issueId} (window ${windowMs}ms)`, { issue: issueId });
  }
  const timer = setTimeout(() => {
    _debounceTimers.delete(issueId);
    processIssueEvent(issueId, meta).catch((err: any) => {
      runner.log('WEBHOOK', `processing error: ${err.message}`, { issue: issueId });
    });
  }, windowMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref(); // プロセス終了を妨げない
  _debounceTimers.set(issueId, timer);
}

// 受理済み issue イベントの実処理（enqueue → dequeue → lock → runItem → drain）。
// setImmediate / debounce タイマーの双方から同一経路で呼ばれる（挙動は従来と同一）。
async function processIssueEvent(issueId: string, meta: IssueEventMeta): Promise<void> {
  try {
    // SOT-1547: a genuine issue webhook (state change / meaningful update) is new human input — clear
    // any code=70 human-wait suppression so this event resumes the issue as before.
    if (runner.clearHumanWaitSuppression(issueId)) {
      runner.log('WEBHOOK', `code=70 human-wait suppression cleared by issue webhook`, { issue: issueId });
    }

    const { priority: issuePriority, priorityLabel: issuePriorityLabel, parentIssueId, parentIssueIdentifier, createdAt: issueCreatedAt } = meta;
    const isUrgent = issuePriority === 1;

    const cooldown = runner.getUsageLimitCooldownUntil();
    if (cooldown) {
      const cooldownRetryAt = cooldown.retryAt;
      runner.enqueue(issueId, 'webhook', cooldownRetryAt, {
        priority: issuePriority,
        priorityLabel: issuePriorityLabel,
        parentIssueId,
        parentIssueIdentifier,
        createdAt: issueCreatedAt
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
        parentIssueIdentifier,
        createdAt: issueCreatedAt
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
      parentIssueIdentifier,
      createdAt: issueCreatedAt
    });
    // Refresh queued items' priority from Linear before selecting. Priority-only changes do not
    // fire a webhook, so a recently-bumped Urgent/High issue would otherwise stay behind a lower
    // priority item. As of SOT-1352 this also re-sorts the queue into priority order, so the
    // persisted queue reflects priority at webhook-receive time (enqueue() likewise sorts on write).
    // Fail-open: never block execution on a refresh error.
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
        parentIssueIdentifier: item.parentIssueIdentifier ?? null,
        createdAt: item.createdAt ?? null
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
}

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
  const enabled = appEnv.webhookBootstrapScanEnabled();
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

  // SOT-1438: 起動時に leaked 状態（前スパナの SIGKILL 等で取り残された inflight / 死んだ PID の lock /
  // 古い current-issue）を即回収する。foreground run は新プロセスの子なので起動直後は存在しない＝
  // 生きた detached run に紐づかない inflight は leaked。これで「webhook 受信するが起動しない」を防ぐ。
  // 生きている detached run は保持される。reapStaleInflight（TTL 待ち）より先に実行。
  try {
    runner.reconcileStaleStateAtStartup();
  } catch (err: any) {
    runner.log('BOOTSTRAP', `startup reconcileStaleState error (non-fatal): ${err.message}`);
  }

  // クラッシュ回収: 起動時に取り残された inflight を回収する（TTL 経路。reconcile の補完）。
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

// テスト用に debounce タイマー Map を全消去する（各テストの分離用）。
function _resetDebounceTimers(): void {
  for (const timer of _debounceTimers.values()) clearTimeout(timer);
  _debounceTimers.clear();
}

export { app, runBootstrapScan, hasDueQueueItem, runPeriodicDrainTick, startPeriodicDrain, scanAndEnqueueActiveIssues, runReaperTick, processIssueEvent, scheduleIssueEvent, _debounceTimers, _resetDebounceTimers };
