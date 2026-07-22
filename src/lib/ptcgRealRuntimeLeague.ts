import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LeagueMatchEvent, LeagueReport } from './ptcgLeagueReport.js';
import type { SevenAgentId, SevenAgentManifest } from './ptcgSevenAgentLeague.js';

export const REAL_RUNTIME_AUDIT_SCHEMA = 'ptcg-real-runtime-audit/v1' as const;

export interface RuntimeMatchPlan {
  id: string;
  first: SevenAgentId;
  second: SevenAgentId;
  seed: number;
}

export interface RuntimeAudit {
  schemaVersion: typeof REAL_RUNTIME_AUDIT_SCHEMA;
  runtime: { engine: string; seeds: number[]; seatSwap: true; timeoutMs: number; budgetHours: number };
  execution: { planned: number; recorded: number; faults: number; unfinished: number; illegalActions: number; timeouts: number; elapsedMs: number };
  syntheticDifference: Array<{ first: string; second: string; runtimeFirstWinRate: number; syntheticFirstWinRate: number | null; delta: number | null }>;
  bottleneck: { matchup: string; absoluteDelta: number } | null;
}

export function buildRepresentativeRuntimePlan(seeds: number[]): RuntimeMatchPlan[] {
  const ids: SevenAgentId[] = ['sol', 'debate', 'fable', 'matsu', 'take', 'ume', 'zero'];
  const plans: RuntimeMatchPlan[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      for (const seed of seeds) {
        plans.push({ id: `${ids[i]}-vs-${ids[j]}.seed-${seed}.ab`, first: ids[i], second: ids[j], seed });
        plans.push({ id: `${ids[i]}-vs-${ids[j]}.seed-${seed}.ba`, first: ids[j], second: ids[i], seed });
      }
    }
  }
  return plans;
}

export function runRealRuntimeMatch(options: {
  root: string;
  siblingsRoot: string;
  manifest: SevenAgentManifest;
  plan: RuntimeMatchPlan;
  timeoutMs: number;
}): LeagueMatchEvent {
  const { root, siblingsRoot, manifest, plan, timeoutMs } = options;
  const artifact = (id: SevenAgentId) => manifest.agents.find((agent) => agent.id === id)!;
  const output = execFileSync('python3', [
    path.join(root, 'scripts', 'ptcg_real_runtime_match.py'),
    '--engine-repo', path.join(siblingsRoot, 'ptcg-agent-sol'),
    '--server', path.join(root, 'scripts', 'ptcg_agent_runtime_server.py'),
    '--first-id', plan.first, '--first-repo', path.join(siblingsRoot, artifact(plan.first).repository),
    '--second-id', plan.second, '--second-repo', path.join(siblingsRoot, artifact(plan.second).repository),
    '--seed', String(plan.seed), '--timeout-ms', String(timeoutMs),
  ], { encoding: 'utf8', timeout: timeoutMs * 4, maxBuffer: 4 * 1024 * 1024 });
  const result = JSON.parse(output.trim()) as {
    outcome: 'first' | 'second' | 'draw' | 'unfinished';
    fault: { agent: string; kind: string } | null;
    thinkTimeMs: { first: number; second: number };
    durationMs: number;
  };
  return { matchId: plan.id, first: plan.first, second: plan.second, outcome: result.fault ? 'fault' : result.outcome,
    fault: result.fault ? { seat: result.fault.kind === 'adapter' ? 'first' : result.fault.agent === plan.second ? 'second' : 'first', kind: result.fault.kind, code: result.fault.kind } : undefined,
    thinkTimeMs: result.thinkTimeMs, durationMs: result.durationMs };
}

export function buildRuntimeAudit(options: {
  runtime: LeagueReport;
  synthetic: LeagueReport;
  seeds: number[];
  timeoutMs: number;
  budgetHours: number;
  elapsedMs: number;
  events: LeagueMatchEvent[];
}): RuntimeAudit {
  const differences = options.runtime.matchups.map((row) => {
    const synthetic = options.synthetic.matchups.find((candidate) => candidate.first === row.first && candidate.second === row.second);
    const syntheticRate = synthetic?.firstWinRate ?? null;
    const runtimeRate = row.firstWinRate ?? 0;
    return { first: row.first, second: row.second, runtimeFirstWinRate: runtimeRate,
      syntheticFirstWinRate: syntheticRate, delta: syntheticRate === null ? null : runtimeRate - syntheticRate };
  });
  const measured = differences.filter((row): row is typeof row & { delta: number } => row.delta !== null);
  const largest = measured.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  return {
    schemaVersion: REAL_RUNTIME_AUDIT_SCHEMA,
    runtime: { engine: 'cabt-real-process/v1', seeds: options.seeds, seatSwap: true, timeoutMs: options.timeoutMs, budgetHours: options.budgetHours },
    execution: { planned: options.runtime.planned, recorded: options.runtime.recorded,
      faults: options.runtime.totals.faults, unfinished: options.runtime.totals.unfinished,
      illegalActions: options.events.filter((event) => event.fault?.code === 'illegal-action').length,
      timeouts: options.events.filter((event) => event.fault?.code === 'timeout').length,
      elapsedMs: options.elapsedMs },
    syntheticDifference: differences,
    bottleneck: largest ? { matchup: `${largest.first} vs ${largest.second}`, absoluteDelta: Math.abs(largest.delta) } : null,
  };
}

export function writeRuntimeAudit(output: string, audit: RuntimeAudit): void {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'runtime-audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
  const rows = audit.syntheticDifference.map((row) => `| ${row.first} vs ${row.second} | ${row.runtimeFirstWinRate.toFixed(3)} | ${row.syntheticFirstWinRate?.toFixed(3) ?? 'n/a'} | ${row.delta?.toFixed(3) ?? 'n/a'} |`);
  fs.writeFileSync(path.join(output, 'runtime-audit.md'), [
    '# Real-process vs synthetic league audit', '',
    `- Engine: ${audit.runtime.engine}`,
    `- Fixed seeds: ${audit.runtime.seeds.join(', ')}`,
    `- Seat swap: ${audit.runtime.seatSwap}`,
    `- Planned / recorded: ${audit.execution.planned} / ${audit.execution.recorded}`,
    `- Fault / unfinished / illegal action / timeout: ${audit.execution.faults} / ${audit.execution.unfinished} / ${audit.execution.illegalActions} / ${audit.execution.timeouts}`,
    `- Elapsed: ${(audit.execution.elapsedMs / 1000).toFixed(3)}s (budget ${audit.runtime.budgetHours}h)`,
    `- Maximum synthetic/runtime gap: ${audit.bottleneck ? `${audit.bottleneck.matchup} (${audit.bottleneck.absoluteDelta.toFixed(3)})` : 'n/a'}`,
    '', '| matchup | runtime first win rate | synthetic first win rate | delta |', '| --- | ---: | ---: | ---: |', ...rows, '',
  ].join('\n'));
}
