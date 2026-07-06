'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import * as runner from './runner.js';
import { parseUsageLimitResetEpoch, capRetryEpoch } from './lib/usageLimitParser.js';
import { classifyIssue } from './lib/issueClassifier.js';
import { getWorkerCooldownStatus } from './lib/workerCooldown.js';
import { initSecrets } from './config/secrets.js';
import { notifyCooldown, notifyUsageLimitUnknownReset } from './lib/cooldownNotifier.js';
import { notifyWorkerReport } from './lib/workerReportNotifier.js';
import { formatOutcomeSummary } from './lib/outcomeStats.js';
import { classifyWorkerFailure, writeAuthUnhealthy, readAuthUnhealthy, shouldSkipForAuthUnhealthy, type WorkerName } from './lib/workerHealth.js';
import { workerAuthUnhealthyTtlSeconds } from './config/env.js';
import { loadWorkerRolesConfig, type WorkerRoleConfig } from './lib/workerRoles.js';
import { parseWorkerRoleDirectives, mergeWorkerRoleOverrides } from './lib/workerRoleDirective.js';

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'classify-issue': {
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js classify-issue <issueIdentifier>\n');
        process.exit(1);
      }

      const query = `
        query($id: String!) {
          issue(id: $id) {
            id
            identifier
            title
            description
            state { name type }
            labels { nodes { name } }
          }
        }
      `;

      const data: any = await runner.linearQuery(query, { id: issueId });
      if (!data.issue) {
        process.stderr.write(`Issue not found: ${issueId}\n`);
        process.exit(1);
      }

      const issueData = {
        id: data.issue.id,
        title: data.issue.title,
        description: data.issue.description,
        labels: data.issue.labels.nodes.map((n: any) => n.name),
        status: data.issue.state.name
      };

      const result = classifyIssue(issueData);

      runner.log('CLASSIFY', `${issueId} → type=${result.type} worker=${result.worker}`, { issue: issueId, reason: result.reason });
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
      break;
    }
    case 'resolve-worker-roles': {
      // Per-issue worker override (SOT-1459): read `workers: role=chain` directives from the issue
      // description + comments, merge onto config/worker_roles.json, and (if any override) write a
      // per-issue merged config, printing its path to stdout. Prints empty stdout when there is no
      // override or on any failure (fail-open: the pipeline keeps the default config).
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js resolve-worker-roles <issueIdentifier> [baseConfigPath]\n');
        process.exit(1);
      }
      const baseConfigPath = args[1] || path.join(__dirname, '..', 'config', 'worker_roles.json');

      let text = '';
      try {
        const data: any = await runner.linearQuery(
          'query($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body } } } }',
          { id: issueId },
        );
        const description: string = typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments: string[] = (data?.issue?.comments?.nodes || []).map((n: any) => (typeof n?.body === 'string' ? n.body : ''));
        // Description first, then comments oldest→newest so the newest directive wins.
        text = [description, ...comments].join('\n');
      } catch (err: any) {
        process.stderr.write(`resolve-worker-roles: could not fetch issue ${issueId}: ${err?.message || err}\n`);
        process.stdout.write('');
        process.exit(0);
      }

      const { overrides, warnings } = parseWorkerRoleDirectives(text);
      for (const w of warnings) process.stderr.write(`resolve-worker-roles: ${w}\n`);
      const overriddenRoles = Object.keys(overrides);
      if (overriddenRoles.length === 0) {
        process.stdout.write('');
        process.exit(0);
      }

      let base: WorkerRoleConfig;
      try {
        base = loadWorkerRolesConfig(baseConfigPath);
      } catch (err: any) {
        process.stderr.write(`resolve-worker-roles: base config invalid (${baseConfigPath}): ${err?.message || err}\n`);
        process.stdout.write('');
        process.exit(0);
      }

      const merged = mergeWorkerRoleOverrides(base, overrides);
      const outDir = path.join(__dirname, '..', 'docs', 'ai', 'pipeline');
      fs.mkdirSync(outDir, { recursive: true });
      const safeIssue = String(issueId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const outPath = path.join(outDir, `worker_roles.${safeIssue}.json`);
      fs.writeFileSync(outPath, JSON.stringify(merged, null, 2));

      const summary = overriddenRoles.map((r) => `${r}=[${(overrides as any)[r].join('>')}]`).join(', ');
      process.stderr.write(`resolve-worker-roles: ${issueId} overrides ${summary} → ${outPath}\n`);
      runner.log('WORKER_ROLES', `${issueId} per-issue override: ${summary}`, { issue: issueId });
      process.stdout.write(outPath);
      process.exit(0);
      break;
    }
    case 'ensure-issue-reviewed': {
      // Loop-breaker (SOT-1438): after a pipeline run finishes, an issue must not be left in an active
      // (Todo / In Progress) state — otherwise the webhook-reaper keeps re-enqueuing it as a "stranded
      // active issue" and the pipeline loops, re-posting the same comments. Move it to In Review if it
      // is still active. Idempotent / fail-open (does nothing if already In Review / terminal / missing).
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js ensure-issue-reviewed <issueIdentifier>\n');
        process.exit(1);
      }
      const comment = `## 自動処理が一巡しました\n\nこの Issue のパイプラインが一巡し、自動では完了状態に到達しなかったため **In Review** に移行しました（無限再処理の防止）。内容を確認し、続行が必要なら Todo/In Progress に戻してください。`;
      const moved = await runner.setIssueInReview(issueId, comment).catch(() => false);
      runner.log('WORKER_ROLES', `ensure-issue-reviewed ${issueId}: ${moved ? 'moved to In Review' : 'no change (already reviewed/terminal)'}`, { issue: issueId });
      process.stdout.write(moved ? 'moved' : 'nochange');
      process.exit(0);
      break;
    }
    case 'move-on-hold': {
      // SOT-1560: circuit-breaker halt — move a runaway issue to On Hold so the reaper / recover
      // re-scan stops re-running it (isHoldState treats On Hold as a hold state). Idempotent /
      // fail-open (does nothing if already On Hold / terminal / missing). An optional reason arg is
      // included in the posted comment.
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js move-on-hold <issueIdentifier> [reason]\n');
        process.exit(1);
      }
      const reason = args.slice(1).join(' ').trim();
      const comment = `## 🛑 サーキットブレーカー発火\n\nこの Issue のパイプラインが停止条件を超過したため、無人ループの暴走を防ぐために自動停止し **On Hold** に移行しました。${reason ? `\n\n**理由:** ${reason}` : ''}\n\n再開するには Discord の \`/recover issue:${issueId}\` を実行してください（内容を確認のうえ復旧）。`;
      const moved = await runner.setIssueOnHold(issueId, comment).catch(() => false);
      runner.log('WORKER_ROLES', `move-on-hold ${issueId}: ${moved ? 'moved to On Hold' : 'no change (already on hold/terminal/missing)'}`, { issue: issueId });
      process.stdout.write(moved ? 'moved' : 'nochange');
      process.exit(0);
      break;
    }
    case 'parse-usage-limit-epoch': {
      let input = '';
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) {
        input += chunk;
      }
      const epoch = parseUsageLimitResetEpoch(input);
      if (epoch !== null) {
        // SOT-1446: cap the emitted worker-cooldown resume epoch to at most 5h out, so a
        // misparsed / far-future reset can't strand the worker for days.
        process.stdout.write(String(capRetryEpoch(epoch)));
        process.exit(0);
      } else {
        process.exit(1);
      }
      break;
    }
    case 'notify-usage-limit': {
      const epoch = parseInt(args[0], 10);
      if (isNaN(epoch)) {
        process.stderr.write('Usage: runner-cli.js notify-usage-limit <epochSeconds>\n');
        process.exit(1);
      }
      await runner.notifyUsageLimitToAllActiveIssues(epoch);
      break;
    }
    case 'remove-usage-limit-label': {
      await runner.removeUsageLimitLabelFromAllIssues();
      break;
    }
    case 'enqueue': {
      const issueId = args[0];
      const trigger = args[1] || 'manual';
      const retryAt = args[2] || null;
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js enqueue <issueId> [trigger] [retryAt]\n');
        process.exit(1);
      }
      runner.enqueue(issueId, trigger, retryAt, { reason: 'scheduler' });
      runner.log('CLI', `enqueued issueId=${issueId} trigger=${trigger}`, { issue: issueId });
      process.stdout.write(`[QUEUE] Enqueued: ${issueId} (trigger: ${trigger})\n`);
      process.exit(0);
      break;
    }
    case 'drain': {
      await runner.drainQueue();
      process.exit(0);
      break;
    }
    case 'status': {
      const queue = runner.loadQueue();
      const locked = runner.isLocked();
      const cooldown = runner.getUsageLimitCooldownUntil();
      const status = {
        locked,
        queueSize: queue.length,
        cooldown: cooldown || null,
        queue
      };
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'cooldown-status': {
      const status = getWorkerCooldownStatus();
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
      process.exit(0);
      break;
    }
    case 'notify-cooldown': {
      await initSecrets(['DISCORD_WEBHOOK_URL_NOTIFY', 'DISCORD_WEBHOOK_URL']);
      const ok = await notifyCooldown({ triggeredWorker: args[0] as any });
      process.stdout.write(`Notification ${ok ? 'sent' : 'skipped/failed'}\n`);
      process.exit(0);
      break;
    }
    case 'notify-usage-limit-unknown': {
      await initSecrets(['DISCORD_WEBHOOK_URL_NOTIFY', 'DISCORD_WEBHOOK_URL']);
      const worker = args[0] as 'antigravity'|'codex'|'runner';
      if (!['antigravity', 'codex', 'runner'].includes(worker)) {
        process.stderr.write('Usage: runner-cli.js notify-usage-limit-unknown <antigravity|codex|runner>\n');
        process.exit(1);
      }
      const ok = await notifyUsageLimitUnknownReset({ worker });
      process.stdout.write(`Notification ${ok ? 'sent' : 'skipped/failed'}\n`);
      process.exit(0);
      break;
    }
    case 'notify-worker-report': {
      await initSecrets(['DISCORD_WEBHOOK_URL']);
      const worker = args[0] as 'antigravity' | 'codex';
      if (!['antigravity', 'codex'].includes(worker)) {
        process.stderr.write('Usage: runner-cli.js notify-worker-report <antigravity|codex> [reportPath]\n');
        process.exit(1);
      }
      const reportPath = args[1];
      const ok = await notifyWorkerReport({ worker, reportPath });
      process.stdout.write(`Notification ${ok ? 'sent' : 'skipped/failed'}\n`);
      process.exit(0);
      break;
    }
    case 'aggregate-outcomes': {
      // SOT-1439 / P5: parse the runner log's structured [OUTCOME] lines and print aggregate stats.
      // Usage: runner-cli.js aggregate-outcomes [windowHours] [--json]
      //   windowHours: only count outcomes from the last N hours (default: all). `0`/omit = all.
      const windowHours = args[0] && /^\d+(\.\d+)?$/.test(args[0]) ? parseFloat(args[0]) : 0;
      const asJson = args.includes('--json');
      const windowMs = windowHours > 0 ? windowHours * 60 * 60 * 1000 : undefined;
      const summary = runner.getRecentOutcomeSummary(windowMs);
      if (asJson) {
        process.stdout.write(JSON.stringify({ windowHours: windowHours || null, ...summary }, null, 2) + '\n');
      } else {
        const scope = windowHours > 0 ? `last ${windowHours}h` : 'all-time';
        process.stdout.write(`[OUTCOMES ${scope}] ${formatOutcomeSummary(summary)}\n`);
      }
      process.exit(0);
      break;
    }
    case 'worker-health-record': {
      // SOT-1441 / P1: classify a failed worker run (report on stdin) and, if it's a CHRONIC auth
      // failure, mark the worker auth-unhealthy (short TTL) so subsequent runs skip the CLI instead
      // of re-hitting the same auth error. Prints the classified kind. Usage:
      //   worker-health-record <antigravity|codex> <exitCode>   (report piped on stdin)
      const worker = args[0] as WorkerName;
      const exitCode = parseInt(args[1] || '1', 10);
      if (!['antigravity', 'codex'].includes(worker)) {
        process.stderr.write('Usage: runner-cli.js worker-health-record <antigravity|codex> <exitCode>\n');
        process.exit(1);
      }
      let report = '';
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        report = Buffer.concat(chunks).toString('utf8');
      } catch { /* stdin optional */ }
      const kind = classifyWorkerFailure(report, exitCode);
      if (kind === 'auth_failure') {
        const expiresAt = writeAuthUnhealthy(worker, runner.LOG_DIR, workerAuthUnhealthyTtlSeconds());
        // Separated alert: CHRONIC (human must re-authenticate) — distinct from a transient cooldown.
        runner.log('WORKER_HEALTH', `${worker} CHRONIC auth failure — re-authentication required; marked auth-unhealthy until epoch ${expiresAt}`);
        process.stderr.write(`WORKER_AUTH_UNHEALTHY: ${worker} chronic auth failure — human re-auth required (marker until ${expiresAt})\n`);
      }
      process.stdout.write(kind + '\n');
      process.exit(0);
      break;
    }
    case 'auth-unhealthy-status': {
      // SOT-1548: single source of truth for run_antigravity.sh's pre-run gate. Reads the worker's
      // auth-unhealthy marker via the tested shouldSkipForAuthUnhealthy() pure logic (same module that
      // writes it) so the reader/writer can never drift on path/parsing/expiry — the ~40s-probe hole
      // seen in SOT-1533. Usage: runner-cli.js auth-unhealthy-status <antigravity|codex>
      //   exit 0 → marker FRESH   → caller should short-circuit (skip launching, hand off)
      //   exit 3 → marker not fresh (expired/missing/malformed) → caller launches as usual
      const worker = args[0] as WorkerName;
      if (!['antigravity', 'codex'].includes(worker)) {
        process.stderr.write('Usage: runner-cli.js auth-unhealthy-status <antigravity|codex>\n');
        process.exit(2);
      }
      if (shouldSkipForAuthUnhealthy(worker, runner.LOG_DIR)) {
        const status = readAuthUnhealthy(worker, runner.LOG_DIR);
        process.stdout.write(`active remaining=${status.remainingSeconds ?? 0}s expiresAtEpoch=${status.expiresAtEpoch ?? 0}\n`);
        process.exit(0);
      }
      process.stdout.write('inactive\n');
      process.exit(3);
      break;
    }
    default: {
      process.stderr.write(`Unknown command: ${command}\nAvailable: classify-issue, parse-usage-limit-epoch, notify-usage-limit, remove-usage-limit-label, enqueue, drain, status, cooldown-status, notify-cooldown, notify-usage-limit-unknown, notify-worker-report, aggregate-outcomes, worker-health-record, auth-unhealthy-status\n`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  process.stderr.write(`runner-cli error: ${err.message}\n`);
  process.exit(1);
});

