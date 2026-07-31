import {
  parseWorkerRoleDirectives,
  mergeWorkerRoleOverrides,
  parseGraphDirective,
  parseReasoningDirectives,
} from '../lib/workerRoleDirective.js';
import type { WorkerRoleConfig } from '../lib/workerRoles.js';

describe('parseGraphDirective', () => {
  test('newest graph directive wins', () => {
    expect(parseGraphDirective('graph: default\ntext\ngraph: plan-with-discussion')).toBe('plan-with-discussion');
  });
  test('ignores embedded and malformed directives', () => {
    expect(parseGraphDirective('Use graph: unsafe\ngraph: ../../unsafe')).toBeUndefined();
  });
});

describe('parseReasoningDirectives', () => {
  test('parses role-specific levels and newest value wins', () => {
    expect(parseReasoningDirectives(
      'reasoning: task-check=high\nreasoning: task-check=ultra, decomposition=max'
    ).reasoning).toEqual({ 'task-check': 'ultra', decomposition: 'max' });
  });

  test('supports reasoning for a solo issue', () => {
    expect(parseReasoningDirectives('reasoning: solo=ultra').reasoning).toEqual({ solo: 'ultra' });
  });

  test('rejects unknown roles and levels', () => {
    const parsed = parseReasoningDirectives('reasoning: deploy=ultra, implementation=extreme');
    expect(parsed.reasoning).toEqual({});
    expect(parsed.warnings).toHaveLength(2);
  });
});

const BASE: WorkerRoleConfig = {
  'task-check': ['codex', 'claude', 'antigravity'],
  decomposition: ['claude', 'codex', 'antigravity'],
  implementation: ['antigravity', 'codex', 'claude'],
  verification: ['codex', 'claude', 'antigravity'],
  acceptance: ['claude', 'codex', 'antigravity'],
  github: ['claude', 'codex', 'antigravity'],
  'linear-report': ['claude', 'codex', 'antigravity'],
};

