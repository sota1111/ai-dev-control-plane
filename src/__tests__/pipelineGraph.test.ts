import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GRAPH_PATH,
  beginPipelineGraph,
  computeGraphEvent,
  happyPathRoles,
  loadPipelineGraph,
  normalizeNextAction,
  openPipelineGraphCheckpoint,
  pipelineGraphId,
  readPipelineGraphState,
  resolveBound,
  stepPipelineGraph,
  validatePipelineGraph,
  writePipelineGraphState,
  type PipelineGraph,
  type PipelineGraphState,
} from '../lib/pipelineGraph.js';

// SOT-1754: the default graph must be a FAITHFUL copy of the serial run_auto.sh pipeline —
// same role order, same shared debug-cycle bound, same stop/no-op classifications.

const SERIAL_ROLE_ORDER = [
  'task-check',
  'implementation',
  'verification',
  'acceptance',
  'github',
  'linear-report',
];

function loadDefaultGraph(): PipelineGraph {
  const { graph, errors } = loadPipelineGraph(DEFAULT_GRAPH_PATH);
  expect(errors).toEqual([]);
  expect(graph).toBeDefined();
  return graph as PipelineGraph;
}

/** Drive the graph with a sequence of (nextAction, acceptanceVerdict?) role results. */
function drive(
  graph: PipelineGraph,
  state: PipelineGraphState,
  results: Array<[string, string?]>,
  env: NodeJS.ProcessEnv = {},
) {
  const steps = [];
  for (const [na, acc] of results) {
    const res = stepPipelineGraph(graph, state, na, acc, env);
    steps.push(res);
    if (res.kind === 'terminal') break;
  }
  return steps;
}

describe('resolveBound', () => {
  test('literal numbers and env-backed specs resolve to non-negative integers', () => {
    expect(resolveBound(3)).toBe(3);
    expect(resolveBound(undefined)).toBeNull();
    expect(resolveBound(-1)).toBeNull();
    expect(resolveBound({ default: 2 }, {})).toBe(2);
    expect(resolveBound({ env: 'X', default: 2 }, { X: '5' })).toBe(5);
    expect(resolveBound({ env: 'X', default: 2, plus: 1 }, { X: '4' })).toBe(5);
    expect(resolveBound({ env: 'X', default: 2 }, { X: 'garbage' })).toBe(2);
    expect(resolveBound({ env: 'X', default: 2 }, {})).toBe(2);
  });
});

describe('normalizeNextAction', () => {
  test('known tokens normalize case-insensitively; unknown/empty → null', () => {
    expect(normalizeNextAction('ready_for_review')).toBe('READY_FOR_REVIEW');
    expect(normalizeNextAction(' NEEDS_DEBUG ')).toBe('NEEDS_DEBUG');
    expect(normalizeNextAction('')).toBeNull();
    expect(normalizeNextAction(undefined)).toBeNull();
    expect(normalizeNextAction('SOMETHING_ELSE')).toBeNull();
  });
});

