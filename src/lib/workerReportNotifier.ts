'use strict';

import fs from 'node:fs';
import { DiscordNotifier } from './discordNotifier.js';
import { getSecret } from '../config/secrets.js';

export type WorkerName = 'antigravity' | 'codex';

const WORKER_LABEL: Record<WorkerName, string> = {
  antigravity: 'Antigravity',
  codex: 'Codex',
};

// SOT-1349: build the Discord message for a worker's report so that Codex / Antigravity
// output is surfaced to Discord (previously only Claude Code's own stdout reached Discord).
export function buildWorkerReportMessage(worker: WorkerName, report: string): string {
  const label = WORKER_LABEL[worker] || worker;
  const header = `📋 **${label} Worker Report**`;
  const body = (report || '').replace(/\s+$/, '');
  if (!body.trim()) {
    return `${header}\n(レポートが空です)`;
  }
  return `${header}\n${body}`;
}

// Post a worker's report to Discord. Best-effort: never throws, returns false on any
// failure (no webhook, unreadable report, empty report, network error). Reuses the
// existing DiscordNotifier (1990-char chunking + 429 retry) and the notify webhook
// resolution shared with cooldownNotifier.
export async function notifyWorkerReport(opts: {
  worker: WorkerName;
  report?: string;
  reportPath?: string;
  webhookUrl?: string | null;
}): Promise<boolean> {
  try {
    let report = opts.report;
    if (report === undefined && opts.reportPath) {
      try {
        report = fs.readFileSync(opts.reportPath, 'utf8');
      } catch (err: any) {
        process.stderr.write(`[workerReportNotifier] Warning: cannot read report ${opts.reportPath}: ${err.message}\n`);
        return false;
      }
    }

    if (!report || !report.trim()) {
      return false;
    }

    let webhookUrl = opts.webhookUrl;
    if (webhookUrl === undefined) {
      webhookUrl = getSecret('DISCORD_WEBHOOK_URL');
    }

    if (!webhookUrl) {
      return false;
    }

    const message = buildWorkerReportMessage(opts.worker, report);
    const notifier = new DiscordNotifier(webhookUrl);
    notifier.add(message);
    await notifier.stop();
    return true;
  } catch (err: any) {
    process.stderr.write(`[workerReportNotifier] Warning: ${err.message}\n`);
    return false;
  }
}
