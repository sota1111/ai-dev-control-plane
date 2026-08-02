import fs from 'node:fs';
import path from 'node:path';

describe('solo role lifecycle safeguards (SOT-2127)', () => {
  const prompt = fs.readFileSync(path.join(process.cwd(), 'prompts/roles/solo.md'), 'utf8');
  const codex = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/run_codex.sh'), 'utf8');
  const claude = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/run_claude.sh'), 'utf8');
  const antigravity = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/run_antigravity.sh'), 'utf8');

  test('decomposition-only runs keep implementation children out of Done', () => {
    expect(prompt).toContain('newly-created implementation children remain `Todo`');
    expect(prompt).toContain('Never mark a child `Done`/completed during a decomposition-only run');
    expect(prompt).toContain('Only a later run that actually implements the child');
  });

  test('PR completion requires explicit acceptance evidence', () => {
    expect(prompt).toContain('incomplete unless the final report contains `## Acceptance: PASS`');
    expect(prompt).toContain('A PR URL or');
    expect(prompt).toContain('alone is not evidence');
  });

  test('implemented work requires a Linear completion comment', () => {
    expect(prompt).toContain('ALWAYS post a');
    expect(prompt).toContain('`## Completion Report` comment');
    expect(prompt).toContain('Only after the Linear comment succeeds');
    expect(prompt).toContain('`## Linear Report: POSTED`');
  });

  test('in-container solo permits tracked background work', () => {
    expect(prompt).toContain('background and long-lived commands are allowed');
    expect(prompt).toContain('Record their PID/log/output');
    expect(prompt).not.toContain('No background/long-lived processes');
  });

  test('long-running solo work must keep the session alive and emit its contract', () => {
    expect(prompt).toContain('Do not use `ScheduleWakeup`');
    expect(prompt).toContain('repeated bounded foreground polls');
    expect(prompt).toContain('Always emit `## Next Action`');
  });

  test('in-container solo bypasses worker and tool timeouts', () => {
    expect(codex).toContain('[ "${WORKER_ROLE:-}" = "solo" ] && timeout_prefix=()');
    const soloBranch = claude.slice(claude.indexOf('set +e'));
    expect(soloBranch).toContain('if [ "${WORKER_ROLE:-}" = "solo" ]; then');
    expect(soloBranch).toContain('\n  claude \\\n');
    expect(antigravity).toContain('[ "${WORKER_ROLE:-}" != "solo" ] && AGY_ARGS+=(--print-timeout');
    expect(antigravity).toContain('[ "${WORKER_ROLE:-}" = "solo" ] && timeout_prefix=()');
  });
});
