// SOT-1754: declarative pipeline graph — load / validate / step helpers.
//
// `run_auto.sh` historically hard-codes the role pipeline (task-check → implementation →
// verification → acceptance → github → linear-report, with bounded NEEDS_DEBUG back-edges and
// BLOCKED/NEEDS_USER_INPUT terminals) inside a bash while/case loop. This module externalizes that
// implicit graph into a declarative definition (`config/pipeline_graph.json`) and provides a
// deterministic engine to drive it:
//
//   - NODES are role dispatches: each node names the `run_worker.sh <role>` role it runs. Node
//     execution stays in bash (dispatcher / report / gate assets are unchanged); this engine only
//     decides WHERE TO GO NEXT.
//   - EDGES are keyed by the worker-report verdict: the `## Next Action` token
//     (READY_FOR_REVIEW / NEEDS_DEBUG / NEEDS_USER_INPUT / BLOCKED), the acceptance
//     machine-verdict events (ACCEPTANCE_PASS / ACCEPTANCE_FAIL, for nodes with
//     `verdict_source: "acceptance"`), NONE (no token parsed), and the mandatory `*` default.
//   - CYCLES are bounded two ways: a shared BUDGET consumed by back-edges (`counts: "debug"` —
//     the faithful mapping of the serial loop's single `debug_cycles` counter, max =
//     PIPELINE_MAX_DEBUG_CYCLES, default 2) and per-node `max_visits` as a backstop. Exceeding
//     either maps to the `__stop__` terminal (PIPELINE_STOP / needs attention).
//   - TERMINALS: `__done__` (all roles completed → COMPLETED / PR detection),
//     `__done_no_pr__` (successful no-op, e.g. task-check not-actionable/decomposed →
//     COMPLETED_NO_PR), `__stop__` (needs attention → COMPLETION_UNVERIFIED).
//
// The acceptance-node event precedence mirrors run_auto.sh exactly (SOT-1558): a machine-readable
// `## Acceptance: FAIL` always loops (ACCEPTANCE_FAIL) regardless of Next Action; PASS proceeds
// unless Next Action is a human-stop (NEEDS_USER_INPUT / BLOCKED); a missing verdict falls back to
// the Next Action token (with a warning, like PIPELINE_WARN in the serial path).
//
// Fail-open contract: run_auto.sh only enters the graph path when `pipeline-graph begin` succeeds;
// a missing/invalid graph makes the CLI exit non-zero and the serial pipeline runs unchanged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// repo root = src/lib/../.. (this file lives in src/lib/)
const REPO_ROOT = path.join(__dirname, '..', '..');
export const DEFAULT_GRAPH_PATH = path.join(REPO_ROOT, 'config', 'pipeline_graph.json');

export const GRAPH_TERMINALS = ['__done__', '__done_no_pr__', '__stop__'] as const;
export type GraphTerminalId = (typeof GRAPH_TERMINALS)[number];
/** Terminal names as printed to bash (underscores stripped). */
export type GraphTerminal = 'done' | 'done_no_pr' | 'stop';

export const NEXT_ACTION_TOKENS = [
  'READY_FOR_REVIEW',
  'NEEDS_DEBUG',
  'NEEDS_USER_INPUT',
  'BLOCKED',
] as const;
export type NextActionToken = (typeof NEXT_ACTION_TOKENS)[number];

export const GRAPH_EVENTS = [
  ...NEXT_ACTION_TOKENS,
  'ACCEPTANCE_PASS',
  'ACCEPTANCE_FAIL',
  'NONE',
  '*',
] as const;
export type GraphEvent = (typeof GRAPH_EVENTS)[number];

/**
 * A bound that may be resolved from the environment: either a literal non-negative integer or
 * `{ env, default, plus }` → int(env[env] ?? default) + plus. Used for budget maxima and
 * max_visits so the default graph can track PIPELINE_MAX_DEBUG_CYCLES without editing JSON.
 */
export type Bound = number | { env?: string; default: number; plus?: number };

export interface GraphEdge {
  to: string;
  /** Name of the budget this traversal consumes (must exist in graph.budgets). */
  counts?: string;
}

export interface GraphNode {
  /** The run_worker.sh role this node dispatches. */
  role: string;
  /** 'acceptance' → the `## Acceptance: PASS|FAIL` machine verdict takes precedence for events. */
  verdict_source?: 'acceptance';
  /** Backstop cap on how many times this node may be ENTERED; exceeding maps to __stop__. */
  max_visits?: Bound;
  /** Event → target (node id or terminal). A `*` default entry is mandatory. */
  on: Record<string, string | GraphEdge>;
}

export interface GraphBudget {
  max: Bound;
  /** Terminal to map exhaustion to (default __stop__). */
  on_exhausted?: GraphTerminalId;
}

