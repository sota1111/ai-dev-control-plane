import {
  explainExecutionPlan,
  isTruthyFlag,
  resolveExecutionPlan,
} from '../lib/executionPlan.js';

const DEFAULT = '/repo/config/pipeline_graph.json';

describe('resolveExecutionPlan', () => {
  test.each([
    {
      name: 'valid named issue graph overrides solo and environment',
      input: {
        graphDirective: 'plan-with-discussion',
        namedGraphPath: '/repo/config/graphs/plan-with-discussion.json',
        pipelineGraphEnabled: true,
        configuredGraphPath: '/tmp/custom.json',
        soloWorker: 'codex',
      },
      mode: 'graph',
      source: 'issue',
    },
    {
      name: 'invalid named graph warns and falls through to solo',
      input: {
        graphDirective: 'missing',
        namedGraphError: 'unknown graph "missing"',
        soloWorker: 'claude',
      },
      mode: 'solo',
      source: 'worker-config',
    },
    {
      name: 'solo overrides an environment-enabled default graph',
      input: { pipelineGraphEnabled: true, soloWorker: 'codex' },
      mode: 'solo',
      source: 'worker-config',
    },
    {
      name: 'enabled graph uses configured graph path',
      input: { pipelineGraphEnabled: true, configuredGraphPath: '/tmp/custom.json' },
      mode: 'graph',
      source: 'environment',
    },
    {
      name: 'enabled graph falls back to repository default',
      input: { pipelineGraphEnabled: true },
      mode: 'graph',
      source: 'environment',
    },
    {
      name: 'no selection preserves the legacy serial default',
      input: {},
      mode: 'serial',
      source: 'default',
    },
  ])('$name', ({ input, mode, source }) => {
    const plan = resolveExecutionPlan({ defaultGraphPath: DEFAULT, ...input });
    expect(plan.mode).toBe(mode);
    expect(plan.source).toBe(source);
  });

  test('default issue directive does not force graph mode', () => {
    expect(resolveExecutionPlan({
      defaultGraphPath: DEFAULT,
      graphDirective: 'default',
      soloWorker: 'codex',
    })).toMatchObject({ mode: 'solo', soloWorker: 'codex' });
  });

  test('explanation includes the decision and overridden candidates', () => {
    const plan = resolveExecutionPlan({
      defaultGraphPath: DEFAULT,
      graphDirective: 'discussion',
      namedGraphPath: '/repo/config/graphs/discussion.json',
      soloWorker: 'codex',
    });
    expect(explainExecutionPlan(plan)).toContain('reason: issue selected graph "discussion"');
    expect(explainExecutionPlan(plan)).toContain('worker-config solo=codex');
  });
});

describe('isTruthyFlag', () => {
  test.each(['1', 'true', 'TRUE', 'yes', 'on'])('accepts %s', (value) => {
    expect(isTruthyFlag(value)).toBe(true);
  });
  test.each([undefined, '', '0', 'false', 'off'])('rejects %s', (value) => {
    expect(isTruthyFlag(value)).toBe(false);
  });
});
