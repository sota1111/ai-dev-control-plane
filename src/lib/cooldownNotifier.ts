'use strict';

import { getWorkerCooldownStatus, WorkerCooldownStatus } from './workerCooldown.js';
import { DiscordNotifier } from './discordNotifier.js';
import { getSecret } from '../config/secrets.js';

export function resolveNotifyWebhook(notifyUrl?: string | null, fallbackUrl?: string | null): string | null {
  return notifyUrl || fallbackUrl || null;
}

export function buildCooldownMessage(status: WorkerCooldownStatus, triggeredWorker?: 'antigravity'|'codex'|'runner'): string {
  const activeWorkers = status.workers.filter(w => w.active);
  
  if (activeWorkers.length === 0) {
    return '全workerが稼働中';
  }

  let lines: string[] = [];
  lines.push('⏳ **Worker Cooldown Status**');
  if (triggeredWorker) {
    lines.push(`Triggered by: \`${triggeredWorker}\``);
  }

  for (const w of activeWorkers) {
    const resumeAt = w.resumeAt ? new Date(w.resumeAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : 'unknown';
    lines.push(`${w.worker}: 復帰 ${resumeAt} (残り ${w.remainingHuman})`);
  }

  if (status.degraded) {
    lines.push('⚠️ **DEGRADED: antigravity と codex が同時に停止中**');
  }

  return lines.join('\n');
}

export function buildUnknownResetMessage(worker: 'antigravity'|'codex'|'runner'): string {
  let lines: string[] = [];
  lines.push('⏳ **Worker Usage Limit**');
  lines.push(`Triggered by: \`${worker}\``);
  lines.push(`${worker}: usage-limit を検知しました（復帰時間: 不明）`);
  lines.push('⚠️ 自動再開時刻を特定できないため、cooldown は設定されていません。');
  return lines.join('\n');
}

export async function notifyCooldown(opts?: { status?: WorkerCooldownStatus; webhookUrl?: string | null; triggeredWorker?: 'antigravity'|'codex'|'runner' }): Promise<boolean> {
  try {
    const status = opts?.status || getWorkerCooldownStatus();
    let webhookUrl = opts?.webhookUrl;

    if (webhookUrl === undefined) {
      webhookUrl = resolveNotifyWebhook(getSecret('DISCORD_WEBHOOK_URL_NOTIFY'), getSecret('DISCORD_WEBHOOK_URL'));
    }

    if (!webhookUrl) {
      return false;
    }

    const message = buildCooldownMessage(status, opts?.triggeredWorker);
    const notifier = new DiscordNotifier(webhookUrl);
    notifier.add(message);
    await notifier.stop();
    return true;
  } catch (err: any) {
    process.stderr.write(`[cooldownNotifier] Warning: ${err.message}\n`);
    return false;
  }
}

export async function notifyUsageLimitUnknownReset(opts: { worker: 'antigravity'|'codex'|'runner'; webhookUrl?: string | null }): Promise<boolean> {
  try {
    let webhookUrl = opts.webhookUrl;

    if (webhookUrl === undefined) {
      webhookUrl = resolveNotifyWebhook(getSecret('DISCORD_WEBHOOK_URL_NOTIFY'), getSecret('DISCORD_WEBHOOK_URL'));
    }

    if (!webhookUrl) {
      return false;
    }

    const message = buildUnknownResetMessage(opts.worker);
    const notifier = new DiscordNotifier(webhookUrl);
    notifier.add(message);
    await notifier.stop();
    return true;
  } catch (err: any) {
    process.stderr.write(`[cooldownNotifier] Warning: ${err.message}\n`);
    return false;
  }
}