export interface PipelineGraph {
  version: number;
  entry: string;
  budgets?: Record<string, GraphBudget>;
  nodes: Record<string, GraphNode>;
}

export interface PipelineGraphState {
  current: string;
  /** Times each node has been entered (entry node starts at 1). */
  visits: Record<string, number>;
  /** Budget name → traversals spent. */
  budgets: Record<string, number>;
  history: Array<{ from: string; event: string; to: string }>;
}

export type GraphStepResult =
  | { kind: 'node'; node: string; role: string; event: string; warning?: string }
  | { kind: 'terminal'; terminal: GraphTerminal; reason: string; event: string; warning?: string };

export function isGraphTerminal(id: string): id is GraphTerminalId {
  return (GRAPH_TERMINALS as readonly string[]).includes(id);
}

function terminalName(id: GraphTerminalId): GraphTerminal {
  return id.replace(/^__|__$/g, '') as GraphTerminal;
}

function normalizeEdge(raw: string | GraphEdge): GraphEdge {
  return typeof raw === 'string' ? { to: raw } : raw;
}

/** Resolve a Bound to a finite non-negative integer (null when the bound is absent/invalid). */
export function resolveBound(
  bound: Bound | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  if (bound === undefined || bound === null) return null;
  if (typeof bound === 'number') {
    return Number.isInteger(bound) && bound >= 0 ? bound : null;
  }
  let base = bound.default;
  if (bound.env) {
    const raw = env[bound.env];
    if (raw !== undefined && String(raw).trim() !== '') {
      const parsed = Number.parseInt(String(raw), 10);
      if (Number.isInteger(parsed) && parsed >= 0) base = parsed;
    }
  }
  if (!Number.isInteger(base) || base < 0) return null;
  return base + (bound.plus ?? 0);
}

function isValidBound(bound: unknown): boolean {
  if (typeof bound === 'number') return Number.isInteger(bound) && bound >= 0;
  if (typeof bound === 'object' && bound !== null) {
    const b = bound as { env?: unknown; default?: unknown; plus?: unknown };
    if (b.env !== undefined && typeof b.env !== 'string') return false;
    if (!(typeof b.default === 'number' && Number.isInteger(b.default) && b.default >= 0)) return false;
    if (b.plus !== undefined && !(typeof b.plus === 'number' && Number.isInteger(b.plus) && b.plus >= 0)) return false;
    return true;
  }
  return false;
}

/**
 * Validate a parsed graph document. Returns the list of problems (empty = valid). Checks:
 * structure/version/entry, node shape, edge targets, budget references, event keys, a mandatory
 * `*` default per node, and CYCLE BOUNDEDNESS — every cycle must contain at least one
 * budget-counted edge or enter a max_visits-bounded node, so the engine can never loop forever.
 */
