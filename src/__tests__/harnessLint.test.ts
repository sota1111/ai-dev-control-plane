import {
  chainWorkers,
  checkConfigEnvKnobs,
  checkRemovedKnobResidue,
  checkRolesInReadme,
  checkRolesVsTable,
  checkShellEnvDocumented,
  checkWorkerNames,
  configRoleNames,
  envDeclarations,
  extractShellKnobs,
  hasFailures,
  lintHarness,
  parsePriorityChainTableRoles,
  type HarnessLintInputs,
} from '../lib/harnessLint.js';

const CLAUDE_TABLE = `
### Per-role priority chains (\`config/worker_roles.json\`)

Some prose describing the chains.

| Role | Default chain |
| --- | --- |
| \`task-check\` | \`["claude","codex","antigravity"]\` |
| \`implementation\` | \`["claude","codex","antigravity"]\` |
| \`github\` (branch/PR/merge) | \`["claude","codex","antigravity"]\` |
| \`linear-report\` (state sync/progress) | \`["claude","codex","antigravity"]\` |

Trailing prose after the table.
`;

/** A fully consistent, drift-free set of inputs. */
function consistentInputs(overrides: Partial<HarnessLintInputs> = {}): HarnessLintInputs {
  return {
    workerRoles: {
      __doc__: 'ignored',
      'task-check': ['claude', 'codex', 'antigravity'],
      implementation: ['claude', 'codex', 'antigravity'],
      github: ['claude', 'codex', 'antigravity'],
      'linear-report': 'claude',
    },
    configTexts: [],
    envExample: '',
    claudeMd: CLAUDE_TABLE,
    readme: 'roles: task-check / implementation / github / linear-report are dispatched.',
    shellScripts: [],
    ...overrides,
  };
}

describe('parsing helpers', () => {
  it('extracts role names from the CLAUDE.md priority-chain table, stripping parentheticals', () => {
    expect(parsePriorityChainTableRoles(CLAUDE_TABLE)).toEqual([
      'task-check',
      'implementation',
      'github',
      'linear-report',
    ]);
  });

  it('returns [] when the table is absent', () => {
    expect(parsePriorityChainTableRoles('no table here')).toEqual([]);
  });

  it('ignores __-prefixed keys and flattens bare-string chains', () => {
    const roles = { __doc__: 'x', a: ['claude', 'codex'], b: 'antigravity' };
    expect(configRoleNames(roles)).toEqual(['a', 'b']);
    expect(chainWorkers(roles)).toEqual([
      { role: 'a', worker: 'claude' },
      { role: 'a', worker: 'codex' },
      { role: 'b', worker: 'antigravity' },
    ]);
  });

  it('reads both active and commented env declarations', () => {
    const decls = envDeclarations('FOO=1\n# BAR=2\n#   BAZ=\nnot a var');
    expect(decls.has('FOO')).toBe(true);
    expect(decls.has('BAR')).toBe(true);
    expect(decls.has('BAZ')).toBe(true);
    expect(decls.has('not')).toBe(false);
  });

  it('extracts tunable shell knobs read with a default', () => {
    const knobs = extractShellKnobs('x=${INCIDENT_RESPONSE_ENABLED:-0}\ny=${PORT}\nz=${A:-1}');
    expect(knobs).toContain('INCIDENT_RESPONSE_ENABLED');
    // ${PORT} has no default and no underscore → not treated as a control knob here.
    expect(knobs).not.toContain('PORT');
    expect(knobs).not.toContain('A');
  });
});

describe('normal case — no drift', () => {
  it('produces no fail findings and exits clean', () => {
    const findings = lintHarness(consistentInputs());
    expect(findings.filter((f) => f.severity === 'fail')).toEqual([]);
    expect(hasFailures(findings)).toBe(false);
  });
});

