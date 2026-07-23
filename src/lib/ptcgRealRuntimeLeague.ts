import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LeagueMatchEvent, LeagueReport, WilsonInterval } from './ptcgLeagueReport.js';
import type { SevenAgentId, SevenAgentManifest } from './ptcgSevenAgentLeague.js';

export const REAL_RUNTIME_AUDIT_SCHEMA = 'ptcg-real-runtime-audit/v1' as const;
export const RUNTIME_LATENCY_PROFILE_SCHEMA = 'ptcg-runtime-latency-profile/v1' as const;
export const REAL_RUNTIME_PLAN_SCHEMA = 'ptcg-real-runtime-league-plan/v1' as const;

export interface RuntimeLeagueManifest {
  schemaVersion: typeof REAL_RUNTIME_PLAN_SCHEMA;
  leagueId: string;
  seeds: number[];
  seatSwap: true;
  timeoutMs: number;
  budgetHours: number;
  estimatedMatchMinutes: number;
  priorityMatchups: Array<[SevenAgentId, SevenAgentId]>;
}

export interface RuntimeMatchPlan {
  id: string;
  first: SevenAgentId;
  second: SevenAgentId;
  seed: number;
}

export interface RuntimeAudit {
  schemaVersion: typeof REAL_RUNTIME_AUDIT_SCHEMA;
  runtime: {
    engine: string;
    seeds: number[];
    seatSwap: true;
    timeoutMs: number;
    budgetHours: number;
  };
  execution: {
    planned: number;
    recorded: number;
    faults: number;
    unfinished: number;
    illegalActions: number;
    timeouts: number;
    elapsedMs: number;
  };
  syntheticDifference: Array<{
    first: string;
    second: string;
    sampleSize: number;
    runtimeFirstWinRate: number;
    runtimeWilson95: WilsonInterval | null;
    syntheticFirstWinRate: number | null;
    syntheticWilson95: WilsonInterval | null;
    delta: number | null;
    deltaWilson95: WilsonInterval | null;
  }>;
  bottleneck: { matchup: string; absoluteDelta: number } | null;
}

type RuntimeStage = 'processStartup' | 'request' | 'inference' | 'engine';
interface LatencyStats {
  samples: number;
  p50: number;
  p95: number;
  max: number;
  total: number;
}
export interface RuntimeLatencyProfile {
  schemaVersion: typeof RUNTIME_LATENCY_PROFILE_SCHEMA;
  totalDurationMs: number;
  agents: Record<string, Partial<Record<RuntimeStage, LatencyStats>>>;
  matchups: Array<{
    matchup: string;
    totalDurationMs: number;
    contributionRate: number;
    stages: Partial<Record<RuntimeStage, LatencyStats>>;
  }>;
  bottleneck: { matchup: string; contributionRate: number; totalDurationMs: number } | null;
  improvementCandidates: Array<{
    candidate: string;
    safety: 'low-risk';
    expectedReductionMs: number;
    expectedReductionRate: number;
    condition: string;
  }>;
}

function latencyStats(values: number[]): LatencyStats | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1];
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1],
    total: sorted.reduce((sum, value) => sum + value, 0),
  };
}

