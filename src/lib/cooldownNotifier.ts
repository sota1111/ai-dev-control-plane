'use strict';

import { getWorkerCooldownStatus, WorkerCooldownStatus } from './workerCooldown.js';
import { DiscordNotifier } from './discordNotifier.js';
import { getSecret } from '../config/secrets.js';

export function resolveNotifyWebhook(notifyUrl?: string | null, fallbackUrl?: string | null): string | null {
  return notifyUrl || fallbackUrl || null;
}

export function buildCooldownMessage(status: WorkerCooldownStatus, triggeredWorker?: 'gemini'|'codex'|'runner'): string {
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
    lines.push('⚠️ **DEGRADED: gemini と codex が同時に停止中**');
  }

  return lines.join('\n');
}

export async function notifyCooldown(opts?: { status?: WorkerCooldownStatus; webhookUrl?: string | null; triggeredWorker?: 'gemini'|'codex'|'runner' }): Promise<boolean> {
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
