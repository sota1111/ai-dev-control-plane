'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
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
import {
  classifyWorkerFailure,
  writeAuthUnhealthy,
  readAuthUnhealthy,
  shouldSkipForAuthUnhealthy,
  type WorkerName,
} from './lib/workerHealth.js';
import { workerAuthUnhealthyTtlSeconds } from './config/env.js';
import {
  loadWorkerRolesConfig,
  loadSoloWorker,
  type WorkerRoleConfig,
  type WorkerRole,
} from './lib/workerRoles.js';
import {
  parseWorkerRoleDirectives,
  parseReasoningDirectives,
  mergeWorkerRoleOverrides,
  parseGraphDirective,
  parseControlDirectives,
} from './lib/workerRoleDirective.js';
import { buildDelegationPreflight } from './lib/delegationPreflight.js';
import { parseRegistry, planSubmission, type RecentSubmission } from './lib/kaggleSubmission.js';
import { createDraftIssue, findOpenImproveCycleParent, postIssueComment } from './lib/linearApi.js';
import {
  parseTargetsRegistry,
  planImprovementCycle,
  planCompetitionSubmission,
  resolveCompetitionForHour,
  resolvePinnedSlotForHour,
  type GuardSignals,
  type ImprovementMaterial,
} from './lib/kaggleImprovement.js';
import { collectImproveContext, collectAllocationSignals } from './lib/kaggleImproveMaterial.js';
import { computeKernelFingerprint } from './lib/kaggleKernelFingerprint.js';
import { parseKaggleSubmissionsCsv } from './lib/kaggleImproveMaterial.js';
import { selectDynamicCompetition, shouldAutoMaintain } from './lib/resourceAllocation.js';
import {
  appendNewScoreProgression,
  progressionEntriesFromRows,
} from './lib/kaggleScoreProgression.js';
import { pipelineReviewComment, type PipelineReviewOutcome } from './lib/pipelineReviewComment.js';
import {
  DEFAULT_GRAPH_PATH,
  loadPipelineGraph,
  beginPipelineGraph,
  stepPipelineGraph,
  readPipelineGraphState,
  writePipelineGraphState,
  openPipelineGraphCheckpoint,
  pipelineGraphId,
  explainPipelineGraph,
} from './lib/pipelineGraph.js';
import { explainExecutionPlan, isTruthyFlag, resolveExecutionPlan } from './lib/executionPlan.js';

const [, , command, ...args] = process.argv;

/**
 * SOT-1913 材料自動収集の共通ラッパ。当番枠が active で、かつ signals/material の少なくとも一方が
 * 明示指定されていないときだけ、当番コンペの材料/シグナルを収集する（best-effort・never throws）。
 * 非 active / 枠外 / --no-collect / 両方明示済み のときは null（収集スキップ）。
 */
async function maybeCollectImproveContext(o: {
  registry: import('./lib/kaggleImprovement.js').TargetsRegistry;
  hourJst: number;
  active: boolean;
  label?: string;
  noCollect: boolean;
  haveSignals: boolean;
  haveMaterial: boolean;
  kaggle: boolean;
  /** 動的配分が選んだコンペ。指定時は hour→rotation 解決より優先（design §50）。 */
  competitionKeyOverride?: string;
}): Promise<{
  signals: Record<string, GuardSignals>;
  material: Record<string, ImprovementMaterial>;
} | null> {
  if (o.noCollect || !o.active || (o.haveSignals && o.haveMaterial)) return null;
  const competitionKey = o.competitionKeyOverride ?? resolveCompetitionForHour(o.registry, o.hourJst);
  if (!competitionKey) return null;
  try {
    return await collectImproveContext(o.registry, competitionKey, {
      label: o.label || 'auto-improve',
      kaggle: o.kaggle,
      log: (m) => process.stderr.write(`[improve-collect] ${m}\n`),
    });
  } catch (err: any) {
    process.stderr.write(
      `kaggle-improve: material collection failed (best-effort): ${err?.message || err}\n`
    );
    return null;
  }
}