export function buildRuntimeLatencyProfile(events: LeagueMatchEvent[]): RuntimeLatencyProfile {
  const agents: Record<string, Partial<Record<RuntimeStage, number[]>>> = {};
  const matchupValues = new Map<
    string,
    { duration: number; stages: Record<RuntimeStage, number[]> }
  >();
  let totalDurationMs = 0;
  let reusableStartupMs = 0;
  const startedAgents = new Set<string>();
  for (const event of events) {
    const duration = event.durationMs ?? 0;
    totalDurationMs += duration;
    if (!event.timingMs) continue;
    const pair = [event.first, event.second].sort();
    const matchup = pair.join(' vs ');
    const group = matchupValues.get(matchup) ?? {
      duration: 0,
      stages: { processStartup: [], request: [], inference: [], engine: [] },
    };
    group.duration += duration;
    for (const [seat, agent] of [
      ['first', event.first],
      ['second', event.second],
    ] as const) {
      const values = (agents[agent] ??= {});
      for (const stage of ['processStartup', 'request', 'inference'] as const) {
        (values[stage] ??= []).push(event.timingMs[stage][seat]);
        group.stages[stage].push(event.timingMs[stage][seat]);
      }
      if (startedAgents.has(agent)) reusableStartupMs += event.timingMs.processStartup[seat];
      else startedAgents.add(agent);
    }
    group.stages.engine.push(event.timingMs.engine);
    matchupValues.set(matchup, group);
  }
  const profiledAgents = Object.fromEntries(
    Object.entries(agents).map(([agent, stages]) => [
      agent,
      Object.fromEntries(
        Object.entries(stages).flatMap(([stage, values]) => {
          const stats = latencyStats(values);
          return stats ? [[stage, stats]] : [];
        })
      ),
    ])
  );
  const matchups = [...matchupValues.entries()]
    .map(([matchup, group]) => ({
      matchup,
      totalDurationMs: group.duration,
      contributionRate: totalDurationMs ? group.duration / totalDurationMs : 0,
      stages: Object.fromEntries(
        Object.entries(group.stages).flatMap(([stage, values]) => {
          const stats = latencyStats(values);
          return stats ? [[stage, stats]] : [];
        })
      ),
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs);
  const expectedReductionMs = Math.max(0, reusableStartupMs);
  return {
    schemaVersion: RUNTIME_LATENCY_PROFILE_SCHEMA,
    totalDurationMs,
    agents: profiledAgents,
    matchups,
    bottleneck: matchups[0]
      ? {
          matchup: matchups[0].matchup,
          contributionRate: matchups[0].contributionRate,
          totalDurationMs: matchups[0].totalDurationMs,
        }
      : null,
    improvementCandidates: [
      {
        candidate: 'reuse-agent-processes-across-matches',
        safety: 'low-risk',
        expectedReductionMs,
        expectedReductionRate: totalDurationMs ? expectedReductionMs / totalDurationMs : 0,
        condition:
          'Reset and reseed both agents before every match; enable only after action/result parity passes.',
      },
      {
        candidate: 'cache-identical-observation-actions',
        safety: 'low-risk',
        expectedReductionMs: 0,
        expectedReductionRate: 0,
        condition:
          'Disabled by default; measure repeated canonical observations and require deterministic-agent parity.',
      },
    ],
  };
}

export function writeRuntimeLatencyProfile(output: string, profile: RuntimeLatencyProfile): void {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, 'latency-profile.json'),
    `${JSON.stringify(profile, null, 2)}\n`
  );
  const f = (value: number) => value.toFixed(3);
  const agentRows = Object.entries(profile.agents).flatMap(([agent, stages]) =>
    Object.entries(stages).map(
      ([stage, stats]) =>
        `| ${agent} | ${stage} | ${stats.samples} | ${f(stats.p50)} | ${f(stats.p95)} | ${f(stats.max)} |`
    )
  );
  const matchupRows = profile.matchups.map(
    (row) =>
      `| ${row.matchup} | ${f(row.totalDurationMs)} | ${(row.contributionRate * 100).toFixed(2)}% |`
  );
  const candidates = profile.improvementCandidates.map(
    (row) =>
      `| ${row.candidate} | ${f(row.expectedReductionMs)} | ${(row.expectedReductionRate * 100).toFixed(2)}% | ${row.condition} |`
  );
  fs.writeFileSync(
    path.join(output, 'latency-profile.md'),
    [
      '# Seven-agent real-runtime latency profile',
      '',
      `- Total measured match time: ${f(profile.totalDurationMs)} ms`,
      `- Largest matchup contribution: ${profile.bottleneck ? `${profile.bottleneck.matchup} (${(profile.bottleneck.contributionRate * 100).toFixed(2)}%)` : 'n/a'}`,
      '',
      '| agent | stage | samples | p50 ms | p95 ms | max ms |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
      ...agentRows,
      '',
      '| matchup | total ms | league contribution |',
      '| --- | ---: | ---: |',
      ...matchupRows,
      '',
      '| improvement candidate | expected reduction ms | expected reduction | parity condition |',
      '| --- | ---: | ---: | --- |',
      ...candidates,
      '',
    ].join('\n')
  );
}