describe('default graph (config/pipeline_graph.json)', () => {
  test('loads and validates with no errors', () => {
    loadDefaultGraph();
  });

  test('happy path visits the exact serial role order then completes', () => {
    const graph = loadDefaultGraph();
    expect(happyPathRoles(graph)).toEqual(SERIAL_ROLE_ORDER);

    const state = beginPipelineGraph(graph);
    const steps = drive(graph, state, [
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW', 'PASS'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
    ]);
    const last = steps[steps.length - 1];
    expect(last).toMatchObject({ kind: 'terminal', terminal: 'done' });
  });

  test('task-check non-READY (decomposed / not-actionable / no token) → done_no_pr no-op', () => {
    const graph = loadDefaultGraph();
    for (const na of ['BLOCKED', 'NEEDS_USER_INPUT', 'NEEDS_DEBUG', '']) {
      const state = beginPipelineGraph(graph);
      const [res] = drive(graph, state, [[na]]);
      expect(res).toMatchObject({ kind: 'terminal', terminal: 'done_no_pr' });
    }
  });

  test('verification NEEDS_DEBUG loops back to implementation, bounded at 2 total cycles', () => {
    const graph = loadDefaultGraph();
    const state = beginPipelineGraph(graph);
    const steps = drive(graph, state, [
      ['READY_FOR_REVIEW'], // task-check → implementation
      ['READY_FOR_REVIEW'], // implementation → verification
      ['NEEDS_DEBUG'], // verification → implementation (cycle 1)
      ['READY_FOR_REVIEW'], // implementation → verification
      ['NEEDS_DEBUG'], // verification → implementation (cycle 2)
      ['READY_FOR_REVIEW'], // implementation → verification
      ['NEEDS_DEBUG'], // verification → budget exhausted → stop
    ]);
    expect(steps.map((s) => (s.kind === 'node' ? s.role : s.terminal))).toEqual([
      'implementation',
      'verification',
      'implementation',
      'verification',
      'implementation',
      'verification',
      'stop',
    ]);
    const last = steps[steps.length - 1];
    expect(last.kind).toBe('terminal');
    if (last.kind === 'terminal') expect(last.reason).toContain('budget "debug" exhausted (2/2)');
  });

  test('debug budget is SHARED across loop kinds (verification + acceptance), like debug_cycles', () => {
    const graph = loadDefaultGraph();
    const state = beginPipelineGraph(graph);
    const steps = drive(graph, state, [
      ['READY_FOR_REVIEW'], // task-check → implementation
      ['READY_FOR_REVIEW'], // implementation → verification
      ['NEEDS_DEBUG'], // verification → implementation (cycle 1)
      ['READY_FOR_REVIEW'], // implementation → verification
      ['READY_FOR_REVIEW'], // verification → acceptance
      ['READY_FOR_REVIEW', 'FAIL'], // acceptance FAIL → implementation (cycle 2)
      ['READY_FOR_REVIEW'], // implementation → verification
      ['NEEDS_DEBUG'], // verification → third loop-back refused → stop
    ]);
    const last = steps[steps.length - 1];
    expect(last).toMatchObject({ kind: 'terminal', terminal: 'stop' });
  });

  test('PIPELINE_MAX_DEBUG_CYCLES env raises/lowers the loop bound', () => {
    const graph = loadDefaultGraph();
    // 0 → first NEEDS_DEBUG stops immediately (matches serial `debug_cycles < MAX` gate)
    let state = beginPipelineGraph(graph);
    let steps = drive(graph, state, [['READY_FOR_REVIEW'], ['READY_FOR_REVIEW'], ['NEEDS_DEBUG']], {
      PIPELINE_MAX_DEBUG_CYCLES: '0',
    });
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'terminal', terminal: 'stop' });

    // 3 → three loop-backs succeed, the fourth stops
    state = beginPipelineGraph(graph);
    const env = { PIPELINE_MAX_DEBUG_CYCLES: '3' };
    steps = drive(
      graph,
      state,
      [
        ['READY_FOR_REVIEW'],
        ['READY_FOR_REVIEW'],
        ['NEEDS_DEBUG'],
        ['READY_FOR_REVIEW'],
        ['NEEDS_DEBUG'],
        ['READY_FOR_REVIEW'],
        ['NEEDS_DEBUG'],
        ['READY_FOR_REVIEW'],
        ['NEEDS_DEBUG'],
      ],
      env,
    );
    const kinds = steps.map((s) => (s.kind === 'node' ? s.role : s.terminal));
    expect(kinds.filter((k) => k === 'implementation')).toHaveLength(4); // initial + 3 loop-backs
    expect(kinds[kinds.length - 1]).toBe('stop');
  });

  test('acceptance verdict precedence mirrors the serial SOT-1558 gate', () => {
    const graph = loadDefaultGraph();
    const toAcceptance: Array<[string, string?]> = [
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
    ];

    // FAIL wins over READY_FOR_REVIEW → loops to implementation
    let state = beginPipelineGraph(graph);
    let steps = drive(graph, state, [...toAcceptance, ['READY_FOR_REVIEW', 'FAIL']]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'node', role: 'implementation' });

    // PASS + BLOCKED → human stop
    state = beginPipelineGraph(graph);
    steps = drive(graph, state, [...toAcceptance, ['BLOCKED', 'PASS']]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'terminal', terminal: 'stop' });

    // PASS + NEEDS_DEBUG → proceeds to github (serial: "PASS and not a human-stop → proceed")
    state = beginPipelineGraph(graph);
    steps = drive(graph, state, [...toAcceptance, ['NEEDS_DEBUG', 'PASS']]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'node', role: 'github' });

    // no verdict + READY → proceeds with a fallback warning
    state = beginPipelineGraph(graph);
    steps = drive(graph, state, [...toAcceptance, ['READY_FOR_REVIEW']]);
    const res = steps[steps.length - 1];
    expect(res).toMatchObject({ kind: 'node', role: 'github' });
    expect(res.warning).toContain('falling back to Next Action');

    // no verdict + NEEDS_DEBUG → loops to implementation (bounded)
    state = beginPipelineGraph(graph);
    steps = drive(graph, state, [...toAcceptance, ['NEEDS_DEBUG']]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'node', role: 'implementation' });
  });

  test('github / linear-report NEEDS_DEBUG re-runs verification and consumes the debug budget', () => {
    const graph = loadDefaultGraph();
    const state = beginPipelineGraph(graph);
    const steps = drive(graph, state, [
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW'],
      ['READY_FOR_REVIEW', 'PASS'],
      ['NEEDS_DEBUG'], // github → verification (cycle 1)
    ]);
    expect(steps[steps.length - 1]).toMatchObject({ kind: 'node', role: 'verification' });
    expect(state.budgets.debug).toBe(1);
  });

  test('non-READY stops at implementation / verification / github map to the stop terminal', () => {
    const graph = loadDefaultGraph();
    for (const [prefix, na] of [
      [[['READY_FOR_REVIEW']], 'BLOCKED'], // implementation BLOCKED
      [[['READY_FOR_REVIEW'], ['READY_FOR_REVIEW']], 'NEEDS_USER_INPUT'], // verification
      [[['READY_FOR_REVIEW'], ['READY_FOR_REVIEW'], ['READY_FOR_REVIEW'], ['READY_FOR_REVIEW', 'PASS']], ''], // github no token
    ] as Array<[Array<[string, string?]>, string]>) {
      const state = beginPipelineGraph(graph);
      const steps = drive(graph, state, [...prefix, [na]]);
      expect(steps[steps.length - 1]).toMatchObject({ kind: 'terminal', terminal: 'stop' });
    }
  });
});