export function validatePipelineGraph(raw: unknown): string[] {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['graph document must be a JSON object'];
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) errors.push(`unsupported version ${JSON.stringify(doc.version)} (expected 1)`);
  const nodesRaw = doc.nodes;
  if (typeof nodesRaw !== 'object' || nodesRaw === null || Array.isArray(nodesRaw) || Object.keys(nodesRaw).length === 0) {
    errors.push('graph must define a non-empty "nodes" object');
    return errors;
  }
  const nodes = nodesRaw as Record<string, unknown>;
  const budgets = (typeof doc.budgets === 'object' && doc.budgets !== null && !Array.isArray(doc.budgets)
    ? (doc.budgets as Record<string, unknown>)
    : {});
  for (const [name, b] of Object.entries(budgets)) {
    if (typeof b !== 'object' || b === null) {
      errors.push(`budget "${name}" must be an object`);
      continue;
    }
    const bd = b as { max?: unknown; on_exhausted?: unknown };
    if (!isValidBound(bd.max)) errors.push(`budget "${name}" has an invalid "max" bound`);
    if (bd.on_exhausted !== undefined && !isGraphTerminal(String(bd.on_exhausted))) {
      errors.push(`budget "${name}" on_exhausted must be one of ${GRAPH_TERMINALS.join(', ')}`);
    }
  }
  if (typeof doc.entry !== 'string' || !(doc.entry in nodes)) {
    errors.push(`entry ${JSON.stringify(doc.entry)} is not a defined node`);
  }

  for (const [id, nRaw] of Object.entries(nodes)) {
    if (id.startsWith('__')) {
      errors.push(`node id "${id}" must not start with "__" (reserved for terminals)`);
      continue;
    }
    if (typeof nRaw !== 'object' || nRaw === null) {
      errors.push(`node "${id}" must be an object`);
      continue;
    }
    const n = nRaw as Record<string, unknown>;
    if (typeof n.role !== 'string' || n.role.trim() === '') {
      errors.push(`node "${id}" must declare a non-empty "role"`);
    }
    if (n.verdict_source !== undefined && n.verdict_source !== 'acceptance') {
      errors.push(`node "${id}" verdict_source must be "acceptance" when present`);
    }
    if (n.max_visits !== undefined && !isValidBound(n.max_visits)) {
      errors.push(`node "${id}" has an invalid "max_visits" bound`);
    }
    const on = n.on;
    if (typeof on !== 'object' || on === null || Array.isArray(on)) {
      errors.push(`node "${id}" must define an "on" transition map`);
      continue;
    }
    const onMap = on as Record<string, unknown>;
    if (!('*' in onMap)) errors.push(`node "${id}" must define a "*" default transition`);
    for (const [event, edgeRaw] of Object.entries(onMap)) {
      if (!(GRAPH_EVENTS as readonly string[]).includes(event)) {
        errors.push(`node "${id}" has unknown event key "${event}"`);
      }
      const edge = typeof edgeRaw === 'string' ? { to: edgeRaw } : (edgeRaw as { to?: unknown; counts?: unknown });
      if (typeof edge !== 'object' || edge === null || typeof edge.to !== 'string') {
        errors.push(`node "${id}" event "${event}" must map to a target string or {to, counts?}`);
        continue;
      }
      const target = edge.to;
      if (!(target in nodes) && !isGraphTerminal(target)) {
        errors.push(`node "${id}" event "${event}" targets unknown node/terminal "${target}"`);
      }
      if (edge.counts !== undefined && !(typeof edge.counts === 'string' && edge.counts in budgets)) {
        errors.push(`node "${id}" event "${event}" counts unknown budget "${String(edge.counts)}"`);
      }
    }
  }
  if (errors.length > 0) return errors;

  // Boundedness: drop budget-counted edges and edges entering max_visits-bounded nodes, then any
  // remaining cycle among role nodes is unbounded → invalid.
  const typed = doc as unknown as PipelineGraph;
  const residual = new Map<string, string[]>();
  for (const [id, node] of Object.entries(typed.nodes)) {
    const targets: string[] = [];
    for (const edgeRaw of Object.values(node.on)) {
      const edge = normalizeEdge(edgeRaw);
      if (isGraphTerminal(edge.to)) continue;
      if (edge.counts) continue; // bounded by a finite budget
      if (typed.nodes[edge.to]?.max_visits !== undefined) continue; // bounded by max_visits
      targets.push(edge.to);
    }
    residual.set(id, targets);
  }
  const color = new Map<string, 'gray' | 'black'>();
  const visit = (id: string, trail: string[]): void => {
    color.set(id, 'gray');
    for (const next of residual.get(id) ?? []) {
      const c = color.get(next);
      if (c === 'gray') {
        errors.push(`unbounded cycle detected: ${[...trail, id, next].join(' → ')} (add a budget-counted edge or max_visits)`);
        continue;
      }
      if (c !== 'black') visit(next, [...trail, id]);
    }
    color.set(id, 'black');
  };
  for (const id of Object.keys(typed.nodes)) {
    if (!color.has(id)) visit(id, []);
  }
  return errors;
}

