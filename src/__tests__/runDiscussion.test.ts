// SOT-1753: unit tests for scripts/ai/run_discussion.sh — the deterministic dispatcher layer of
// discussion mode. The worker CLIs are replaced by stub run scripts (DISCUSSION_SCRIPT_DIR) so the
// script's own logic is what is under test: round progression, the DISCUSSION_MAX_ROUNDS cap,
// script-side convergence (all AGREE in one round), usage-limit (exit 75) fallback to the remaining
// participant + moderator, the bounded single retry, and the gate-compatible result report.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'ai', 'run_discussion.sh');
const LANE = `testdisc${process.pid}`;

// Lane-suffixed prompt/report files the script (and stubs) write under the repo — cleaned up after.
const LANE_FILES = [
  path.join(REPO, 'prompts', 'codex', `debug.${LANE}.md`),
  path.join(REPO, 'prompts', 'claude', `worker.${LANE}.md`),
  path.join(REPO, 'prompts', 'antigravity', `implement.${LANE}.md`),
  path.join(REPO, 'docs', 'ai', `60_worker_codex_report.${LANE}.md`),
  path.join(REPO, 'docs', 'ai', `55_worker_claude_report.${LANE}.md`),
  path.join(REPO, 'docs', 'ai', `50_worker_antigravity_report.${LANE}.md`),
];

let tmpDir: string;

const AGREE_REPORT = `## Position
X is the right answer because it is simplest.

## Rebuttal
none

## Stance: AGREE

## Conclusion
Adopt X.

## Next Action: READY_FOR_REVIEW
`;

const DISAGREE_REPORT = `## Position
Y is better.

## Rebuttal
X ignores the edge cases.

## Stance: DISAGREE

## Conclusion
Adopt Y.

## Next Action: READY_FOR_REVIEW
`;

const VERDICT_REPORT = `## Verdict
Take Z: it combines X's simplicity with Y's edge-case coverage.

## Next Action: READY_FOR_REVIEW
`;

function writeStub(name: string, body: string): void {
  const p = path.join(tmpDir, 'stubs', name);
  fs.writeFileSync(
    p,
    `#!/usr/bin/env bash
set -eu
echo "\${WORKER_SELECTED}:\${DISCUSSION_ROUND}" >> "\${CALL_LOG}"
${body}
`,
    { mode: 0o755 },
  );
}

function reportHeredoc(report: string): string {
  return `cat > "\${DISCUSSION_REPORT_FILE}" <<'REPORT_EOF'\n${report}REPORT_EOF\nexit 0`;
}

function runDiscussion(
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      DISCUSSION_SCRIPT_DIR: path.join(tmpDir, 'stubs'),
      DISCUSSION_THREAD_DIR: path.join(tmpDir, 'threads'),
      DISCUSSION_OUT_DIR: path.join(tmpDir, 'out'),
      DISCUSSION_LANE: LANE,
      CALL_LOG: path.join(tmpDir, 'calls.log'),
      ...env,
    },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function calls(): string[] {
  const p = path.join(tmpDir, 'calls.log');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function readOut(issue: string): string {
  return fs.readFileSync(path.join(tmpDir, 'out', `discussion_${issue}.md`), 'utf8');
}

function readThread(issue: string): string {
  return fs.readFileSync(path.join(tmpDir, 'threads', `${issue}.md`), 'utf8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-discussion-test-'));
  fs.mkdirSync(path.join(tmpDir, 'stubs'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of LANE_FILES) fs.rmSync(f, { force: true });
});