describe('parseWorkerRoleDirectives', () => {
  test('parses a single-line directive with multiple roles', () => {
    const { overrides, warnings } = parseWorkerRoleDirectives(
      'Some description.\nworkers: implementation=codex, verification=claude\nmore text',
    );
    expect(overrides).toEqual({ implementation: ['codex'], verification: ['claude'] });
    expect(warnings).toEqual([]);
  });

  test('accepts `worker:` singular and is case-insensitive for keys/values', () => {
    const { overrides } = parseWorkerRoleDirectives('WORKER: Implementation=CODEX');
    expect(overrides).toEqual({ implementation: ['codex'] });
  });

  test('supports fallback chains via > | /', () => {
    const { overrides } = parseWorkerRoleDirectives(
      'workers: implementation=codex>claude, github=antigravity|codex, task-check=codex/claude',
    );
    expect(overrides.implementation).toEqual(['codex', 'claude']);
    expect(overrides.github).toEqual(['antigravity', 'codex']);
    expect(overrides['task-check']).toEqual(['codex', 'claude']);
  });

  test('maps the `agy` alias to antigravity and de-dupes a chain', () => {
    const { overrides } = parseWorkerRoleDirectives('workers: implementation=agy>agy>codex');
    expect(overrides.implementation).toEqual(['antigravity', 'codex']);
  });

  test('later directive (e.g. a newer comment) wins for the same role', () => {
    const text = ['workers: implementation=antigravity', 'workers: implementation=codex'].join('\n');
    expect(parseWorkerRoleDirectives(text).overrides).toEqual({ implementation: ['codex'] });
  });

  test('warns and skips unknown roles / workers, keeping valid ones', () => {
    const { overrides, warnings } = parseWorkerRoleDirectives(
      'workers: implementation=codex, deploy=codex, verification=gpt5',
    );
    expect(overrides).toEqual({ implementation: ['codex'] });
    expect(warnings.some((w) => w.includes('unknown role "deploy"'))).toBe(true);
    expect(warnings.some((w) => w.includes('unknown worker "gpt5"'))).toBe(true);
  });

  test('returns empty for no directive / empty input', () => {
    expect(parseWorkerRoleDirectives('just a normal description').overrides).toEqual({});
    expect(parseWorkerRoleDirectives('').overrides).toEqual({});
    expect(parseWorkerRoleDirectives(null).overrides).toEqual({});
  });

  // SOT-1583: `worker:model` model pins.
  test('model-less syntax stays fully backward compatible (empty models map)', () => {
    const { overrides, models, warnings } = parseWorkerRoleDirectives(
      'workers: implementation=codex, verification=claude',
    );
    expect(overrides).toEqual({ implementation: ['codex'], verification: ['claude'] });
    expect(models).toEqual({});
    expect(warnings).toEqual([]);
  });

  test('parses worker:model tokens into overrides + models', () => {
    const { overrides, models, warnings } = parseWorkerRoleDirectives(
      'workers: implementation=codex:gpt-5.5, verification=claude:sonnet',
    );
    expect(overrides).toEqual({ implementation: ['codex'], verification: ['claude'] });
    expect(models).toEqual({
      implementation: { codex: 'gpt-5.5' },
      verification: { claude: 'sonnet' },
    });
    expect(warnings).toEqual([]);
  });

  test('each element of a fallback chain can carry its own model', () => {
    const { overrides, models } = parseWorkerRoleDirectives(
      'workers: verification=claude:sonnet>codex:gpt-5.4-mini',
    );
    expect(overrides.verification).toEqual(['claude', 'codex']);
    expect(models.verification).toEqual({ claude: 'sonnet', codex: 'gpt-5.4-mini' });
  });

  test('keeps model ids that contain spaces/parens/dots verbatim (first colon splits)', () => {
    const { models } = parseWorkerRoleDirectives(
      'workers: implementation=agy:Gemini 3.5 Flash (High), github=claude:claude-sonnet-5',
    );
    expect(models.implementation).toEqual({ antigravity: 'Gemini 3.5 Flash (High)' });
    expect(models.github).toEqual({ claude: 'claude-sonnet-5' });
  });

  test('an empty model (worker:) warns and falls back to default (no pin)', () => {
    const { overrides, models, warnings } = parseWorkerRoleDirectives('workers: implementation=codex:');
    expect(overrides).toEqual({ implementation: ['codex'] });
    expect(models).toEqual({});
    expect(warnings.some((w) => w.includes('empty model for worker "codex"'))).toBe(true);
  });

  test('a newer model-less directive clears an earlier model pin for the same role', () => {
    const text = ['workers: implementation=codex:gpt-5.5', 'workers: implementation=codex'].join('\n');
    const { overrides, models } = parseWorkerRoleDirectives(text);
    expect(overrides).toEqual({ implementation: ['codex'] });
    expect(models).toEqual({});
  });

  // SOT-1591: per-issue solo override.
  test('solo=<worker> sets a solo override (no role chain)', () => {
    const { solo, overrides } = parseWorkerRoleDirectives('workers: solo=codex');
    expect(solo).toEqual({ disabled: false, worker: 'codex', model: null });
    expect(overrides).toEqual({});
  });

  test('solo=<worker>:<model> pins a model on the solo worker', () => {
    expect(parseWorkerRoleDirectives('workers: solo=claude:sonnet').solo).toEqual({
      disabled: false, worker: 'claude', model: 'sonnet',
    });
  });

  test('the agy alias resolves to antigravity for solo', () => {
    expect(parseWorkerRoleDirectives('workers: solo=agy').solo).toEqual({
      disabled: false, worker: 'antigravity', model: null,
    });
  });

  test.each(['off', 'OFF', 'none', 'false', '0'])('solo=%s disables solo for the issue', (val) => {
    expect(parseWorkerRoleDirectives(`workers: solo=${val}`).solo).toEqual({ disabled: true });
  });

  test('solo combines with role overrides on the same line', () => {
    const { solo, overrides } = parseWorkerRoleDirectives('workers: solo=off, implementation=codex');
    expect(solo).toEqual({ disabled: true });
    expect(overrides).toEqual({ implementation: ['codex'] });
  });

  test('an unknown solo worker is ignored with a warning (solo stays undefined)', () => {
    const { solo, warnings } = parseWorkerRoleDirectives('workers: solo=bogus');
    expect(solo).toBeUndefined();
    expect(warnings.some((w) => w.includes('unknown worker "bogus" for solo'))).toBe(true);
  });

  test('the newest solo directive wins (description then comments, oldest→newest)', () => {
    const text = ['workers: solo=claude', 'workers: solo=off', 'workers: solo=codex'].join('\n');
    expect(parseWorkerRoleDirectives(text).solo).toEqual({ disabled: false, worker: 'codex', model: null });
  });

  test('no solo token → solo is undefined (inherit base __solo__)', () => {
    expect(parseWorkerRoleDirectives('workers: implementation=codex').solo).toBeUndefined();
  });

  test.each(['on', 'true', 'yes', '1', 'allow'])('handoff=%s allows worker handoff', (value) => {
    expect(parseWorkerRoleDirectives(`workers: handoff=${value}`).handoff).toBe(true);
  });

  test.each(['off', 'false', 'no', '0', 'deny'])('handoff=%s disables worker handoff', (value) => {
    expect(parseWorkerRoleDirectives(`workers: handoff=${value}`).handoff).toBe(false);
  });

  test('the newest handoff directive wins and combines with role overrides', () => {
    const parsed = parseWorkerRoleDirectives('workers: handoff=off\nworkers: implementation=codex>claude, handoff=on');
    expect(parsed.handoff).toBe(true);
    expect(parsed.overrides.implementation).toEqual(['codex', 'claude']);
  });

  test('invalid handoff values are ignored with a warning', () => {
    const { handoff, warnings } = parseWorkerRoleDirectives('workers: handoff=maybe');
    expect(handoff).toBeUndefined();
    expect(warnings.some((w) => w.includes('invalid handoff value'))).toBe(true);
  });

  test('discussion=codex:sol+claude:fable parses the participant list with models (SOT-1753)', () => {
    const { discussion, warnings } = parseWorkerRoleDirectives(
      'workers: discussion=codex:sol+claude:fable',
    );
    expect(discussion).toEqual([
      { worker: 'codex', model: 'sol' },
      { worker: 'claude', model: 'fable' },
    ]);
    expect(warnings).toEqual([]);
  });

  test('discussion participants accept model-less tokens and the agy alias', () => {
    const { discussion } = parseWorkerRoleDirectives('workers: discussion=codex+agy:Gemini 3.5 Flash (High)');
    expect(discussion).toEqual([
      { worker: 'codex', model: null },
      { worker: 'antigravity', model: 'Gemini 3.5 Flash (High)' },
    ]);
  });

  test('discussion combines with role overrides on the same line and the newest occurrence wins', () => {
    const parsed = parseWorkerRoleDirectives(
      'workers: discussion=codex+claude, implementation=codex\nworkers: discussion=claude:fable+codex:sol',
    );
    expect(parsed.discussion).toEqual([
      { worker: 'claude', model: 'fable' },
      { worker: 'codex', model: 'sol' },
    ]);
    expect(parsed.overrides.implementation).toEqual(['codex']);
  });

  test('unknown discussion workers are skipped with a warning; valid ones are kept', () => {
    const { discussion, warnings } = parseWorkerRoleDirectives('workers: discussion=gemini+codex:sol');
    expect(discussion).toEqual([{ worker: 'codex', model: 'sol' }]);
    expect(warnings.some((w) => w.includes('unknown worker "gemini" for discussion'))).toBe(true);
  });

  test('a discussion token with no valid participant is ignored with a warning', () => {
    const { discussion, warnings } = parseWorkerRoleDirectives('workers: discussion=gemini');
    expect(discussion).toBeUndefined();
    expect(warnings.some((w) => w.includes('no valid participant specified for discussion'))).toBe(true);
  });

  test('no discussion token → discussion is undefined (existing syntax unaffected)', () => {
    const parsed = parseWorkerRoleDirectives('workers: implementation=codex>claude, solo=off');
    expect(parsed.discussion).toBeUndefined();
    expect(parsed.overrides.implementation).toEqual(['codex', 'claude']);
    expect(parsed.solo).toEqual({ disabled: true });
  });
});

describe('mergeWorkerRoleOverrides', () => {
  test('replaces only the overridden roles, keeping base chains for the rest', () => {
    const merged = mergeWorkerRoleOverrides(BASE, {
      implementation: ['codex'],
      github: ['antigravity', 'claude'],
    });
    expect(merged.implementation).toEqual(['codex']);
    expect(merged.github).toEqual(['antigravity', 'claude']);
    // untouched roles keep the base chain
    expect(merged['task-check']).toEqual(['codex', 'claude', 'antigravity']);
    expect(merged.verification).toEqual(['codex', 'claude', 'antigravity']);
  });

  test('does not mutate the base config', () => {
    const baseCopy = JSON.parse(JSON.stringify(BASE));
    mergeWorkerRoleOverrides(BASE, { implementation: ['codex'] });
    expect(BASE).toEqual(baseCopy);
  });

  test('an empty override map yields a config equal to the base', () => {
    expect(mergeWorkerRoleOverrides(BASE, {})).toEqual(BASE);
  });
});