/** Load + validate a graph file. Any read/parse/validation problem → graph undefined + errors. */
export function loadPipelineGraph(filePath: string = DEFAULT_GRAPH_PATH): {
  graph?: PipelineGraph;
  errors: string[];
} {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { errors: [`cannot read graph file ${filePath}: ${(err as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { errors: [`invalid JSON in ${filePath}: ${(err as Error).message}`] };
  }
  const errors = validatePipelineGraph(raw);
  if (errors.length > 0) return { errors };
  return { graph: raw as PipelineGraph, errors: [] };
}

/** Normalize a raw `## Next Action` string to a known token (null when absent/unknown/NONE). */
export function normalizeNextAction(raw: string | undefined | null): NextActionToken | null {
  const token = (raw ?? '').trim().toUpperCase();
  return (NEXT_ACTION_TOKENS as readonly string[]).includes(token) ? (token as NextActionToken) : null;
}

/**
 * Compute the transition event for a node from the parsed report verdicts. Mirrors the serial
 * run_auto.sh gates: on an acceptance-verdict node, FAIL wins over any Next Action, PASS proceeds
 * unless the Next Action is a human-stop, and a missing verdict falls back to the Next Action
 * (flagged with a warning).
 */
export function computeGraphEvent(
  node: GraphNode,
  nextAction: string | undefined | null,
  acceptanceVerdict?: string | null,
): { event: string; warning?: string } {
  const na = normalizeNextAction(nextAction);
  if (node.verdict_source === 'acceptance') {
    const verdict = (acceptanceVerdict ?? '').trim().toUpperCase();
    if (verdict === 'FAIL') return { event: 'ACCEPTANCE_FAIL' };
    if (verdict === 'PASS') {
      if (na === 'NEEDS_USER_INPUT' || na === 'BLOCKED') return { event: na };
      return { event: 'ACCEPTANCE_PASS' };
    }
    return {
      event: na ?? 'NONE',
      warning: 'no machine-readable "## Acceptance: PASS|FAIL" verdict → falling back to Next Action',
    };
  }
  return { event: na ?? 'NONE' };
}

/** Initialize run state at the graph entry (entry counts as visited once). */
export function beginPipelineGraph(graph: PipelineGraph): PipelineGraphState {
  return { current: graph.entry, visits: { [graph.entry]: 1 }, budgets: {}, history: [] };
}

/**
 * Resolve one transition from the current node given the role's report verdicts. Mutates `state`
 * (current node, visit counts, budget spend, history) and returns either the next role node or a
 * terminal. Budget exhaustion and max_visits overrun both map to a terminal (default __stop__ =
 * PIPELINE_STOP / needs attention) WITHOUT dispatching the target node again — the same boundary
 * behavior as the serial `debug_cycles < MAX` check.
 */
export function stepPipelineGraph(
  graph: PipelineGraph,
  state: PipelineGraphState,
  nextAction: string | undefined | null,
  acceptanceVerdict?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): GraphStepResult {
  const node = graph.nodes[state.current];
  if (!node) {
    return { kind: 'terminal', terminal: 'stop', event: 'NONE', reason: `unknown current node "${state.current}"` };
  }
  const { event, warning } = computeGraphEvent(node, nextAction, acceptanceVerdict);
  const edgeRaw = node.on[event] ?? node.on['*'];
  if (edgeRaw === undefined) {
    return { kind: 'terminal', terminal: 'stop', event, warning, reason: `node "${state.current}" has no transition for event "${event}"` };
  }
  const edge = normalizeEdge(edgeRaw);
  if (edge.counts) {
    const budget = graph.budgets?.[edge.counts];
    const max = resolveBound(budget?.max, env) ?? 0;
    const spent = state.budgets[edge.counts] ?? 0;
    if (spent >= max) {
      const terminal = terminalName(budget?.on_exhausted ?? '__stop__');
      return {
        kind: 'terminal', terminal, event, warning,
        reason: `budget "${edge.counts}" exhausted (${spent}/${max}) at "${state.current}" on ${event}`,
      };
    }
    state.budgets[edge.counts] = spent + 1;
  }
  state.history.push({ from: state.current, event, to: edge.to });
  if (isGraphTerminal(edge.to)) {
    const from = state.current;
    state.current = edge.to;
    return { kind: 'terminal', terminal: terminalName(edge.to), event, warning, reason: `"${from}" → ${edge.to} on ${event}` };
  }
  const visits = (state.visits[edge.to] ?? 0) + 1;
  const maxVisits = resolveBound(graph.nodes[edge.to].max_visits, env);
  if (maxVisits !== null && visits > maxVisits) {
    return {
      kind: 'terminal', terminal: 'stop', event, warning,
      reason: `max_visits exceeded for "${edge.to}" (visit ${visits} > ${maxVisits})`,
    };
  }
  state.visits[edge.to] = visits;
  state.current = edge.to;
  return { kind: 'node', node: edge.to, role: graph.nodes[edge.to].role, event, warning };
}

/** Read a state file written by writePipelineGraphState. Throws on missing/corrupt state. */
export function readPipelineGraphState(filePath: string): PipelineGraphState {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PipelineGraphState;
  if (typeof raw !== 'object' || raw === null || typeof raw.current !== 'string') {
    throw new Error(`corrupt pipeline graph state in ${filePath}`);
  }
  return {
    current: raw.current,
    visits: raw.visits ?? {},
    budgets: raw.budgets ?? {},
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

/** Atomically persist run state (tmp + rename) so a killed run never leaves a torn file. */
export function writePipelineGraphState(filePath: string, state: PipelineGraphState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

/** Walk the all-READY (and ACCEPTANCE_PASS) happy path and return the visited role order. */
export function happyPathRoles(graph: PipelineGraph, env: NodeJS.ProcessEnv = {}): string[] {
  const state = beginPipelineGraph(graph);
  const roles: string[] = [graph.nodes[graph.entry].role];
  for (let i = 0; i < Object.keys(graph.nodes).length + 1; i += 1) {
    const node = graph.nodes[state.current];
    const verdict = node.verdict_source === 'acceptance' ? 'PASS' : undefined;
    const res = stepPipelineGraph(graph, state, 'READY_FOR_REVIEW', verdict, env);
    if (res.kind === 'terminal') break;
    roles.push(res.role);
  }
  return roles;
}
