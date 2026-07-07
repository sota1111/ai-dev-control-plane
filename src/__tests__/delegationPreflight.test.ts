import {
  buildDelegationPreflight,
  buildDelegationPreflightLines,
  type DelegationPreflightInput,
} from '../lib/delegationPreflight.js';
import type { WorkerRole, WorkerRoleConfig } from '../lib/workerRoles.js';

// SOT-1574 — delegation / cost preflight summary (pure formatter).

const ROLES: WorkerRole[] = [
  'task-check', 'implementation', 'verification', 'acceptance', 'github', 'linear-report',
];

// Default config = every role primary claude → codex → antigravity (SOT-1569).
function defaultConfig(): WorkerRoleConfig {
  const chain: ['claude', 'codex', 'antigravity'] = ['claude', 'codex', 'antigravity'];
  return {
    'task-check': [...chain],
    decomposition: [...chain],
    implementation: [...chain],
    verification: [...chain],
    acceptance: [...chain],
    github: [...chain],
    'linear-report': [...chain],
  };
}

function baseInput(overrides: Partial<DelegationPreflightInput> = {}): DelegationPreflightInput {
  return {
    issue: 'SOT-1574',
    roles: ROLES,
    config: defaultConfig(),
    baseConfig: defaultConfig(),
    maxDebugCycles: 2,
    ...overrides,
  };
}

describe('buildDelegationPreflight — delegation map', () => {
  test('lists each pipeline role with its primary worker and chain', () => {
    const out = buildDelegationPreflight(baseInput());
    for (const role of ROLES) {
      expect(out).toContain(role);
    }
    // primary + chain rendering
    expect(out).toContain('claude      [claude>codex>antigravity]');
    // header carries the issue id
    expect(out).toContain('Delegation / Cost Preflight (SOT-1574)');
  });

  test('no override → no (override) tag when resolved chain equals base', () => {
    const out = buildDelegationPreflight(baseInput());
    expect(out).not.toContain('(override)');
  });

  test('per-issue override → the changed role is tagged (override) and its primary reflects the override', () => {
    const config = defaultConfig();
    config.implementation = ['codex', 'claude']; // override implementation to codex-primary
    const out = buildDelegationPreflight(baseInput({ config }));
    const implLine = out.split('\n').find((l) => l.includes('implementation'))!;
    expect(implLine).toContain('codex');
    expect(implLine).toContain('(override)');
    // unchanged roles keep no override tag
    const taskLine = out.split('\n').find((l) => l.startsWith('  task-check'))!;
    expect(taskLine).not.toContain('(override)');
  });

  test('model pin is shown for the primary worker of a role', () => {
    const config = defaultConfig();
    config.implementation = ['codex', 'claude'];
    const out = buildDelegationPreflight(
      baseInput({ config, models: { implementation: { codex: 'gpt-5.5' } } }),
    );
    const implLine = out.split('\n').find((l) => l.includes('implementation'))!;
    expect(implLine).toContain('model=gpt-5.5');
  });
});

describe('buildDelegationPreflight — qualitative cost / usage', () => {
  test('counts Claude-primary roles and warns about N× shared-limit consumption', () => {
    const out = buildDelegationPreflight(baseInput());
    // all 6 roles are claude-primary in the default config
    expect(out).toContain('Claude primary roles: 6/6');
    expect(out).toContain('~6× faster');
  });

  test('fewer Claude-primary roles lowers the multiplier', () => {
    const config = defaultConfig();
    config.implementation = ['codex', 'claude'];
    config.verification = ['codex', 'claude'];
    const out = buildDelegationPreflight(baseInput({ config }));
    expect(out).toContain('Claude primary roles: 4/6');
    expect(out).toContain('~4× faster');
  });

  test('never emits a dollar figure', () => {
    const out = buildDelegationPreflight(baseInput());
    expect(out).not.toMatch(/\$\d/);
    expect(out.toLowerCase()).toContain('no dollar figures');
  });
});

describe('buildDelegationPreflight — cooldown / auth state', () => {
  test('no active cooldown/auth → all clear', () => {
    const out = buildDelegationPreflight(
      baseInput({
        cooldowns: [
          { worker: 'antigravity', active: false },
          { worker: 'codex', active: false },
          { worker: 'runner', active: false },
        ],
        authUnhealthy: { antigravity: { active: false }, codex: { active: false } },
      }),
    );
    expect(out).toContain('Worker availability: all clear');
  });

  test('active cooldown and auth-unhealthy are surfaced with remaining time', () => {
    const out = buildDelegationPreflight(
      baseInput({
        cooldowns: [
          { worker: 'antigravity', active: false },
          { worker: 'codex', active: true, remainingHuman: '2h 5m' },
          { worker: 'runner', active: false },
        ],
        authUnhealthy: {
          antigravity: { active: true, remainingSeconds: 1800 },
          codex: { active: false },
        },
      }),
    );
    expect(out).toContain('codex cooldown (2h 5m left)');
    expect(out).toContain('antigravity auth-unhealthy (1800s left)');
    expect(out).not.toContain('all clear');
  });
});

describe('buildDelegationPreflight — loop bound', () => {
  test('reports PIPELINE_MAX_DEBUG_CYCLES and an approximate max leg count', () => {
    const out = buildDelegationPreflight(baseInput({ maxDebugCycles: 2 }));
    // 6 roles + 2×3 debug loop-backs = 12
    expect(out).toContain('PIPELINE_MAX_DEBUG_CYCLES=2');
    expect(out).toContain('up to ~12 worker legs');
  });

  test('zero debug cycles → legs equal the role count', () => {
    const out = buildDelegationPreflight(baseInput({ maxDebugCycles: 0 }));
    expect(out).toContain('up to ~6 worker legs');
  });
});

describe('buildDelegationPreflightLines', () => {
  test('returns a bounded, non-empty block of lines without a log prefix', () => {
    const lines = buildDelegationPreflightLines(baseInput());
    expect(lines.length).toBeGreaterThan(0);
    // caller adds the [pipeline] prefix; the pure function must not
    expect(lines.every((l) => !l.startsWith('[pipeline]'))).toBe(true);
  });
});
