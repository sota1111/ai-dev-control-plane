'use strict';

import { DiscordNotifier } from './discordNotifier.js';
import { resolveNotifyWebhook } from './cooldownNotifier.js';
import { getSecret } from '../config/secrets.js';

// Discord notifications for lane / detached execution (SOT-911 案② / SOT-917).
// Mirrors cooldownNotifier: a one-shot DiscordNotifier posted to
// DISCORD_WEBHOOK_URL_NOTIFY (falling back to DISCORD_WEBHOOK_URL). All functions
// are best-effort and must never throw into the runner path.

export type DetachedOutcome = 'success' | 'unverified' | 'usage_limit' | 'failed';

const OUTCOME_META: Record<DetachedOutcome, { emoji: string; label: string }> = {
  success: { emoji: '✅', label: '完了' },
  unverified: { emoji: '⚠️', label: '完了（未検証 — 成功クリーンアップskip）' },
  usage_limit: { emoji: '⏳', label: 'usage-limit（resume 再投入）' },
  failed: { emoji: '❌', label: '失敗' }
};

export function buildDetachedLaunchedMessage(opts: {
  issueId: string;
  lane: string;
  pid?: number;
  resume?: boolean;
}): string {
  const pid = opts.pid != null ? String(opts.pid) : 'unknown';
  const resume = opts.resume ? ' (resume)' : '';
  return (
    '🚀 **Detached run launched**' + resume + '\n' +
    `issue: \`${opts.issueId}\`  lane: \`${opts.lane}\`  pid: \`${pid}\``
  );
}

export function buildDetachedCompletedMessage(opts: {
  issueId: string;
  lane: string;
  exitCode: number;
  outcome: DetachedOutcome;
}): string {
  const meta = OUTCOME_META[opts.outcome] || OUTCOME_META.failed;
  return (
    `${meta.emoji} **Detached run ${meta.label}**\n` +
    `issue: \`${opts.issueId}\`  lane: \`${opts.lane}\`  exit: \`${opts.exitCode}\``
  );
}

function resolveWebhook(webhookUrl?: string | null): string | null {
  if (webhookUrl !== undefined) return webhookUrl;
  return resolveNotifyWebhook(getSecret('DISCORD_WEBHOOK_URL_NOTIFY'), getSecret('DISCORD_WEBHOOK_URL'));
}

async function send(message: string, webhookUrl?: string | null): Promise<boolean> {
  try {
    const url = resolveWebhook(webhookUrl);
    if (!url) return false;
    const notifier = new DiscordNotifier(url);
    notifier.add(message);
    await notifier.stop();
    return true;
  } catch (err: any) {
    process.stderr.write(`[laneNotifier] Warning: ${err.message}\n`);
    return false;
  }
}

export async function notifyDetachedLaunched(opts: {
  issueId: string;
  lane: string;
  pid?: number;
  resume?: boolean;
  webhookUrl?: string | null;
}): Promise<boolean> {
  return send(buildDetachedLaunchedMessage(opts), opts.webhookUrl);
}

export async function notifyDetachedCompleted(opts: {
  issueId: string;
  lane: string;
  exitCode: number;
  outcome: DetachedOutcome;
  webhookUrl?: string | null;
}): Promise<boolean> {
  return send(buildDetachedCompletedMessage(opts), opts.webhookUrl);
}
