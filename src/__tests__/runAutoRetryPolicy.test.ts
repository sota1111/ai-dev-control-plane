import fs from 'node:fs';
import path from 'node:path';

describe('run_auto incomplete-dispatch retry policy (SOT-1928)', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/run_auto.sh'), 'utf8');

  test('solo dispatch without a report is retryable for every exit code', () => {
    expect(script).toMatch(
      /if \[ "\$src" -ne 0 \] \|\| \[ -z "\$sreport" \] \|\| \[ ! -f "\$sreport" \]; then[\s\S]*?PIPELINE_RETRY: solo dispatch rc=\$src \(no report\)[\s\S]*?return "\$WORKER_UNAVAILABLE"/,
    );
  });

  test('role dispatch without a report never becomes a human-review stop', () => {
    const incompleteRoleBlocks = script.match(
      /if \[ "\$rc" -ne 0 \] \|\| \[ -z "\$report" \] \|\| \[ ! -f "\$report" \]; then[\s\S]*?return "\$WORKER_UNAVAILABLE"/g,
    );

    expect(incompleteRoleBlocks).toHaveLength(1);
    for (const block of incompleteRoleBlocks ?? []) {
      expect(block).not.toContain('return "$COMPLETION_UNVERIFIED"');
    }
  });

  test('the graph is the only multi-role execution path', () => {
    expect(script).not.toContain('local roles=(task-check implementation verification acceptance github linear-report)');
    expect(script).not.toContain('PIPELINE_MODE');
    expect(script).not.toContain('legacy single Claude-orchestrator');
    expect(script).toContain('run_graph_role_loop "$issue" "$graph_state" "$graph_first" "$graph_run_id"');
  });

  test('invalid graphs stop instead of falling back to a compatibility loop', () => {
    expect(script).toMatch(
      /PIPELINE_STOP: graph unavailable\/invalid[\s\S]*?return "\$COMPLETION_UNVERIFIED"/,
    );
    expect(script).not.toContain('fail-open to the serial');
  });

  test('run_auto requires an issue and has no orchestrator tail', () => {
    expect(script).toContain('run_auto.sh requires --resume <issue> or WEBHOOK_ISSUE_ID');
    expect(script).not.toContain('claude \\\n  --model');
  });

  test('exit 71 bypasses the In Review loop-breaker', () => {
    expect(script).toMatch(
      /if \[ "\$EXIT_CODE" -eq "\$WORKER_UNAVAILABLE" \]; then[\s\S]*?skip ensure-issue-reviewed[\s\S]*?else[\s\S]*?run_cli ensure-issue-reviewed/,
    );
  });

  test('solo PR results cannot complete without explicit acceptance PASS', () => {
    expect(script).toMatch(
      /grep -qiE 'pull\/\[0-9\]\+\|PR\[ :\*\]\*#\[0-9\]\+' "\$sreport"[\s\S]*?if \[ "\$sacc" != "PASS" \]; then[\s\S]*?return "\$COMPLETION_UNVERIFIED"/,
    );
  });

  test('solo PR results cannot complete without a posted Linear report', () => {
    expect(script).toMatch(
      /slin(?:ear)?=.*Linear\[\[:space:\]\]\+Report:[\s\S]*?if \[ -z "\$slinear" \]; then[\s\S]*?lacks Linear Report POSTED[\s\S]*?return "\$COMPLETION_UNVERIFIED"/,
    );
  });
});
