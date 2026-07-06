'use strict';

import { DiscordNotifier } from './discordNotifier.js';
import { getSecret } from '../config/secrets.js';

// SOT-1577: let a dispatched `-p` worker post short progress updates to Discord DIRECTLY while it
// works — previously only the end-of-run worker report reached Discord (workerReportNotifier). This is
// the generic "send one progress line to Discord" path used by `runner-cli notify-discord` and the
// scripts/ai/notify_discord.sh wrapper the workers call.

export interface ProgressContext {
  issueId?: string | null;
  role?: string | null;
  worker?: string | null;
}

// Build a compact, identifiable one-liner header + the worker's message body. The header lets a human
// reading Discord tell which issue / role / worker the update came from.
export function buildProgressMessage(message: string, ctx: ProgressContext = {}): string {
  const tags: string[] = [];
  if (ctx.issueId) tags.push(String(ctx.issueId));
  if (ctx.role) tags.push(String(ctx.role));
  if (ctx.worker) tags.push(String(ctx.worker));
  const header = tags.length > 0 ? `🔧 **[${tags.join(' · ')}]**` : '🔧 **progress**';
  const body = (message || '').replace(/\s+$/, '');
  return body ? `${header} ${body}` : header;
}

// Post a single progress message to Discord. Best-effort: never throws, returns false on any failure
// (no webhook, empty message, network error). Reuses DiscordNotifier (1990-char chunking + 429 retry)
// and the same notify webhook resolution as workerReportNotifier / cooldownNotifier.
export async function notifyProgress(opts: {
  message: string;
  issueId?: string | null;
  role?: string | null;
  worker?: string | null;
  webhookUrl?: string | null;
}): Promise<boolean> {
  try {
    if (!opts.message || !opts.message.trim()) {
      return false;
    }

    let webhookUrl = opts.webhookUrl;
    if (webhookUrl === undefined) {
      webhookUrl = getSecret('DISCORD_WEBHOOK_URL');
    }
    if (!webhookUrl) {
      return false;
    }

    const message = buildProgressMessage(opts.message, {
      issueId: opts.issueId,
      role: opts.role,
      worker: opts.worker,
    });
    const notifier = new DiscordNotifier(webhookUrl);
    notifier.add(message);
    await notifier.stop();
    return true;
  } catch (err: any) {
    process.stderr.write(`[progressNotifier] Warning: ${err.message}\n`);
    return false;
  }
}