describe('abnormal case — drift is detected (fail)', () => {
  it('fails when a config role is missing from the CLAUDE.md table', () => {
    const inputs = consistentInputs({
      workerRoles: {
        'task-check': ['claude'],
        implementation: ['claude'],
        github: ['claude'],
        'linear-report': ['claude'],
        acceptance: ['claude'], // not in the table
      },
    });
    const findings = checkRolesVsTable(inputs);
    expect(hasFailures(findings)).toBe(true);
    expect(findings.some((f) => f.message.includes('acceptance'))).toBe(true);
  });

  it('fails when the CLAUDE.md table has a role not defined in config', () => {
    const inputs = consistentInputs({
      workerRoles: { 'task-check': ['claude'], implementation: ['claude'], github: ['claude'] },
      // table still lists linear-report → drift
    });
    const findings = checkRolesVsTable(inputs);
    expect(findings.some((f) => f.severity === 'fail' && f.message.includes('linear-report'))).toBe(true);
  });

  it('fails when the priority-chain table cannot be found', () => {
    const findings = checkRolesVsTable(consistentInputs({ claudeMd: 'no table' }));
    expect(hasFailures(findings)).toBe(true);
  });

  it('fails on an unknown worker name in a chain', () => {
    const findings = checkWorkerNames(
      consistentInputs({ workerRoles: { 'task-check': ['claude', 'gpt'] } }),
    );
    expect(hasFailures(findings)).toBe(true);
    expect(findings[0].message).toContain('gpt');
  });
});

describe('warn-level checks (do not fail the build)', () => {
  it('warns — but does not fail — when a config env knob is missing from .env.example', () => {
    const inputs = consistentInputs({
      configTexts: [
        { name: 'incident_response.json', text: '{"__doc__":"gated by INCIDENT_RESPONSE_ENABLED"}' },
      ],
      envExample: 'PORT=3000\n',
    });
    const findings = checkConfigEnvKnobs(inputs);
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].message).toContain('INCIDENT_RESPONSE_ENABLED');
    expect(hasFailures(findings)).toBe(false);
  });

  it('does not warn when the config env knob is declared (even commented) in .env.example', () => {
    const inputs = consistentInputs({
      configTexts: [{ name: 'c.json', text: 'CODEX_DISABLED toggles the worker' }],
      envExample: '# CODEX_DISABLED=1\n',
    });
    expect(checkConfigEnvKnobs(inputs)).toEqual([]);
  });

  it('warns when a role is not mentioned in README', () => {
    const inputs = consistentInputs({ readme: 'only task-check and implementation here' });
    const findings = checkRolesInReadme(inputs);
    expect(findings.some((f) => f.message.includes('github'))).toBe(true);
    expect(findings.every((f) => f.severity === 'warn')).toBe(true);
  });

  it('warns on a removed knob mentioned without a removal note, but tolerates documented removal', () => {
    const residue = checkRemovedKnobResidue(
      consistentInputs({ claudeMd: 'set ALL_CLAUDE_MODE=1 to force claude' }),
    );
    expect(residue.some((f) => f.message.includes('ALL_CLAUDE_MODE'))).toBe(true);

    const documented = checkRemovedKnobResidue(
      consistentInputs({ claudeMd: 'ALL_CLAUDE_MODE and WORKER_MODE were removed' }),
    );
    expect(documented).toEqual([]);
  });

  it('warns on an undocumented control-toggle shell knob, and stays quiet for documented ones', () => {
    const undocumented = checkShellEnvDocumented(
      consistentInputs({ shellScripts: [{ name: 'run_auto.sh', text: 'v=${MYSTERY_FEATURE_ENABLED:-0}' }] }),
    );
    expect(undocumented.some((f) => f.message.includes('MYSTERY_FEATURE_ENABLED'))).toBe(true);
    expect(undocumented.every((f) => f.severity === 'warn')).toBe(true);

    const documented = checkShellEnvDocumented(
      consistentInputs({
        shellScripts: [{ name: 'run_auto.sh', text: 'v=${KNOWN_FEATURE_ENABLED:-0}' }],
        envExample: 'KNOWN_FEATURE_ENABLED=1\n',
      }),
    );
    expect(documented).toEqual([]);

    // Internal plumbing vars that are not enable/disable/mode toggles are NOT flagged (no over-detection).
    const plumbing = checkShellEnvDocumented(
      consistentInputs({ shellScripts: [{ name: 'run_worker.sh', text: 'v=${WORKER_PROMPT_FILE:-x}' }] }),
    );
    expect(plumbing).toEqual([]);
  });
});
