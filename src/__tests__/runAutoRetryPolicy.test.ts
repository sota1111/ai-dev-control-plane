import fs from 'node:fs';
import path from 'node:path';

describe('run_auto incomplete-dispatch retry policy (SOT-1928)', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'scripts/ai/run_auto.sh'), 'utf8');

  test('fails retryably before taking a lock when repository routing is unresolved', () => {
    const routingGate = script.indexOf('REPO_RESOLUTION_UNAVAILABLE:');
    const lockOpen = script.indexOf('exec 9>"$LOCK_FILE"');
    expect(routingGate).toBeGreaterThan(-1);
    expect(lockOpen).toBeGreaterThan(routingGate);
    expect(script).toMatch(/RUNNER_REPO_RESOLUTION_ERROR[\s\S]*?exit 71/);
  });
  const linearReportPrompt = fs.readFileSync(
    path.join(process.cwd(), 'prompts/roles/linear-report.md'),
    'utf8',
  );

  test('solo dispatch without a report is retryable for every exit code', () => {
    expect(script).toMatch(
      /finalizeRun\(\)[\s\S]*?if \[ "\$rc" -ne 0 \] \|\| \[ -z "\$report" \] \|\| \[ ! -f "\$report" \]; then[\s\S]*?return "\$WORKER_UNAVAILABLE"/,
    );
    expect(script).toContain('finalizeRun "solo" "$src" "$sreport" || return $?');
  });

  test('solo NEEDS_DEBUG is automatically retried instead of recorded as human wait', () => {
    expect(script).toMatch(
      /\[ "\$REPORT_NEXT_ACTION" = "NEEDS_DEBUG" \][\s\S]*?automatic retry[\s\S]*?return "\$WORKER_UNAVAILABLE"/,
    );
  });

  test('role dispatch without a report never becomes a human-review stop', () => {
    expect(script).toContain('finalizeRun "role" "$NODE_RC" "$NODE_REPORT" || return $?');
    expect(script.match(/PIPELINE_RETRY: .*dispatch rc=\$rc \(no report\)/g)).toHaveLength(1);
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
      /if \[ "\$REPORT_HAS_PR" -eq 1 \]; then[\s\S]*?\[ "\$REPORT_ACCEPTANCE" = "PASS" \][\s\S]*?return "\$COMPLETION_UNVERIFIED"/,
    );
  });

  test('solo PR results cannot complete without a posted Linear report', () => {
    expect(script).toMatch(
      /\[ -n "\$REPORT_LINEAR_POSTED" \][\s\S]*?lacks Linear Report POSTED[\s\S]*?return "\$COMPLETION_UNVERIFIED"/,
    );
    expect(linearReportPrompt).toContain('## Linear Report: POSTED');
  });

  test('node execution, report parsing, and finalization are each centralized', () => {
    expect(script.match(/^executeNode\(\)/gm)).toHaveLength(1);
    expect(script.match(/^parsePipelineReport\(\)/gm)).toHaveLength(1);
    expect(script.match(/^finalizeRun\(\)/gm)).toHaveLength(1);
    expect(script).toContain('[discussion]=execute_discussion_node');
    expect(script).not.toMatch(/if \[ "\$role" = "discussion" \]/);
  });
});