export function parseRuntimeLeagueManifest(value: unknown): RuntimeLeagueManifest {
  const manifest = value as Partial<RuntimeLeagueManifest>;
  const agentIds = new Set<SevenAgentId>([
    'sol',
    'debate',
    'fable',
    'matsu',
    'take',
    'ume',
    'zero',
  ]);
  if (manifest.schemaVersion !== REAL_RUNTIME_PLAN_SCHEMA)
    throw new Error('unsupported real-runtime plan schema');
  if (!manifest.leagueId) throw new Error('real-runtime leagueId is required');
  if (
    !Array.isArray(manifest.seeds) ||
    manifest.seeds.length < 2 ||
    manifest.seeds.some((seed) => !Number.isSafeInteger(seed)) ||
    new Set(manifest.seeds).size !== manifest.seeds.length
  )
    throw new Error('real-runtime plan requires unique fixed integer seeds');
  if (manifest.seatSwap !== true) throw new Error('real-runtime plan requires seat swap');
  if (!Number.isFinite(manifest.timeoutMs) || manifest.timeoutMs! <= 0)
    throw new Error('real-runtime timeout must be positive');
  if (!Number.isFinite(manifest.budgetHours) || manifest.budgetHours! <= 0)
    throw new Error('real-runtime budget must be positive');
  if (!Number.isFinite(manifest.estimatedMatchMinutes) || manifest.estimatedMatchMinutes! <= 0)
    throw new Error('estimated match duration must be positive');
  if (
    !Array.isArray(manifest.priorityMatchups) ||
    manifest.priorityMatchups.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !agentIds.has(pair[0]) ||
        !agentIds.has(pair[1]) ||
        pair[0] === pair[1]
    )
  )
    throw new Error('priority matchups must contain distinct known agents');
  return manifest as RuntimeLeagueManifest;
}

export function budgetedMatchCount(manifest: RuntimeLeagueManifest): number {
  const raw = Math.floor((manifest.budgetHours * 60) / manifest.estimatedMatchMinutes);
  return raw - (raw % 2);
}

export function buildRepresentativeRuntimePlan(
  seeds: number[],
  options: { priorityMatchups?: Array<[SevenAgentId, SevenAgentId]>; maxMatches?: number } = {}
): RuntimeMatchPlan[] {
  const ids: SevenAgentId[] = ['sol', 'debate', 'fable', 'matsu', 'take', 'ume', 'zero'];
  const priority = new Map(
    (options.priorityMatchups ?? []).map((pair, index) => [[...pair].sort().join('\0'), index])
  );
  const pairs: Array<[SevenAgentId, SevenAgentId]> = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  pairs.sort((left, right) => {
    const leftRank = priority.get([...left].sort().join('\0')) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = priority.get([...right].sort().join('\0')) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  const plans: RuntimeMatchPlan[] = [];
  for (const seed of seeds) {
    for (const [first, second] of pairs) {
      plans.push({ id: `${first}-vs-${second}.seed-${seed}.ab`, first, second, seed });
      plans.push({
        id: `${first}-vs-${second}.seed-${seed}.ba`,
        first: second,
        second: first,
        seed,
      });
    }
  }
  const maximum = options.maxMatches ?? plans.length;
  return plans.slice(0, Math.max(0, maximum - (maximum % 2)));
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
  const output = execFileSync(
    'python3',
    [
      path.join(root, 'scripts', 'ptcg_real_runtime_match.py'),
      '--engine-repo',
      path.join(siblingsRoot, 'ptcg-agent-sol'),
      '--server',
      path.join(root, 'scripts', 'ptcg_agent_runtime_server.py'),
      '--first-id',
      plan.first,
      '--first-repo',
      path.join(siblingsRoot, artifact(plan.first).repository),
      '--second-id',
      plan.second,
      '--second-repo',
      path.join(siblingsRoot, artifact(plan.second).repository),
      '--seed',
      String(plan.seed),
      '--timeout-ms',
      String(timeoutMs),
    ],
    { encoding: 'utf8', timeout: timeoutMs * 4, maxBuffer: 4 * 1024 * 1024 }
  );
  const result = JSON.parse(output.trim()) as {
    outcome: 'first' | 'second' | 'draw' | 'unfinished';
    fault: { agent: string; kind: string } | null;
    thinkTimeMs: { first: number; second: number };
    durationMs: number;
    timingMs?: LeagueMatchEvent['timingMs'];
  };
  return {
    matchId: plan.id,
    first: plan.first,
    second: plan.second,
    outcome: result.fault ? 'fault' : result.outcome,
    fault: result.fault
      ? {
          seat:
            result.fault.kind === 'adapter'
              ? 'first'
              : result.fault.agent === plan.second
                ? 'second'
                : 'first',
          kind: result.fault.kind,
          code: result.fault.kind,
        }
      : undefined,
    thinkTimeMs: result.thinkTimeMs,
    durationMs: result.durationMs,
    timingMs: result.timingMs,
  };
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
    const synthetic = options.synthetic.matchups.find(
      (candidate) => candidate.first === row.first && candidate.second === row.second
    );
    const syntheticRate = synthetic?.firstWinRate ?? null;
    const runtimeRate = row.firstWinRate ?? 0;
    const deltaWilson95 =
      row.firstWinWilson95 && synthetic?.firstWinWilson95
        ? {
            low: row.firstWinWilson95.low - synthetic.firstWinWilson95.high,
            high: row.firstWinWilson95.high - synthetic.firstWinWilson95.low,
          }
        : null;
    return {
      first: row.first,
      second: row.second,
      sampleSize: row.decided,
      runtimeFirstWinRate: runtimeRate,
      runtimeWilson95: row.firstWinWilson95,
      syntheticFirstWinRate: syntheticRate,
      syntheticWilson95: synthetic?.firstWinWilson95 ?? null,
      delta: syntheticRate === null ? null : runtimeRate - syntheticRate,
      deltaWilson95,
    };
  });
  const measured = differences.filter(
    (row): row is typeof row & { delta: number } => row.delta !== null
  );
  const largest = measured.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
  return {
    schemaVersion: REAL_RUNTIME_AUDIT_SCHEMA,
    runtime: {
      engine: 'cabt-real-process/v1',
      seeds: options.seeds,
      seatSwap: true,
      timeoutMs: options.timeoutMs,
      budgetHours: options.budgetHours,
    },
    execution: {
      planned: options.runtime.planned,
      recorded: options.runtime.recorded,
      faults: options.runtime.totals.faults,
      unfinished: options.runtime.totals.unfinished,
      illegalActions: options.events.filter((event) => event.fault?.code === 'illegal-action')
        .length,
      timeouts: options.events.filter((event) => event.fault?.code === 'timeout').length,
      elapsedMs: options.elapsedMs,
    },
    syntheticDifference: differences,
    bottleneck: largest
      ? { matchup: `${largest.first} vs ${largest.second}`, absoluteDelta: Math.abs(largest.delta) }
      : null,
  };
}

