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
import { notifyProgress } from './lib/progressNotifier.js';
import { formatOutcomeSummary, promotionCandidates } from './lib/outcomeStats.js';
import { classifyWorkerFailure, writeAuthUnhealthy, readAuthUnhealthy, shouldSkipForAuthUnhealthy, type WorkerName } from './lib/workerHealth.js';
import { workerAuthUnhealthyTtlSeconds } from './config/env.js';
import { loadWorkerRolesConfig, loadSoloWorker, type WorkerRoleConfig, type WorkerRole } from './lib/workerRoles.js';
import { parseWorkerRoleDirectives, mergeWorkerRoleOverrides, parseGraphDirective } from './lib/workerRoleDirective.js';
import { buildDelegationPreflight } from './lib/delegationPreflight.js';
import { parseRegistry, planSubmission, type RecentSubmission } from './lib/kaggleSubmission.js';
import {
  parseTargetsRegistry,
  planImprovementCycle,
  type GuardSignals,
  type ImprovementMaterial,
} from './lib/kaggleImprovement.js';
import { pipelineReviewComment, type PipelineReviewOutcome } from './lib/pipelineReviewComment.js';
import {
  DEFAULT_GRAPH_PATH,
  loadPipelineGraph,
  beginPipelineGraph,
  stepPipelineGraph,
  readPipelineGraphState,
  writePipelineGraphState,
} from './lib/pipelineGraph.js';

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
    case 'solo-worker': {
      // SOT-1591 (solo mode): print the single worker that runs the whole lifecycle when
      // `__solo__` is set in the worker-roles config, else empty. run_auto.sh queries this to decide
      // between one solo dispatch and the per-role pipeline. Reads WORKER_ROLES_FILE (per-issue merged
      // config) when set, else the base config. Fail-open: any error → empty (normal pipeline).
      const configPath = args[0] || process.env.WORKER_ROLES_FILE || path.join(__dirname, '..', 'config', 'worker_roles.json');
      process.stdout.write(loadSoloWorker(configPath) ?? '');
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

      const { overrides, models, solo, handoff, warnings } = parseWorkerRoleDirectives(text);
      for (const w of warnings) process.stderr.write(`resolve-worker-roles: ${w}\n`);
      const overriddenRoles = Object.keys(overrides);
      const modelledRoles = Object.keys(models);
      // A solo or handoff directive alone must also produce a per-issue file.
      if (overriddenRoles.length === 0 && modelledRoles.length === 0 && !solo && handoff === undefined) {
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
      // SOT-1583: attach per-role model pins under `__models__`. The key is `__`-prefixed so the strict
      // loader (loadWorkerRolesConfig) and the dispatcher's chain reader both ignore it; run_worker.sh
      // reads `__models__[role][worker]` to pass the model to the selected worker's run script.
      const output: Record<string, unknown> = { ...merged };
      if (handoff !== undefined) output.__handoff__ = handoff;
      // SOT-1583 role model pins + SOT-1591 solo model pin share the `__models__` section (run_worker.sh
      // reads `__models__[role][worker]`; the synthetic `solo` role is looked up the same way).
      let baseModels: Record<string, Record<string, string>> = {};
      try {
        const rawBase = JSON.parse(fs.readFileSync(baseConfigPath, 'utf8'));
        if (rawBase?.__models__ && typeof rawBase.__models__ === 'object') {
          baseModels = JSON.parse(JSON.stringify(rawBase.__models__));
        }
      } catch {
        // The validated role config already loaded successfully; invalid optional metadata is ignored.
      }
      const modelsOut: Record<string, Record<string, string>> = baseModels;
      for (const [r, m] of Object.entries(models)) modelsOut[r] = { ...(m as Record<string, string>) };
      // SOT-1591: resolve the effective solo selector for this issue.
      // - `solo=<worker>` directive → force solo on that worker (+ optional model pin);
      // - `solo=off` directive      → omit __solo__ so this issue runs the NORMAL per-role pipeline;
      // - no solo directive         → inherit the base config's __solo__ (a bare `workers:` role
      //   directive keeps solo mode; the merged file is the dispatcher's WORKER_ROLES_FILE).
      let soloSummary = '';
      if (solo) {
        if (solo.disabled) {
          soloSummary = 'solo=off';
        } else {
          output.__solo__ = solo.worker;
          if (solo.model) modelsOut.solo = { ...(modelsOut.solo || {}), [solo.worker]: solo.model };
          soloSummary = `solo=${solo.worker}${solo.model ? `:${solo.model}` : ''}`;
        }
      } else {
        const soloWorker = loadSoloWorker(baseConfigPath);
        if (soloWorker) output.__solo__ = soloWorker;
      }
      if (Object.keys(modelsOut).length > 0) output.__models__ = modelsOut;
      const outDir = path.join(__dirname, '..', 'docs', 'ai', 'pipeline');
      fs.mkdirSync(outDir, { recursive: true });
      const safeIssue = String(issueId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const outPath = path.join(outDir, `worker_roles.${safeIssue}.json`);
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

      const overrideSummary = overriddenRoles.map((r) => `${r}=[${(overrides as any)[r].join('>')}]`).join(', ');
      const modelSummary = modelledRoles
        .map((r) => `${r}{${Object.entries((models as any)[r]).map(([w, m]) => `${w}:${m}`).join(',')}}`)
        .join(', ');
      const handoffSummary = handoff === undefined ? '' : `handoff=${handoff ? 'on' : 'off'}`;
      const summary = [overrideSummary, modelSummary, soloSummary, handoffSummary].filter(Boolean).join(' | ');
      process.stderr.write(`resolve-worker-roles: ${issueId} overrides ${summary} → ${outPath}\n`);
      runner.log('WORKER_ROLES', `${issueId} per-issue override: ${summary}`, { issue: issueId });
      process.stdout.write(outPath);
      process.exit(0);
      break;
    }
    case 'resolve-pipeline-graph': {
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js resolve-pipeline-graph <issueIdentifier>\n');
        process.exit(1);
      }
      let text = '';
      try {
        const data: any = await runner.linearQuery(
          'query($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body } } } }',
          { id: issueId },
        );
        const description = typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments = (data?.issue?.comments?.nodes || []).map((n: any) => typeof n?.body === 'string' ? n.body : '');
        text = [description, ...comments].join('\n');
      } catch (err: any) {
        process.stderr.write(`resolve-pipeline-graph: could not fetch ${issueId}: ${err?.message || err}; using default\n`);
        process.stdout.write(DEFAULT_GRAPH_PATH);
        process.exit(0);
      }
      const name = parseGraphDirective(text);
      const topicDir = path.join(__dirname, '..', 'docs', 'ai', 'pipeline');
      fs.mkdirSync(topicDir, { recursive: true });
      const safeIssue = String(issueId).replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(topicDir, `discussion_topic.${safeIssue}.md`), text);
      if (!name || name === 'default') {
        process.stdout.write(DEFAULT_GRAPH_PATH);
        process.exit(0);
      }
      const graphPath = path.join(__dirname, '..', 'config', 'graphs', `${name}.json`);
      const loaded = loadPipelineGraph(graphPath);
      if (!loaded.graph) {
        process.stderr.write(`resolve-pipeline-graph: unknown/invalid graph "${name}"; using default\n`);
        process.stdout.write(DEFAULT_GRAPH_PATH);
      } else {
        process.stderr.write(`resolve-pipeline-graph: ${issueId} selected graph=${name}\n`);
        process.stdout.write(graphPath);
      }
      process.exit(0);
      break;
    }
    case 'set-issue-in-progress': {
      // SOT-1590: move an issue to In Progress at the very START of processing (run_auto.sh calls this
      // before dispatching task-check) so a picked-up issue leaves Todo immediately instead of only
      // after task-check finishes its check + 分解判断. Reuses the idempotent/fail-open helper
      // (skips terminal / already-started; never throws). Best-effort — always exits 0.
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js set-issue-in-progress <issueIdentifier>\n');
        process.exit(1);
      }
      await runner.setIssueInProgress(issueId).catch(() => {});
      runner.log('WORKER_ROLES', `set-issue-in-progress ${issueId}: requested (idempotent/fail-open)`, { issue: issueId });
      process.stdout.write('ok');
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
        process.stderr.write('Usage: runner-cli.js ensure-issue-reviewed <issueIdentifier> [completed|incomplete]\n');
        process.exit(1);
      }
      const outcome: PipelineReviewOutcome = args[1] === 'completed' ? 'completed' : 'incomplete';
      const comment = pipelineReviewComment(outcome);
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
    case 'notify-discord': {
      // SOT-1577: generic best-effort progress post used by dispatched `-p` workers (via
      // scripts/ai/notify_discord.sh) to send short updates to Discord DURING their work.
      await initSecrets(['DISCORD_WEBHOOK_URL']);
      let message = args.join(' ').trim();
      if (!message && !process.stdin.isTTY) {
        message = fs.readFileSync(0, 'utf8').trim();
      }
      if (!message) {
        process.stderr.write('Usage: runner-cli.js notify-discord <message>   (or pipe the message on stdin)\n');
        process.exit(1);
      }
      const ok = await notifyProgress({
        message,
        issueId: process.env.WEBHOOK_ISSUE_ID || null,
        role: process.env.WORKER_ROLE || null,
        worker: process.env.WORKER_SELECTED || null,
      });
      process.stdout.write(`Notification ${ok ? 'sent' : 'skipped/failed'}\n`);
      process.exit(0);
      break;
    }
    case 'aggregate-outcomes': {
      // SOT-1439 / P5: parse the runner log's structured [OUTCOME] lines and print aggregate stats.
      // SOT-1575: with --promote, also list recurring failure kinds (>= threshold) as promotion
      // candidates for docs/ai/failure-log.md (半自動: 集計 → 候補提示 → 人/Claude が恒久化を判断).
      // Usage: runner-cli.js aggregate-outcomes [windowHours] [--json] [--promote] [--threshold N]
      //   windowHours: only count outcomes from the last N hours (default: all). `0`/omit = all.
      const windowHours = args[0] && /^\d+(\.\d+)?$/.test(args[0]) ? parseFloat(args[0]) : 0;
      const asJson = args.includes('--json');
      const showPromote = args.includes('--promote');
      const thIdx = args.indexOf('--threshold');
      const threshold = thIdx >= 0 && /^\d+$/.test(args[thIdx + 1] ?? '') ? parseInt(args[thIdx + 1], 10) : 3;
      const windowMs = windowHours > 0 ? windowHours * 60 * 60 * 1000 : undefined;
      const summary = runner.getRecentOutcomeSummary(windowMs);
      const candidates = showPromote
        ? promotionCandidates(runner.getRecentOutcomeRecords(windowMs), { threshold })
        : [];
      if (asJson) {
        const payload: Record<string, unknown> = { windowHours: windowHours || null, ...summary };
        if (showPromote) payload.promotionCandidates = { threshold, candidates };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
      } else {
        const scope = windowHours > 0 ? `last ${windowHours}h` : 'all-time';
        process.stdout.write(`[OUTCOMES ${scope}] ${formatOutcomeSummary(summary)}\n`);
        if (showPromote) {
          if (candidates.length === 0) {
            process.stdout.write(`[PROMOTE ${scope}] 昇格候補なし（同種 failure が ${threshold} 回未満）\n`);
          } else {
            process.stdout.write(`[PROMOTE ${scope}] 昇格候補（同種 failure ≥ ${threshold} 回）— docs/ai/failure-log.md に記録し恒久化を判断:\n`);
            for (const c of candidates) {
              const issues = c.issues.length > 0 ? ` issues=${c.issues.join(',')}` : '';
              process.stdout.write(`  - kind(code)=${c.kind} count=${c.count}${issues}\n`);
            }
          }
        }
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
    case 'delegation-preflight': {
      // SOT-1574: print a ONE-block delegation/cost preflight before run_auto.sh's role loop — which
      // worker handles each role (summarizing WORKER_ROLES_FILE / the per-issue override) plus a
      // QUALITATIVE usage estimate (cooldown/auth state, Claude-primary role count, loop bound). No
      // dollar figures (real spend is not obtainable). Fail-open: on any error print nothing, exit 0,
      // so the pipeline is never blocked. Usage: runner-cli.js delegation-preflight [issueId]
      const issueId = args[0] || undefined;
      const defaultConfigPath = path.join(__dirname, '..', 'config', 'worker_roles.json');
      // The pipeline's actual role sequence (task-check folds in decomposition; see run_auto.sh).
      const pipelineRoles: WorkerRole[] = [
        'task-check', 'implementation', 'verification', 'acceptance', 'github', 'linear-report',
      ];
      try {
        // Resolved config = per-issue override file if pointed at, else the default config.
        const overrideFile = process.env.WORKER_ROLES_FILE;
        const resolvedPath = overrideFile && fs.existsSync(overrideFile) ? overrideFile : defaultConfigPath;
        const config = loadWorkerRolesConfig(resolvedPath);
        // Base config for override detection (best-effort — null if unreadable).
        let baseConfig: WorkerRoleConfig | null = null;
        try { baseConfig = loadWorkerRolesConfig(defaultConfigPath); } catch { baseConfig = null; }
        // Per-role model pins live under the resolved file's `__models__` section (SOT-1583).
        let models: Record<string, Record<string, string>> | null = null;
        try {
          const rawResolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
          if (rawResolved && typeof rawResolved.__models__ === 'object') models = rawResolved.__models__;
        } catch { models = null; }

        const cooldowns = getWorkerCooldownStatus().workers.map((w) => ({
          worker: w.worker, active: w.active, remainingHuman: w.remainingHuman,
        }));
        const authUnhealthy = {
          antigravity: readAuthUnhealthy('antigravity', runner.LOG_DIR),
          codex: readAuthUnhealthy('codex', runner.LOG_DIR),
        };
        const maxDebugCyclesRaw = Number(process.env.PIPELINE_MAX_DEBUG_CYCLES);
        const maxDebugCycles = Number.isFinite(maxDebugCyclesRaw) ? maxDebugCyclesRaw : 2;

        const block = buildDelegationPreflight({
          issue: issueId,
          roles: pipelineRoles,
          config,
          baseConfig,
          models: models as any,
          cooldowns,
          authUnhealthy,
          maxDebugCycles,
        });
        process.stdout.write(block + '\n');
        process.exit(0);
      } catch (err: any) {
        // Fail-open: never block the pipeline on a preflight-summary error.
        process.stderr.write(`delegation-preflight: ${err?.message || err}\n`);
        process.exit(0);
      }
      break;
    }
    case 'pipeline-graph': {
      // SOT-1754: declarative pipeline graph engine (src/lib/pipelineGraph.ts). run_auto.sh drives
      // the opt-in PIPELINE_GRAPH=1 role loop through this subcommand:
      //   pipeline-graph validate [--graph <path>]
      //     → exit 0 + `PIPELINE_GRAPH_OK …` when the graph loads and validates, else errors on
      //       stderr + exit 1 (run_auto.sh fail-opens to the serial loop on non-zero).
      //   pipeline-graph begin --state <file> [--graph <path>]
      //     → initialize run state at the entry node; prints `NODE=<id> ROLE=<role>`.
      //   pipeline-graph next --state <file> --next-action <TOKEN|NONE> [--acceptance PASS|FAIL|NONE]
      //     → resolve one transition from the persisted state; prints `NODE=<id> ROLE=<role>
      //       DEBUG_SPENT=<n> EVENT=<event>` or `TERMINAL=<done|done_no_pr|stop> REASON=<…>`.
      // The state file keeps the engine stateless per invocation (bash loop ↔ CLI round-trips).
      const sub = args[0];
      const flags: Record<string, string> = {};
      for (let i = 1; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const graphPath = flags.graph || process.env.PIPELINE_GRAPH_FILE || DEFAULT_GRAPH_PATH;
      const { graph, errors } = loadPipelineGraph(graphPath);
      if (!graph) {
        process.stderr.write(`pipeline-graph: invalid graph ${graphPath}:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
        process.exit(1);
      }
      if (sub === 'validate') {
        process.stdout.write(`PIPELINE_GRAPH_OK entry=${graph.entry} nodes=${Object.keys(graph.nodes).length} graph=${graphPath}\n`);
        process.exit(0);
      }
      const stateFile = flags.state;
      if ((sub !== 'begin' && sub !== 'next') || !stateFile) {
        process.stderr.write('Usage: runner-cli.js pipeline-graph validate|begin|next [--graph <path>] --state <file> [--next-action <TOKEN|NONE>] [--acceptance PASS|FAIL|NONE]\n');
        process.exit(1);
      }
      if (sub === 'begin') {
        const state = beginPipelineGraph(graph);
        writePipelineGraphState(stateFile, state);
        process.stdout.write(`NODE=${state.current} ROLE=${graph.nodes[state.current].role}\n`);
        process.exit(0);
      }
      // sub === 'next'
      const state = readPipelineGraphState(stateFile);
      const nextAction = flags['next-action'] === 'NONE' ? '' : flags['next-action'];
      const acceptance = flags.acceptance === 'NONE' ? '' : flags.acceptance;
      const res = stepPipelineGraph(graph, state, nextAction, acceptance);
      writePipelineGraphState(stateFile, state);
      if (res.warning) process.stderr.write(`pipeline-graph: WARN ${res.warning}\n`);
      if (res.kind === 'terminal') {
        process.stdout.write(`TERMINAL=${res.terminal} EVENT=${res.event} REASON=${res.reason}\n`);
      } else {
        process.stdout.write(`NODE=${res.node} ROLE=${res.role} DEBUG_SPENT=${state.budgets.debug ?? 0} EVENT=${res.event}\n`);
      }
      process.exit(0);
      break;
    }
    case 'kaggle-plan': {
      // SOT-1904: decide which agent to auto-submit next, from the priority registry + the previous
      // Kaggle results. Pure logic in src/lib/kaggleSubmission.ts; scripts/ai/kaggle_auto_submit.sh
      // fetches the live submissions, records them, then calls this to get the pick. Usage:
      //   runner-cli.js kaggle-plan [--registry <path>] [--recent <csv agents, most-recent-first>]
      //                             [--today-count <n>]
      // Prints the SubmissionPlan as JSON on stdout (exit 0). Fail-loud (exit 1) on a bad registry.
      const flags: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const registryPath = flags.registry
        || path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_submission_registry.json');
      let registry;
      try {
        registry = parseRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      } catch (err: any) {
        process.stderr.write(`kaggle-plan: invalid registry ${registryPath}: ${err?.message || err}\n`);
        process.exit(1);
      }
      const recent: RecentSubmission[] = (flags.recent || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((agent) => ({ agent }));
      const todayCount = Number.isFinite(Number(flags['today-count'])) ? Number(flags['today-count']) : 0;
      const plan = planSubmission({ registry, recent, submittedToday: todayCount });
      process.stdout.write(JSON.stringify(plan) + '\n');
      process.exit(0);
      break;
    }
    case 'kaggle-improve-plan': {
      // SOT-1913/SOT-1932: decide which improvement issues to draft this cron slot, deterministically.
      // Pure logic in src/lib/kaggleImprovement.ts; scripts/ai/kaggle_improvement_cycle.sh (SOT-1933)
      // collects the material/guard signals, calls this to get the plan, then creates the issues.
      // Usage:
      //   runner-cli.js kaggle-improve-plan [--registry <path>] [--hour <0-23>]
      //       [--issue-count <n>] [--cooldown 1|0] [--env-enabled 1|0]
      //       [--signals <json>] [--material <json>]
      // Prints the CyclePlan as JSON on stdout (exit 0). Fail-loud (exit 1) on a bad registry/JSON.
      // Dry-run by design: this never creates issues — it only computes the plan.
      const flags: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const registryPath = flags.registry
        || path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      let registry;
      try {
        registry = parseTargetsRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      } catch (err: any) {
        process.stderr.write(`kaggle-improve-plan: invalid registry ${registryPath}: ${err?.message || err}\n`);
        process.exit(1);
      }
      const parseJsonFlag = <T>(name: string): T | undefined => {
        if (!flags[name]) return undefined;
        try {
          return JSON.parse(flags[name]) as T;
        } catch (err: any) {
          process.stderr.write(`kaggle-improve-plan: invalid --${name} JSON: ${err?.message || err}\n`);
          process.exit(1);
        }
      };
      const hourJst = Number.isFinite(Number(flags.hour)) ? Number(flags.hour) : new Date().getHours();
      const issueCount = Number.isFinite(Number(flags['issue-count'])) ? Number(flags['issue-count']) : 0;
      const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';
      const plan = planImprovementCycle({
        registry,
        hourJst,
        // env kill switch: explicit --env-enabled wins, else fall back to KAGGLE_IMPROVE_ENABLED.
        envEnabled: flags['env-enabled'] !== undefined
          ? truthy(flags['env-enabled'])
          : truthy(process.env.KAGGLE_IMPROVE_ENABLED),
        issueCount,
        cooldownActive: truthy(flags.cooldown),
        signals: parseJsonFlag<Record<string, GuardSignals>>('signals'),
        material: parseJsonFlag<Record<string, ImprovementMaterial>>('material'),
      });
      process.stdout.write(JSON.stringify(plan) + '\n');
      process.exit(0);
      break;
    }
    default: {
      process.stderr.write(`Unknown command: ${command}\nAvailable: classify-issue, set-issue-in-progress, resolve-worker-roles, resolve-pipeline-graph, pipeline-graph, kaggle-plan, kaggle-improve-plan, ...\n`);
      process.exit(1);
    }
  }
}

main().catch(err => {
  process.stderr.write(`runner-cli error: ${err.message}\n`);
  process.exit(1);
});