describe('named discussion graph', () => {
  test('validates and uses the discussion report Next Action for its outgoing edge', () => {
    const graphPath = path.join(path.dirname(DEFAULT_GRAPH_PATH), 'graphs', 'plan-with-discussion.json');
    const { graph, errors } = loadPipelineGraph(graphPath);
    expect(errors).toEqual([]);
    const state = beginPipelineGraph(graph!);
    expect(stepPipelineGraph(graph!, state, 'READY_FOR_REVIEW', '')).toMatchObject({
      kind: 'node', node: 'discussion', role: 'discussion', event: 'READY_FOR_REVIEW',
    });
    expect(stepPipelineGraph(graph!, state, 'READY_FOR_REVIEW', '')).toMatchObject({
      kind: 'node', node: 'implementation', role: 'implementation', event: 'READY_FOR_REVIEW',
    });
  });
});

describe('validatePipelineGraph', () => {
  const minimal = () => ({
    version: 1,
    entry: 'a',
    nodes: {
      a: { role: 'task-check', on: { READY_FOR_REVIEW: '__done__', '*': '__stop__' } },
    },
  });

  test('accepts a minimal valid graph', () => {
    expect(validatePipelineGraph(minimal())).toEqual([]);
  });

  test('rejects non-object / wrong version / missing entry', () => {
    expect(validatePipelineGraph(null)).toHaveLength(1);
    expect(validatePipelineGraph({ ...minimal(), version: 2 }).join(' ')).toContain('version');
    expect(validatePipelineGraph({ ...minimal(), entry: 'missing' }).join(' ')).toContain('not a defined node');
  });

  test('rejects unknown edge targets, unknown events, and missing "*" default', () => {
    const g = minimal() as any;
    g.nodes.a.on.READY_FOR_REVIEW = 'nowhere';
    expect(validatePipelineGraph(g).join(' ')).toContain('unknown node/terminal');

    const g2 = minimal() as any;
    g2.nodes.a.on.WHATEVER = '__done__';
    expect(validatePipelineGraph(g2).join(' ')).toContain('unknown event key');

    const g3 = minimal() as any;
    delete g3.nodes.a.on['*'];
    expect(validatePipelineGraph(g3).join(' ')).toContain('"*" default');
  });

  test('rejects an edge counting an undefined budget', () => {
    const g = minimal() as any;
    g.nodes.a.on.READY_FOR_REVIEW = { to: '__done__', counts: 'nope' };
    expect(validatePipelineGraph(g).join(' ')).toContain('unknown budget');
  });

  test('rejects an unbounded cycle; accepts the same cycle when budget-counted or max_visits-bounded', () => {
    const cyclic = () => ({
      version: 1,
      entry: 'a',
      nodes: {
        a: { role: 'r1', on: { READY_FOR_REVIEW: 'b', '*': '__stop__' } },
        b: { role: 'r2', on: { NEEDS_DEBUG: 'a', '*': '__done__' } },
      },
    });
    expect(validatePipelineGraph(cyclic()).join(' ')).toContain('unbounded cycle');

    const budgeted = cyclic() as any;
    budgeted.budgets = { debug: { max: 2 } };
    budgeted.nodes.b.on.NEEDS_DEBUG = { to: 'a', counts: 'debug' };
    expect(validatePipelineGraph(budgeted)).toEqual([]);

    const capped = cyclic() as any;
    capped.nodes.a.max_visits = 3;
    expect(validatePipelineGraph(capped)).toEqual([]);
  });
});