export function writeRuntimeAudit(output: string, audit: RuntimeAudit): void {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'runtime-audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
  const interval = (value: WilsonInterval | null) =>
    value ? `${value.low.toFixed(3)}–${value.high.toFixed(3)}` : 'n/a';
  const rows = audit.syntheticDifference.map(
    (row) =>
      `| ${row.first} vs ${row.second} | ${row.sampleSize} | ${row.runtimeFirstWinRate.toFixed(3)} | ${interval(row.runtimeWilson95)} | ${row.syntheticFirstWinRate?.toFixed(3) ?? 'n/a'} | ${row.delta?.toFixed(3) ?? 'n/a'} | ${interval(row.deltaWilson95)} |`
  );
  fs.writeFileSync(
    path.join(output, 'runtime-audit.md'),
    [
      '# Real-process vs synthetic league audit',
      '',
      `- Engine: ${audit.runtime.engine}`,
      `- Fixed seeds: ${audit.runtime.seeds.join(', ')}`,
      `- Seat swap: ${audit.runtime.seatSwap}`,
      `- Planned / recorded: ${audit.execution.planned} / ${audit.execution.recorded}`,
      `- Fault / unfinished / illegal action / timeout: ${audit.execution.faults} / ${audit.execution.unfinished} / ${audit.execution.illegalActions} / ${audit.execution.timeouts}`,
      `- Elapsed: ${(audit.execution.elapsedMs / 1000).toFixed(3)}s (budget ${audit.runtime.budgetHours}h)`,
      `- Maximum synthetic/runtime gap: ${audit.bottleneck ? `${audit.bottleneck.matchup} (${audit.bottleneck.absoluteDelta.toFixed(3)})` : 'n/a'}`,
      '',
      '| matchup | sample | runtime first win rate | runtime Wilson 95% | synthetic first win rate | delta | delta 95% interval |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      ...rows,
      '',
    ].join('\n')
  );
}