async function main() {
  switch (command) {
    case 'kaggle-score-sync': {
      // SOT-2187: completed public scores are reconciled into append-only progression JSONL.
      // CSV is read from stdin so credentials/output never need to be placed in argv.
      const flags: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const registryPath =
        flags.registry ||
        path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      const progressionPath =
        flags.output ||
        path.join(__dirname, '..', 'docs', 'ai', 'kaggle', 'score-progression.jsonl');
      try {
        const registry = parseTargetsRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
        const competition = registry.competitions.find((c) => c.key === flags.competition);
        if (!competition) throw new Error(`competition "${flags.competition || ''}" not found`);
        const csv = fs.readFileSync(0, 'utf8');
        const entries = progressionEntriesFromRows(competition, parseKaggleSubmissionsCsv(csv));
        const appended = appendNewScoreProgression(progressionPath, entries);
        process.stdout.write(
          JSON.stringify({ appended, discovered: entries.length, file: progressionPath }) + '\n'
        );
        process.exit(0);
      } catch (err: any) {
        process.stderr.write(`kaggle-score-sync: ${err?.message || err}\n`);
        process.exit(1);
      }
      break;
    }
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
        status: data.issue.state.name,
      };

      const result = classifyIssue(issueData);

      runner.log('CLASSIFY', `${issueId} → type=${result.type} worker=${result.worker}`, {
        issue: issueId,
        reason: result.reason,
      });
      process.stdout.write(JSON.stringify(result) + '\n');
      process.exit(0);
      break;
    }
    case 'solo-worker': {
      // SOT-1591 (solo mode): print the single worker that runs the whole lifecycle when
      // `__solo__` is set in the worker-roles config, else empty. run_auto.sh queries this to decide
      // between one solo dispatch and the per-role pipeline. Reads WORKER_ROLES_FILE (per-issue merged
      // config) when set, else the base config. Fail-open: any error → empty (normal pipeline).
      const configPath =
        args[0] ||
        process.env.WORKER_ROLES_FILE ||
        path.join(__dirname, '..', 'config', 'worker_roles.json');
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
        process.stderr.write(
          'Usage: runner-cli.js resolve-worker-roles <issueIdentifier> [baseConfigPath]\n'
        );
        process.exit(1);
      }
      const baseConfigPath = args[1] || path.join(__dirname, '..', 'config', 'worker_roles.json');

      let text = '';
      try {
        const data: any = await runner.linearQuery(
          'query($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body } } } }',
          { id: issueId }
        );
        const description: string =
          typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments: string[] = (data?.issue?.comments?.nodes || []).map((n: any) =>
          typeof n?.body === 'string' ? n.body : ''
        );
        // Description first, then comments oldest→newest so the newest directive wins.
        text = [description, ...comments].join('\n');
      } catch (err: any) {
        process.stderr.write(
          `resolve-worker-roles: could not fetch issue ${issueId}: ${err?.message || err}\n`
        );
        process.stdout.write('');
        process.exit(0);
      }

      const { overrides, models, solo, handoff, warnings } = parseWorkerRoleDirectives(text);
      const parsedReasoning = parseReasoningDirectives(text);
      const reasoning = parsedReasoning.reasoning;
      warnings.push(...parsedReasoning.warnings);
      for (const w of warnings) process.stderr.write(`resolve-worker-roles: ${w}\n`);
      const overriddenRoles = Object.keys(overrides);
      const modelledRoles = Object.keys(models);
      // A solo or handoff directive alone must also produce a per-issue file.
      if (
        overriddenRoles.length === 0 &&
        modelledRoles.length === 0 &&
        Object.keys(reasoning).length === 0 &&
        !solo &&
        handoff === undefined
      ) {
        process.stdout.write('');
        process.exit(0);
      }

      let base: WorkerRoleConfig;
      try {
        base = loadWorkerRolesConfig(baseConfigPath);
      } catch (err: any) {
        process.stderr.write(
          `resolve-worker-roles: base config invalid (${baseConfigPath}): ${err?.message || err}\n`
        );
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
      for (const [r, m] of Object.entries(models))
        modelsOut[r] = { ...(m as Record<string, string>) };
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
      if (Object.keys(reasoning).length > 0) output.__reasoning__ = reasoning;
      const outDir = path.join(__dirname, '..', 'docs', 'ai', 'pipeline');
      fs.mkdirSync(outDir, { recursive: true });
      const safeIssue = String(issueId).replace(/[^a-zA-Z0-9_-]/g, '_');
      const outPath = path.join(outDir, `worker_roles.${safeIssue}.json`);
      fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

      const overrideSummary = overriddenRoles
        .map((r) => `${r}=[${(overrides as any)[r].join('>')}]`)
        .join(', ');
      const modelSummary = modelledRoles
        .map(
          (r) =>
            `${r}{${Object.entries((models as any)[r])
              .map(([w, m]) => `${w}:${m}`)
              .join(',')}}`
        )
        .join(', ');
      const handoffSummary = handoff === undefined ? '' : `handoff=${handoff ? 'on' : 'off'}`;
      const reasoningSummary = Object.entries(reasoning).map(([r, v]) => `${r}=${v}`).join(',');
      const summary = [overrideSummary, modelSummary, reasoningSummary && `reasoning{${reasoningSummary}}`, soloSummary, handoffSummary]
        .filter(Boolean)
        .join(' | ');
      process.stderr.write(`resolve-worker-roles: ${issueId} overrides ${summary} → ${outPath}\n`);
      runner.log('WORKER_ROLES', `${issueId} per-issue override: ${summary}`, { issue: issueId });
      process.stdout.write(outPath);
      process.exit(0);
      break;
    }
    case 'kaggle-submit-hold-check': {
      // SOT-2516: evaluate the lightweight `submit=hold` / `cycle=` control directives on an issue's
      // description + comments and print the decision as JSON `{hold, cycle, reason}`. The Kaggle submit
      // path (scripts/ai/kaggle_targets_submit.sh) calls this before an --execute submission: when hold
      // is true it skips the submission (no blocking human gate — automaticity is preserved) and, with
      // `--record`, this command posts the reason comment on the parent so the human intervention is
      // logged. Fail-OPEN: any fetch/parse error → hold=false so a transient Linear hiccup never blocks
      // an otherwise-valid automated submission.
      const flags = args.filter((a) => a.startsWith('--'));
      const positional = args.filter((a) => !a.startsWith('--'));
      const getFlag = (name: string): string | undefined => {
        const eq = flags.find((f) => f.startsWith(`${name}=`));
        if (eq) return eq.slice(name.length + 1);
        const idx = args.indexOf(name);
        return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : undefined;
      };
      const issueId = getFlag('--issue') || positional[0];
      const competition = getFlag('--competition') || '';
      const record = flags.includes('--record');
      const emit = (hold: boolean, cycle: string | null, reason: string) => {
        process.stdout.write(JSON.stringify({ hold, cycle, reason }));
        process.exit(0);
      };
      if (!issueId) {
        process.stderr.write(
          'Usage: runner-cli.js kaggle-submit-hold-check --issue <id> [--competition <key>] [--record]\n'
        );
        emit(false, null, 'no issue id');
        break;
      }
      let blocks: string[] = [];
      try {
        const data: any = await runner.linearQuery(
          'query($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body } } } }',
          { id: issueId }
        );
        const description: string =
          typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments: string[] = (data?.issue?.comments?.nodes || []).map((n: any) =>
          typeof n?.body === 'string' ? n.body : ''
        );
        // Description first, then comments oldest→newest so the newest directive wins.
        blocks = [description, ...comments];
      } catch (err: any) {
        process.stderr.write(
          `kaggle-submit-hold-check: could not fetch issue ${issueId}: ${err?.message || err}\n`
        );
        // Fail-open: proceed with the submission rather than stranding it on a transient fetch error.
        emit(false, null, `fetch error (fail-open): ${err?.message || err}`);
        break;
      }
      const control = parseControlDirectives(blocks);
      for (const w of control.warnings) process.stderr.write(`kaggle-submit-hold-check: ${w}\n`);
      const cycle = control.cycle ?? null;
      if (control.submitHold === true) {
        const reason = `submit=hold directive on ${issueId}${competition ? ` (${competition})` : ''}`;
        if (record) {
          const body = `## 提出保留 (submit=hold)\n最新の人間 directive \`submit=hold\` を検出したため、この自動提出をスキップしました${competition ? `（コンペ: ${competition}）` : ''}。\n提出を再開するには、独立した短いコメントの先頭行に \`submit=auto\` を記載してください（承認待ちでブロックはしません）。`;
          await postIssueComment(issueId, body);
        }
        emit(true, cycle, reason);
        break;
      }
      emit(false, cycle, control.submitHold === false ? 'submit=auto directive' : 'no submit=hold directive');
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
          { id: issueId }
        );
        const description =
          typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments = (data?.issue?.comments?.nodes || []).map((n: any) =>
          typeof n?.body === 'string' ? n.body : ''
        );
        text = [description, ...comments].join('\n');
      } catch (err: any) {
        process.stderr.write(
          `resolve-pipeline-graph: could not fetch ${issueId}: ${err?.message || err}; using default\n`
        );
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
        process.stderr.write(
          `resolve-pipeline-graph: unknown/invalid graph "${name}"; using default\n`
        );
        process.stdout.write(DEFAULT_GRAPH_PATH);
      } else {
        process.stderr.write(`resolve-pipeline-graph: ${issueId} selected graph=${name}\n`);
        process.stdout.write(graphPath);
      }
      process.exit(0);
      break;
    }
    case 'execution-plan': {
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js execution-plan <issueIdentifier> [--explain]\n');
        process.exit(1);
      }
      let text = '';
      const warnings: string[] = [];
      try {
        const data: any = await runner.linearQuery(
          'query($id: String!) { issue(id: $id) { description comments(first: 50) { nodes { body } } } }',
          { id: issueId }
        );
        const description =
          typeof data?.issue?.description === 'string' ? data.issue.description : '';
        const comments = (data?.issue?.comments?.nodes || []).map((n: any) =>
          typeof n?.body === 'string' ? n.body : ''
        );
        text = [description, ...comments].join('\n');
      } catch (err: any) {
        warnings.push(`could not fetch ${issueId}: ${err?.message || err}`);
      }

      const graphDirective = parseGraphDirective(text);
      let namedGraphPath: string | undefined;
      let namedGraphError: string | undefined;
      if (graphDirective && graphDirective !== 'default') {
        const candidate = path.join(__dirname, '..', 'config', 'graphs', `${graphDirective}.json`);
        const loaded = loadPipelineGraph(candidate);
        if (loaded.graph) namedGraphPath = candidate;
        else
          namedGraphError = `unknown or invalid graph "${graphDirective}": ${loaded.errors.join('; ')}`;
      }
      const workerConfigPath =
        process.env.WORKER_ROLES_FILE || path.join(__dirname, '..', 'config', 'worker_roles.json');
      const plan = resolveExecutionPlan({
        graphDirective,
        namedGraphPath,
        namedGraphError,
        pipelineGraphEnabled: isTruthyFlag(process.env.PIPELINE_GRAPH),
        configuredGraphPath: process.env.PIPELINE_GRAPH_FILE,
        defaultGraphPath: DEFAULT_GRAPH_PATH,
        soloWorker: loadSoloWorker(workerConfigPath),
      });
      plan.warnings.unshift(...warnings);
      // Discussion consumes the issue material as a topic file. Keep this I/O in the CLI
      // orchestration layer, after the pure mode decision, so selection itself stays side-effect free.
      if (plan.mode === 'graph' && graphDirective && text) {
        const topicDir = path.join(__dirname, '..', 'docs', 'ai', 'pipeline');
        const safeIssue = String(issueId).replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.mkdirSync(topicDir, { recursive: true });
        fs.writeFileSync(path.join(topicDir, `discussion_topic.${safeIssue}.md`), text);
      }
      if (args.includes('--explain')) process.stdout.write(explainExecutionPlan(plan));
      else process.stdout.write(`${JSON.stringify(plan)}\n`);
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
      runner.log(
        'WORKER_ROLES',
        `set-issue-in-progress ${issueId}: requested (idempotent/fail-open)`,
        { issue: issueId }
      );
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
        process.stderr.write(
          'Usage: runner-cli.js ensure-issue-reviewed <issueIdentifier> [completed|completed-no-pr|incomplete]\n'
        );
        process.exit(1);
      }
      const outcome: PipelineReviewOutcome =
        args[1] === 'completed' || args[1] === 'completed-no-pr' ? args[1] : 'incomplete';
      if (outcome === 'incomplete') {
        await runner.setIssueInProgress(issueId, { preserveBlocked: true }).catch(() => {});
        runner.log('WORKER_ROLES', `ensure-issue-reviewed ${issueId}: incomplete run state preserved`, {
          issue: issueId,
        });
        process.stdout.write('active');
        process.exit(0);
        break;
      }
      const comment = pipelineReviewComment(outcome);
      const moved = await runner.setIssueInReview(issueId, comment).catch(() => false);
      runner.log(
        'WORKER_ROLES',
        `ensure-issue-reviewed ${issueId}: ${moved ? 'moved to In Review' : 'no change (already reviewed/terminal)'}`,
        { issue: issueId }
      );
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
      runner.log(
        'WORKER_ROLES',
        `move-on-hold ${issueId}: ${moved ? 'moved to On Hold' : 'no change (already on hold/terminal/missing)'}`,
        { issue: issueId }
      );
      process.stdout.write(moved ? 'moved' : 'nochange');
      process.exit(0);
      break;
    }
    case 'set-issue-blocked': {
      const issueId = args[0];
      if (!issueId) {
        process.stderr.write('Usage: runner-cli.js set-issue-blocked <issueIdentifier> [reason]\n');
        process.exit(1);
      }
      const reason = args.slice(1).join(' ').trim();
      const comment = `## 自動実行停止 — worker safety policy refusal\n\n同じ内容の自動再試行を停止し、このIssueを **Blocked** に移行しました。${reason ? `\n\n**理由:** ${reason}` : ''}\n\n作業範囲と利用環境の認可を確認後、TodoまたはIn Progressへ戻すと再開できます。`;
      const moved = await runner.setIssueBlocked(issueId, comment).catch(() => false);
      runner.log(
        'WORKER_ROLES',
        `set-issue-blocked ${issueId}: ${moved ? 'moved to Blocked' : 'no change (already blocked/terminal/missing)'}`,
        { issue: issueId }
      );
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
        queue,
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
      const worker = args[0] as 'antigravity' | 'codex' | 'runner';
      if (!['antigravity', 'codex', 'runner'].includes(worker)) {
        process.stderr.write(
          'Usage: runner-cli.js notify-usage-limit-unknown <antigravity|codex|runner>\n'
        );
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
        process.stderr.write(
          'Usage: runner-cli.js notify-worker-report <antigravity|codex> [reportPath]\n'
        );
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
        process.stderr.write(
          'Usage: runner-cli.js notify-discord <message>   (or pipe the message on stdin)\n'
        );
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
      const threshold =
        thIdx >= 0 && /^\d+$/.test(args[thIdx + 1] ?? '') ? parseInt(args[thIdx + 1], 10) : 3;
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
            process.stdout.write(
              `[PROMOTE ${scope}] 昇格候補なし（同種 failure が ${threshold} 回未満）\n`
            );
          } else {
            process.stdout.write(
              `[PROMOTE ${scope}] 昇格候補（同種 failure ≥ ${threshold} 回）— docs/ai/failure-log.md に記録し恒久化を判断:\n`
            );
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
        process.stderr.write(
          'Usage: runner-cli.js worker-health-record <antigravity|codex> <exitCode>\n'
        );
        process.exit(1);
      }
      let report = '';
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
        report = Buffer.concat(chunks).toString('utf8');
      } catch {
        /* stdin optional */
      }
      const kind = classifyWorkerFailure(report, exitCode);
      if (kind === 'auth_failure') {
        const expiresAt = writeAuthUnhealthy(
          worker,
          runner.LOG_DIR,
          workerAuthUnhealthyTtlSeconds()
        );
        // Separated alert: CHRONIC (human must re-authenticate) — distinct from a transient cooldown.
        runner.log(
          'WORKER_HEALTH',
          `${worker} CHRONIC auth failure — re-authentication required; marked auth-unhealthy until epoch ${expiresAt}`
        );
        process.stderr.write(
          `WORKER_AUTH_UNHEALTHY: ${worker} chronic auth failure — human re-auth required (marker until ${expiresAt})\n`
        );
        const issueId = process.env.WEBHOOK_ISSUE_ID;
        if (issueId) {
          const body = `## 自動処理停止: 認証切れ

${worker} の認証が無効なため、この Issue を **Blocked** に移行しました。再認証後に Todo または In Progress へ戻すと自動処理を再開できます。`;
          await runner.setIssueBlocked(issueId, body).catch(() => false);
        }
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
        process.stdout.write(
          `active remaining=${status.remainingSeconds ?? 0}s expiresAtEpoch=${status.expiresAtEpoch ?? 0}\n`
        );
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
        'task-check',
        'implementation',
        'verification',
        'acceptance',
        'github',
        'linear-report',
      ];
      try {
        // Resolved config = per-issue override file if pointed at, else the default config.
        const overrideFile = process.env.WORKER_ROLES_FILE;
        const resolvedPath =
          overrideFile && fs.existsSync(overrideFile) ? overrideFile : defaultConfigPath;
        const config = loadWorkerRolesConfig(resolvedPath);
        // Base config for override detection (best-effort — null if unreadable).
        let baseConfig: WorkerRoleConfig | null = null;
        try {
          baseConfig = loadWorkerRolesConfig(defaultConfigPath);
        } catch {
          baseConfig = null;
        }
        // Per-role model pins live under the resolved file's `__models__` section (SOT-1583).
        let models: Record<string, Record<string, string>> | null = null;
        try {
          const rawResolved = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
          if (rawResolved && typeof rawResolved.__models__ === 'object')
            models = rawResolved.__models__;
        } catch {
          models = null;
        }

        const cooldowns = getWorkerCooldownStatus().workers.map((w) => ({
          worker: w.worker,
          active: w.active,
          remainingHuman: w.remainingHuman,
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
      // the unified role loop through this subcommand:
      //   pipeline-graph validate|explain [--graph <path>]
      //     → exit 0 + `PIPELINE_GRAPH_OK …` when the graph loads and validates, else errors on
      //       stderr + exit 1.
      //   pipeline-graph open --state <file> --run-id <id> --issue-id <id> [--resume]
      //     → create or resume an identity-checked checkpoint; prints structured JSON.
      //   pipeline-graph advance --state <file> --next-action <TOKEN|NONE> [--acceptance PASS|FAIL|NONE]
      //     → resolve one transition and prints a structured JSON result.
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
        process.stderr.write(
          `pipeline-graph: invalid graph ${graphPath}:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`
        );
        process.exit(1);
      }
      if (sub === 'validate') {
        process.stdout.write(
          `PIPELINE_GRAPH_OK entry=${graph.entry} nodes=${Object.keys(graph.nodes).length} graph=${graphPath}\n`
        );
        process.exit(0);
      }
      if (sub === 'explain') {
        process.stdout.write(`${explainPipelineGraph(graph)}\n`);
        process.exit(0);
      }
      const stateFile = flags.state;
      if ((sub !== 'open' && sub !== 'advance') || !stateFile) {
        process.stderr.write(
          'Usage: runner-cli.js pipeline-graph validate|explain|open|advance [--graph <path>] --state <file> [--run-id <id>] [--issue-id <id>] [--resume true] [--next-action <TOKEN|NONE>] [--acceptance PASS|FAIL|NONE]\n'
        );
        process.exit(1);
      }
      if (sub === 'open') {
        const runId = flags['run-id'];
        const issueId = flags['issue-id'];
        if (!runId || !issueId) {
          process.stderr.write('pipeline-graph open requires --run-id and --issue-id\n');
          process.exit(1);
        }
        const opened = openPipelineGraphCheckpoint(
          stateFile,
          graph,
          { runId, issueId, graphId: pipelineGraphId(graph) },
          flags.resume === 'true'
        );
        process.stdout.write(
          `${JSON.stringify({
            kind: 'node',
            node: opened.state.current,
            role: graph.nodes[opened.state.current].role,
            resumed: opened.resumed,
            debugSpent: opened.state.budgets.debug ?? 0,
          })}\n`
        );
        process.exit(0);
      }
      // sub === 'advance'
      const state = readPipelineGraphState(stateFile, {
        runId: flags['run-id'] || '',
        issueId: flags['issue-id'] || '',
        graphId: pipelineGraphId(graph),
      });
      const nextAction = flags['next-action'] === 'NONE' ? '' : flags['next-action'];
      const acceptance = flags.acceptance === 'NONE' ? '' : flags.acceptance;
      const res = stepPipelineGraph(graph, state, nextAction, acceptance);
      writePipelineGraphState(stateFile, state);
      if (res.warning) process.stderr.write(`pipeline-graph: WARN ${res.warning}\n`);
      if (res.kind === 'terminal') {
        process.stdout.write(
          `${JSON.stringify({ ...res, debugSpent: state.budgets.debug ?? 0 })}\n`
        );
      } else {
        process.stdout.write(
          `${JSON.stringify({ ...res, debugSpent: state.budgets.debug ?? 0 })}\n`
        );
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
      const registryPath =
        flags.registry ||
        path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_submission_registry.json');
      let registry;
      try {
        registry = parseRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      } catch (err: any) {
        process.stderr.write(
          `kaggle-plan: invalid registry ${registryPath}: ${err?.message || err}\n`
        );
        process.exit(1);
      }
      const recent: RecentSubmission[] = (flags.recent || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((agent) => ({ agent }));
      const todayCount = Number.isFinite(Number(flags['today-count']))
        ? Number(flags['today-count'])
        : 0;
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
      //       [--env-enabled 1|0] [--signals <json>] [--material <json>]
      // (--issue-count / --cooldown are accepted but ignored: order-first "draft by default" policy.)
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
      const registryPath =
        flags.registry ||
        path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      let registry;
      try {
        registry = parseTargetsRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      } catch (err: any) {
        process.stderr.write(
          `kaggle-improve-plan: invalid registry ${registryPath}: ${err?.message || err}\n`
        );
        process.exit(1);
      }
      const parseJsonFlag = <T>(name: string): T | undefined => {
        if (!flags[name]) return undefined;
        try {
          return JSON.parse(flags[name]) as T;
        } catch (err: any) {
          process.stderr.write(
            `kaggle-improve-plan: invalid --${name} JSON: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      };
      const hourJst = Number.isFinite(Number(flags.hour))
        ? Number(flags.hour)
        : new Date().getHours();
      const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';
      // env kill switch: explicit --env-enabled wins, else fall back to KAGGLE_IMPROVE_ENABLED.
      const envEnabled =
        flags['env-enabled'] !== undefined
          ? truthy(flags['env-enabled'])
          : truthy(process.env.KAGGLE_IMPROVE_ENABLED);
      let signals = parseJsonFlag<Record<string, GuardSignals>>('signals');
      let material = parseJsonFlag<Record<string, ImprovementMaterial>>('material');
      // 材料/シグナルは cron が自動収集する（未指定かつ active な当番枠のみ・best-effort）。
      const collected = await maybeCollectImproveContext({
        registry,
        hourJst,
        active: registry.enabled && envEnabled,
        label: flags.label,
        noCollect: flags['no-collect'] === '1' || truthy(process.env.KAGGLE_IMPROVE_NO_COLLECT),
        haveSignals: signals !== undefined,
        haveMaterial: material !== undefined,
        kaggle: flags['no-kaggle'] !== '1',
      });
      if (collected) {
        if (signals === undefined) signals = collected.signals;
        if (material === undefined) material = collected.material;
      }
      const plan = planImprovementCycle({
        registry,
        hourJst,
        envEnabled,
        signals,
        material,
      });
      process.stdout.write(JSON.stringify(plan) + '\n');
      process.exit(0);
      break;
    }
    case 'kaggle-improve-run': {
      // SOT-1913/SOT-1933: the cron's execute path. Computes the same CyclePlan as kaggle-improve-plan,
      // then (only with --execute && active) creates the drafted "improvement parent" issues in Linear
      // — in Todo (NOT In Review) so the pipeline's dependency-order queue can auto-implement them —
      // re-checking the unfinished-cycle guard live, and bumps each drafted target's next_cycle in the
      // registry file. Without --execute it is identical to kaggle-improve-plan (dry-run, no writes).
      // Usage: same flags as kaggle-improve-plan, plus [--execute] [--label <name>].
      const flags: Record<string, string> = {};
      const bare = new Set<string>();
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '--execute') {
          bare.add('execute');
          continue;
        }
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const registryPath =
        flags.registry ||
        path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      let raw: any;
      let registry;
      try {
        raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        registry = parseTargetsRegistry(raw);
      } catch (err: any) {
        process.stderr.write(
          `kaggle-improve-run: invalid registry ${registryPath}: ${err?.message || err}\n`
        );
        process.exit(1);
      }
      const parseJsonFlag = <T>(name: string): T | undefined => {
        if (!flags[name]) return undefined;
        try {
          return JSON.parse(flags[name]) as T;
        } catch (err: any) {
          process.stderr.write(
            `kaggle-improve-run: invalid --${name} JSON: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      };
      const truthy = (v: string | undefined) => v === '1' || v === 'true' || v === 'yes';
      const hourJst = Number.isFinite(Number(flags.hour))
        ? Number(flags.hour)
        : new Date().getHours();
      const envEnabled =
        flags['env-enabled'] !== undefined
          ? truthy(flags['env-enabled'])
          : truthy(process.env.KAGGLE_IMPROVE_ENABLED);
      let signals = parseJsonFlag<Record<string, GuardSignals>>('signals');
      let material = parseJsonFlag<Record<string, ImprovementMaterial>>('material');
      const runLabel = flags.label || 'auto-improve';

      // 適応的資源配分（design §50）: dynamic モードなら全コンペを履歴ファイルから安価に価格付けし、
      // この枠で priority 最高の improve コンペを選ぶ。静的モード（既定）は従来の hour→rotation。
      // 同時に自動 maintain（design §49）: 連続非昇格が閾値を超えた系統を maintain へ落として枠を再配分。
      let competitionKeyOverride: string | undefined;
      let selectedCompetition: string | null = null;
      const autoMaintained: Array<{ repo: string; reason: string }> = [];
      // 完了駆動ループ（SOT: JST枠廃止）: `--competition <key>` が指定されたら JST時刻の pinned/動的配分を
      // 一切スキップし、そのコンペだけを評価する。cron ラッパは全コンペを列挙してこれを毎tick回す
      // （＝時刻枠でなく「前サイクル完了」で次サイクルが決まる）。
      const forcedCompetition = flags.competition ? flags.competition : undefined;
      // 固定枠（pinned slot）: この hour が pinned なら動的配分をスキップし、その確定当番を使う。
      // recent_competitions（動的配分のクールダウン履歴）には記録せず、動的枠側の挙動を変えない。
      const pinnedSlot = forcedCompetition ? null : resolvePinnedSlotForHour(registry, hourJst);
      const dynamicActive =
        !forcedCompetition &&
        !pinnedSlot &&
        registry.allocation.mode === 'dynamic' &&
        registry.enabled &&
        envEnabled;
      if (forcedCompetition) {
        competitionKeyOverride = forcedCompetition;
        process.stderr.write(
          `[allocation] competition forced=${forcedCompetition} (completion-driven; JST slot/dynamic skipped)\n`
        );
      }
      if (pinnedSlot) {
        competitionKeyOverride = pinnedSlot.competition;
        process.stderr.write(
          `[allocation] slot=${hourJst} pinned=${pinnedSlot.competition}` +
            `${pinnedSlot.lineage ? ` lineage=${pinnedSlot.lineage}` : ''} (dynamic selection skipped)\n`
        );
      }
      if (dynamicActive) {
        try {
          const alloc = await collectAllocationSignals(registry, {
            label: runLabel,
            weights: registry.allocation.weights,
            log: (m) => process.stderr.write(`[allocation] ${m}\n`),
          });
          // 自動 maintain: 閾値超過の improve 系統を registry で maintain に落とす（永続化は execute 時）。
          const thr = registry.allocation.autoMaintainThreshold;
          if (thr > 0) {
            for (const ts of alloc.targets) {
              if (
                ts.mode === 'improve' &&
                shouldAutoMaintain(ts.consecutiveNonImproving, ts.recentlyPromoted, thr)
              ) {
                autoMaintained.push({
                  repo: ts.repo,
                  reason: `auto-maintain: ${ts.consecutiveNonImproving} consecutive non-improving cycles (>= ${thr})`,
                });
              }
            }
          }
          // maintain へ落とした系統は候補から除外して再選択（当枠での再配分）。
          const maintainedRepos = new Set(autoMaintained.map((m) => m.repo));
          const candidates = alloc.candidates.map((c) => {
            const compTargets = alloc.targets.filter((t) => t.competition === c.key);
            const stillEligible = compTargets.some(
              (t) => t.eligible && !maintainedRepos.has(t.repo)
            );
            return { ...c, eligible: stillEligible };
          });
          // 多様性補正（design §50）: 直近起案コンペを registry.state.recent_competitions から読み、
          // クールダウン減衰を効かせて同一コンペの連続独占を防ぐ（momentum 偏重の抑制）。
          const recentlyDrafted: string[] = Array.isArray(raw?.state?.recent_competitions)
            ? raw.state.recent_competitions.filter((k: unknown): k is string => typeof k === 'string')
            : [];
          const selected = selectDynamicCompetition(candidates, {
            recentlyDrafted,
            cooldownWindow: registry.allocation.cooldownWindow,
            cooldownFactor: registry.allocation.cooldownFactor,
          });
          selectedCompetition = selected;
          competitionKeyOverride = selected ?? '';
          process.stderr.write(
            `[allocation] slot=${hourJst} selected=${selected ?? '(none — all saturated/closed/open)'} ` +
              `recentlyDrafted=${JSON.stringify(recentlyDrafted.slice(0, registry.allocation.cooldownWindow))} ` +
              `candidates=${JSON.stringify(candidates)}\n`
          );
        } catch (err: any) {
          // Fail-open: 配分計算が失敗したら静的 rotation に戻す（override 未設定）。
          process.stderr.write(`[allocation] failed (fallback to static rotation): ${err?.message || err}\n`);
        }
      }

      // 材料/シグナルは cron が自動収集する（未指定かつ active な当番枠のみ・best-effort）。
      const collected = await maybeCollectImproveContext({
        registry,
        hourJst,
        active: registry.enabled && envEnabled,
        label: flags.label,
        noCollect: flags['no-collect'] === '1' || truthy(process.env.KAGGLE_IMPROVE_NO_COLLECT),
        haveSignals: signals !== undefined,
        haveMaterial: material !== undefined,
        kaggle: flags['no-kaggle'] !== '1',
        competitionKeyOverride,
      });
      if (collected) {
        if (signals === undefined) signals = collected.signals;
        if (material === undefined) material = collected.material;
      }
      const plan = planImprovementCycle({
        registry,
        hourJst,
        envEnabled,
        signals,
        material,
        competitionKeyOverride,
      });

      const execute = bare.has('execute');
      const label = runLabel;
      const created: Array<{ project: string; identifier: string; url: string }> = [];
      const skipped: Array<{ project: string; reason: string }> = [];
      if (execute && plan.active) {
        for (const t of plan.targets) {
          if (t.action !== 'draft' || !t.issueTitle || !t.issueBody) {
            skipped.push({ project: t.project, reason: t.reason });
            continue;
          }
          // Live re-check of the active-cycle guard (guard 4) to avoid duplicate actionable drafts.
          // Completion-driven loop: In Review cycle *parents* (children still implementing, or the
          // integration/submission phase) count as unfinished so the 10-min cron never double-drafts.
          const open = await findOpenImproveCycleParent(t.project, label);
          if (open) {
            skipped.push({
              project: t.project,
              reason: `open improve cycle parent already exists (${open})`,
            });
            continue;
          }
          try {
            const res = await createDraftIssue({
              projectName: t.project,
              title: t.issueTitle,
              description: t.issueBody,
              labelName: label,
            });
            if (res) {
              created.push({ project: t.project, identifier: res.identifier, url: res.url });
              // Bump next_cycle for this target in the raw registry so the next cycle is 第(N+1)次.
              for (const comp of raw.competitions ?? []) {
                if (comp.key !== t.competition) continue;
                for (const tgt of comp.targets ?? []) {
                  if (tgt.repo === t.repo) tgt.next_cycle = (Number(tgt.next_cycle) || 1) + 1;
                }
              }
            } else {
              skipped.push({ project: t.project, reason: 'createDraftIssue returned null' });
            }
          } catch (err: any) {
            skipped.push({ project: t.project, reason: `create failed: ${err?.message || err}` });
          }
        }
        // 自動 maintain（design §49）: 閾値超過の系統を registry で maintain に落とす（枠再配分）。
        for (const m of autoMaintained) {
          for (const comp of raw.competitions ?? []) {
            for (const tgt of comp.targets ?? []) {
              if (tgt.repo === m.repo && tgt.mode !== 'maintain') {
                tgt.mode = 'maintain';
                process.stderr.write(`[allocation] ${m.repo} -> mode:maintain (${m.reason})\n`);
              }
            }
          }
        }
        // Persist next_cycle bumps + maintain flips + recent-competition history + last_run_at
        // (best-effort; keeps doc keys intact).
        try {
          raw.state = raw.state && typeof raw.state === 'object' ? raw.state : {};
          raw.state.created_today = (Number(raw.state.created_today) || 0) + created.length;
          // 多様性補正のクールダウン履歴（design §50）: 実際に起案できた枠だけ記録し、newest-first で保持。
          // cooldownWindow の2倍まで保持すれば十分（それより古い出現は減衰計算に影響しない）。
          if (selectedCompetition && created.length > 0) {
            const prior: string[] = Array.isArray(raw.state.recent_competitions)
              ? raw.state.recent_competitions.filter((k: unknown): k is string => typeof k === 'string')
              : [];
            raw.state.recent_competitions = [selectedCompetition, ...prior].slice(
              0,
              Math.max(6, registry.allocation.cooldownWindow * 2)
            );
          }
          fs.writeFileSync(registryPath, JSON.stringify(raw, null, 2) + '\n');
        } catch (err: any) {
          process.stderr.write(
            `kaggle-improve-run: failed to persist registry: ${err?.message || err}\n`
          );
        }
      }

      process.stdout.write(
        JSON.stringify({ plan, executed: execute, created, skipped, autoMaintained }) + '\n'
      );
      process.exit(0);
      break;
    }
    case 'kaggle-submission-plan':
    case 'kaggle-champion-plan': {
      // SOT-1913/SOT-1934: decide completion-triggered artifact submission for a competition's
      // targets (claude/gpt). A validated candidate may be submitted without champion promotion.
      // `kaggle-champion-plan` remains as a backwards-compatible alias.
      // scripts/ai/kaggle_targets_submit.sh fetches today's counts, calls this, then submits.
      // Usage:
      //   runner-cli.js kaggle-champion-plan [--registry <path>] [--competition <key>] [--hour <0-23>]
      //       [--submitted <json {repo: todayCount}>] [--last-lineage claude|gpt]
      // --last-lineage is only used by alternate-mode competitions (ARC=1/day shared): the next
      // submission goes to the OTHER lineage than the one that submitted last.
      // Prints the CompetitionSubmitPlan as JSON on stdout (exit 0). Fail-loud (exit 1) on bad input.
      const flags: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      const registryPath =
        flags.registry ||
        path.join(__dirname, '..', 'scripts', 'ai', 'kaggle_targets_registry.json');
      let registry;
      try {
        registry = parseTargetsRegistry(JSON.parse(fs.readFileSync(registryPath, 'utf8')));
      } catch (err: any) {
        process.stderr.write(
          `kaggle-submission-plan: invalid registry ${registryPath}: ${err?.message || err}\n`
        );
        process.exit(1);
      }
      // competition: explicit --competition wins, else resolve from --hour via the rotation table.
      let competitionKey = flags.competition || '';
      if (!competitionKey) {
        const hourJst = Number.isFinite(Number(flags.hour))
          ? Number(flags.hour)
          : new Date().getHours();
        competitionKey = resolveCompetitionForHour(registry, hourJst) || '';
      }
      if (!competitionKey) {
        process.stderr.write(
          'kaggle-submission-plan: no competition (pass --competition or a scheduled --hour)\n'
        );
        process.exit(1);
      }
      let submittedByRepo: Record<string, number> = {};
      if (flags.submitted) {
        try {
          submittedByRepo = JSON.parse(flags.submitted) as Record<string, number>;
        } catch (err: any) {
          process.stderr.write(
            `kaggle-submission-plan: invalid --submitted JSON: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      }
      // SOT-1913: alternate モード（ARC=1/day 共有）用に前回提出系統を渡す（both では無視される）。
      let lastSubmittedLineage: 'claude' | 'gpt' | null = null;
      if (flags['last-lineage'] === 'claude' || flags['last-lineage'] === 'gpt') {
        lastSubmittedLineage = flags['last-lineage'];
      } else if (flags['last-lineage']) {
        process.stderr.write('kaggle-submission-plan: --last-lineage must be "claude" or "gpt"\n');
        process.exit(1);
      }
      let completedSlotRepos = new Set<string>();
      if (flags['completed-slot-repos']) {
        try {
          const parsed = JSON.parse(flags['completed-slot-repos']);
          if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
            throw new Error('expected a JSON string array');
          }
          completedSlotRepos = new Set(parsed);
        } catch (err: any) {
          process.stderr.write(
            `kaggle-submission-plan: invalid --completed-slot-repos JSON: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      }
      const competitionSubmittedToday = flags['competition-submitted']
        ? Number(flags['competition-submitted'])
        : undefined;
      if (
        competitionSubmittedToday !== undefined &&
        (!Number.isInteger(competitionSubmittedToday) || competitionSubmittedToday < 0)
      ) {
        process.stderr.write(
          'kaggle-submission-plan: --competition-submitted must be a non-negative integer\n'
        );
        process.exit(1);
      }
      const parseStringMap = (flag: string): Record<string, string> => {
        if (!flag) return {};
        const parsed = JSON.parse(flag);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every((value) => typeof value === 'string')
        ) {
          throw new Error('expected a JSON object with string values');
        }
        return parsed;
      };
      const parseStringArrayMap = (flag: string): Record<string, string[]> => {
        if (!flag) return {};
        const parsed = JSON.parse(flag);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed) ||
          !Object.values(parsed).every(
            (value) => Array.isArray(value) && value.every((item) => typeof item === 'string')
          )
        ) {
          throw new Error('expected a JSON object with string-array values');
        }
        return parsed;
      };
      let artifactFingerprintsByRepo: Record<string, string>;
      let submittedArtifactFingerprintsByRepo: Record<string, string[]>;
      try {
        artifactFingerprintsByRepo = parseStringMap(flags['artifact-fingerprints']);
        submittedArtifactFingerprintsByRepo = parseStringArrayMap(
          flags['submitted-artifact-fingerprints']
        );
      } catch (err: any) {
        process.stderr.write(
          `kaggle-submission-plan: invalid artifact fingerprint JSON: ${err?.message || err}\n`
        );
        process.exit(1);
      }
      const plan = planCompetitionSubmission(registry, competitionKey, submittedByRepo, {
        lastSubmittedLineage,
        dateUtc: flags['date-utc'],
        completedSlotRepos,
        competitionSubmittedToday,
        artifactFingerprintsByRepo,
        submittedArtifactFingerprintsByRepo,
      });
      if (!plan) {
        process.stderr.write(
          `kaggle-submission-plan: competition "${competitionKey}" not in registry\n`
        );
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(plan) + '\n');
      process.exit(0);
      break;
    }
    case 'kernel-fingerprint': {
      // SOT-2517: compute the *executed-computation* fingerprint for a code-competition kernel target.
      // The visible submission.csv is intentionally NOT part of identity: a code competition can have a
      // layer that overwrites the visible output, so byte-identical CSVs can hide a different hidden-run
      // behavior — deduping on the CSV (a) wrongly drops a genuinely-new lever submission and (b) lets a
      // byte-identical output falsely CLOSE a lever (rogii cycle11 "blend inert" real incident). Instead
      // we hash the notebook code cells + pinned dataset sources + kernel version. Prints
      // `kernel:sha256:<hex>` on stdout. scripts/ai/kaggle_targets_submit.sh calls this for
      // submit.kind == "kernel" targets. Fail-loud (exit 1) on unreadable inputs so the caller can fall
      // back to the visible-artifact hash rather than silently deduping on an empty fingerprint.
      const flags: Record<string, string> = {};
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a && a.startsWith('--')) {
          flags[a.slice(2)] = args[i + 1] ?? '';
          i += 1;
        }
      }
      let notebookJson: unknown;
      if (flags.notebook) {
        try {
          notebookJson = JSON.parse(fs.readFileSync(flags.notebook, 'utf8'));
        } catch (err: any) {
          process.stderr.write(
            `kernel-fingerprint: cannot read notebook ${flags.notebook}: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      }
      let datasetSources: string[] = [];
      if (flags['dataset-sources']) {
        try {
          const parsed = JSON.parse(flags['dataset-sources']);
          if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) {
            throw new Error('expected a JSON string array');
          }
          datasetSources = parsed;
        } catch (err: any) {
          process.stderr.write(
            `kernel-fingerprint: invalid --dataset-sources JSON: ${err?.message || err}\n`
          );
          process.exit(1);
        }
      }
      const fingerprint = computeKernelFingerprint({
        notebookJson,
        codeSource: flags['code-source'] || undefined,
        datasetSources,
        version: flags.version || null,
      });
      process.stdout.write(fingerprint + '\n');
      process.exit(0);
      break;
    }
    default: {
      process.stderr.write(
        `Unknown command: ${command}\nAvailable: classify-issue, set-issue-in-progress, resolve-worker-roles, resolve-pipeline-graph, execution-plan, pipeline-graph, kaggle-plan, kaggle-improve-plan, kaggle-champion-plan, ...\n`
      );
      process.exit(1);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`runner-cli error: ${err.message}\n`);
  process.exit(1);
});