describe('max_visits backstop', () => {
  test('entering a node beyond max_visits maps to the stop terminal', () => {
    const graph: PipelineGraph = {
      version: 1,
      entry: 'a',
      nodes: {
        a: { role: 'r1', max_visits: 2, on: { READY_FOR_REVIEW: 'a', '*': '__stop__' } },
      },
    };
    expect(validatePipelineGraph(graph)).toEqual([]);
    const state = beginPipelineGraph(graph);
    const first = stepPipelineGraph(graph, state, 'READY_FOR_REVIEW', undefined, {});
    expect(first).toMatchObject({ kind: 'node', node: 'a' });
    const second = stepPipelineGraph(graph, state, 'READY_FOR_REVIEW', undefined, {});
    expect(second).toMatchObject({ kind: 'terminal', terminal: 'stop' });
    if (second.kind === 'terminal') expect(second.reason).toContain('max_visits exceeded');
  });
});

describe('computeGraphEvent', () => {
  const plain = { role: 'x', on: {} };
  const acc = { role: 'acceptance', verdict_source: 'acceptance' as const, on: {} };

  test('plain nodes map the Next Action token (NONE when absent)', () => {
    expect(computeGraphEvent(plain, 'READY_FOR_REVIEW')).toEqual({ event: 'READY_FOR_REVIEW' });
    expect(computeGraphEvent(plain, '')).toEqual({ event: 'NONE' });
  });

  test('acceptance nodes apply FAIL > PASS(+human-stop) > fallback precedence', () => {
    expect(computeGraphEvent(acc, 'READY_FOR_REVIEW', 'FAIL').event).toBe('ACCEPTANCE_FAIL');
    expect(computeGraphEvent(acc, 'NEEDS_DEBUG', 'PASS').event).toBe('ACCEPTANCE_PASS');
    expect(computeGraphEvent(acc, 'BLOCKED', 'PASS').event).toBe('BLOCKED');
    expect(computeGraphEvent(acc, 'NEEDS_USER_INPUT', 'PASS').event).toBe('NEEDS_USER_INPUT');
    const fallback = computeGraphEvent(acc, 'READY_FOR_REVIEW', '');
    expect(fallback.event).toBe('READY_FOR_REVIEW');
    expect(fallback.warning).toBeDefined();
  });
});

describe('state file round-trip', () => {
  test('write + read preserves the run state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-graph-'));
    const file = path.join(dir, 'nested', 'state.json');
    const state: PipelineGraphState = {
      schemaVersion: 1,
      runId: 'run-1',
      issueId: 'SOT-2199',
      graphId: 'graph-1',
      current: 'verification',
      visits: { 'task-check': 1, implementation: 2, verification: 2 },
      budgets: { debug: 1 },
      history: [{ from: 'task-check', event: 'READY_FOR_REVIEW', to: 'implementation' }],
    };
    writePipelineGraphState(file, state);
    expect(readPipelineGraphState(file)).toEqual(state);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resume validates schema and run identity before accepting a checkpoint', () => {
    const graph = loadDefaultGraph();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-graph-resume-'));
    const file = path.join(dir, 'state.json');
    const identity = { runId: 'run-1', issueId: 'SOT-2199', graphId: pipelineGraphId(graph) };

    const created = openPipelineGraphCheckpoint(file, graph, identity, false);
    created.state.current = 'verification';
    writePipelineGraphState(file, created.state);
    expect(openPipelineGraphCheckpoint(file, graph, identity, true)).toMatchObject({
      resumed: true,
      state: { current: 'verification' },
    });
    expect(() =>
      openPipelineGraphCheckpoint(file, graph, { ...identity, issueId: 'SOT-OTHER' }, true),
    ).toThrow('issueId mismatch');

    fs.writeFileSync(file, JSON.stringify({ ...created.state, schemaVersion: 0 }), 'utf8');
    expect(() => openPipelineGraphCheckpoint(file, graph, identity, true)).toThrow(
      'incompatible pipeline graph checkpoint schema',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('loadPipelineGraph fail-open inputs', () => {
  test('missing file and invalid JSON return errors without throwing', () => {
    expect(loadPipelineGraph('/nonexistent/graph.json').errors.length).toBeGreaterThan(0);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-graph-'));
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{not json', 'utf8');
    expect(loadPipelineGraph(bad).errors.join(' ')).toContain('invalid JSON');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