describe('run_discussion.sh', () => {
  test('both participants AGREE in round 1 → consensus, one utterance each', () => {
    writeStub('run_codex.sh', reportHeredoc(AGREE_REPORT));
    writeStub('run_claude.sh', reportHeredoc(AGREE_REPORT));

    const res = runDiscussion(['--issue', 'TEST-CONS', '--topic', 'which answer?']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('DISCUSSION_CONSENSUS round=1');
    expect(calls()).toEqual(['codex:1', 'claude:1']);

    const out = readOut('TEST-CONS');
    expect(out).toContain('Outcome: CONSENSUS (all participants AGREE in round 1)');
    expect(out).toContain('Adopt X.');
    expect(out).toContain('## Next Action: READY_FOR_REVIEW');

    const thread = readThread('TEST-CONS');
    expect(thread).toContain('which answer?');
    expect(thread).toContain('## Round 1 — codex:sol');
    expect(thread).toContain('## Round 1 — claude:fable');
  });

  test('no consensus → stops exactly at DISCUSSION_MAX_ROUNDS, then the moderator rules', () => {
    writeStub('run_codex.sh', reportHeredoc(DISAGREE_REPORT));
    writeStub(
      'run_claude.sh',
      `if [ "\${DISCUSSION_ROUND}" = "moderator" ]; then
${reportHeredoc(VERDICT_REPORT)}
else
${reportHeredoc(DISAGREE_REPORT)}
fi`,
    );

    const res = runDiscussion(['--issue', 'TEST-VERD', '--topic', 'which answer?'], {
      DISCUSSION_MAX_ROUNDS: '2',
    });
    expect(res.status).toBe(0);
    // Round cap respected: 2 participants × 2 rounds, then exactly one moderator call.
    expect(calls()).toEqual(['codex:1', 'claude:1', 'codex:2', 'claude:2', 'claude:moderator']);

    const out = readOut('TEST-VERD');
    expect(out).toContain('Rounds completed: 2 / max 2');
    expect(out).toContain('Outcome: VERDICT (moderator claude:fable ruled after no consensus)');
    expect(out).toContain('Take Z');
    expect(out).toContain('## Next Action: READY_FOR_REVIEW');
    expect(readThread('TEST-VERD')).toContain('## Moderator — claude:fable');
  });

  test('usage-limit exit 75 drops the participant (no retry) and falls back to the moderator', () => {
    writeStub('run_codex.sh', 'exit 75');
    writeStub(
      'run_claude.sh',
      `if [ "\${DISCUSSION_ROUND}" = "moderator" ]; then
${reportHeredoc(VERDICT_REPORT)}
else
${reportHeredoc(AGREE_REPORT)}
fi`,
    );

    const res = runDiscussion(['--issue', 'TEST-DROP', '--topic', 'which answer?']);
    expect(res.status).toBe(0);
    // codex once (75 → no retry), the surviving participant once, then the moderator.
    expect(calls()).toEqual(['codex:1', 'claude:1', 'claude:moderator']);

    const out = readOut('TEST-DROP');
    expect(out).toContain('Dropped participants: codex:sol');
    expect(out).toContain('Outcome: VERDICT');
    expect(out).toContain('## Next Action: READY_FOR_REVIEW');
  });

  test('an invalid utterance is retried exactly once, then the discussion continues', () => {
    // First codex call emits a report with no ## Position / ## Stance; the retry is valid.
    writeStub(
      'run_codex.sh',
      `if [ -f "\${CALL_LOG}.codex-once" ]; then
${reportHeredoc(AGREE_REPORT)}
else
touch "\${CALL_LOG}.codex-once"
printf 'garbage without stance\\n## Next Action: READY_FOR_REVIEW\\n' > "\${DISCUSSION_REPORT_FILE}"
exit 0
fi`,
    );
    writeStub('run_claude.sh', reportHeredoc(AGREE_REPORT));

    const res = runDiscussion(['--issue', 'TEST-RETRY', '--topic', 'which answer?']);
    expect(res.status).toBe(0);
    expect(calls()).toEqual(['codex:1', 'codex:1', 'claude:1']);
    expect(readOut('TEST-RETRY')).toContain('Outcome: CONSENSUS');
  });

  test('moderator also unavailable → EXHAUSTED, ## Next Action: BLOCKED, exit 75', () => {
    writeStub('run_codex.sh', 'exit 75');
    writeStub('run_claude.sh', 'exit 75');

    const res = runDiscussion(['--issue', 'TEST-EXH', '--topic', 'which answer?']);
    expect(res.status).toBe(75);

    const out = readOut('TEST-EXH');
    expect(out).toContain('Outcome: EXHAUSTED');
    expect(out).toContain('## Next Action: BLOCKED');
  });

  test('--dry-run prints the resolved configuration without invoking any worker', () => {
    writeStub('run_codex.sh', 'exit 1');
    writeStub('run_claude.sh', 'exit 1');

    const res = runDiscussion(['--issue', 'TEST-DRY', '--topic', 'which answer?', '--dry-run']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('participants=[codex:sol, claude:fable]');
    expect(calls()).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'threads', 'TEST-DRY.md'))).toBe(false);
  });

  test('fewer than 2 participants is a usage error (exit 2)', () => {
    const res = runDiscussion(['--issue', 'TEST-ONE', '--topic', 'which answer?'], {
      DISCUSSION_PARTICIPANTS: 'codex:sol',
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('need at least 2 participants');
  });
});
