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

    // The graph and serial role pipelines must agree.
    expect(incompleteRoleBlocks).toHaveLength(2);
    for (const block of incompleteRoleBlocks ?? []) {
      expect(block).not.toContain('return "$COMPLETION_UNVERIFIED"');
    }
  });

  test('exit 71 bypasses the In Review loop-breaker', () => {
    expect(script).toMatch(
      /if \[ "\$EXIT_CODE" -eq "\$WORKER_UNAVAILABLE" \]; then[\s\S]*?skip ensure-issue-reviewed[\s\S]*?else[\s\S]*?run_cli ensure-issue-reviewed/,
    );
  });
});
