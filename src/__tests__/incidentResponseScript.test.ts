import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// SOT-1520 — incident_response.sh orchestrator behavior (best-effort, default-OFF).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ai', 'incident_response.sh');

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A probe hook that always reports the given result line.
const HEALTHY_PROBE = 'echo "1 200 100"';
const UNHEALTHY_PROBE = 'echo "0 503 80 unexpected_status"';

describe('incident_response.sh', () => {
  test('bad usage (no args) exits 2', () => {
    const r = run([]);
    expect(r.status).toBe(2);
  });

  test('disabled by default (INCIDENT_RESPONSE_ENABLED unset) → skip, exit 0', () => {
    const r = run(['owner/repo'], { INCIDENT_RESPONSE_ENABLED: '' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('disabled');
    expect(r.stdout).toContain('skipping');
  });

  test('enabled but no health URL / probe → skip, exit 0', () => {
    const r = run(['definitely-not-configured'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_HEALTH_URL: '',
      INCIDENT_PROBE_CMD: '',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('no health URL configured');
  });

  test('healthy probes → no action, exit 0, no postmortem', () => {
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_PROBE_CMD: HEALTHY_PROBE,
      INCIDENT_FAILURE_THRESHOLD: '2',
      INCIDENT_PROBE_ATTEMPTS: '2',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('healthy');
    expect(r.stdout).toContain('no action');
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  test('slow-but-OK probes → degraded, monitoring only, no incident', () => {
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_PROBE_CMD: 'echo "1 200 9000"',
      INCIDENT_MAX_LATENCY_MS: '3000',
      INCIDENT_FAILURE_THRESHOLD: '2',
      INCIDENT_PROBE_ATTEMPTS: '2',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('degraded');
    expect(r.stdout).toContain('monitoring only');
    expect(fs.readdirSync(tmpDir).length).toBe(0);
  });

  test('unhealthy probes, no rollback cmd → incident confirmed + postmortem written, exit 0', () => {
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_PROBE_CMD: UNHEALTHY_PROBE,
      INCIDENT_ROLLBACK_CMD: '',
      INCIDENT_FAILURE_THRESHOLD: '2',
      INCIDENT_PROBE_ATTEMPTS: '2',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('INCIDENT confirmed');
    expect(r.stdout).toContain('no rollback command configured');
    expect(r.stdout).toContain('postmortem written');
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);
    const md = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    expect(md).toContain('# Postmortem — owner/repo');
    expect(md).toContain('① 障害検知');
  });

  test('unhealthy + rollback cmd but auto-remediate OFF → dry-run, command NOT executed', () => {
    const marker = path.join(tmpDir, 'ran.marker');
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_AUTO_REMEDIATE: '',
      INCIDENT_PROBE_CMD: UNHEALTHY_PROBE,
      INCIDENT_ROLLBACK_CMD: `touch ${marker}`,
      INCIDENT_FAILURE_THRESHOLD: '1',
      INCIDENT_PROBE_ATTEMPTS: '1',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('auto-remediation disabled');
    expect(r.stdout).toContain('would run');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('unhealthy + rollback cmd + auto-remediate ON → command executed + recovery re-probed', () => {
    const marker = path.join(tmpDir, 'ran.marker');
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_AUTO_REMEDIATE: '1',
      INCIDENT_PROBE_CMD: UNHEALTHY_PROBE,
      INCIDENT_ROLLBACK_CMD: `touch ${marker}`,
      INCIDENT_FAILURE_THRESHOLD: '1',
      INCIDENT_PROBE_ATTEMPTS: '1',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('remediating');
    expect(r.stdout).toContain('recovery probe');
    expect(fs.existsSync(marker)).toBe(true);
  });

  // SOT-1520 REOPEN#4 — limit rollback to update-related errors.
  const CLIENT_ERROR_PROBE = 'echo "0 401 30 unexpected_status"'; // 4xx = not update-related

  test('4xx client error + auto-remediate ON → rollback SKIPPED (not update-related)', () => {
    const marker = path.join(tmpDir, 'ran.marker');
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_AUTO_REMEDIATE: '1',
      INCIDENT_PROBE_CMD: CLIENT_ERROR_PROBE,
      INCIDENT_ROLLBACK_CMD: `touch ${marker}`,
      INCIDENT_FAILURE_THRESHOLD: '1',
      INCIDENT_PROBE_ATTEMPTS: '1',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('class=client-error');
    expect(r.stdout).toContain('not rolling back');
    expect(fs.existsSync(marker)).toBe(false); // rollback command must NOT have run
    // postmortem still written and records the no-rollback decision
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(1);
    const md = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    expect(md).toContain('⛔ no rollback');
  });

  test('5xx server error + auto-remediate ON → rollback EXECUTED (update-related)', () => {
    const marker = path.join(tmpDir, 'ran.marker');
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_AUTO_REMEDIATE: '1',
      INCIDENT_PROBE_CMD: UNHEALTHY_PROBE, // 503
      INCIDENT_ROLLBACK_CMD: `touch ${marker}`,
      INCIDENT_FAILURE_THRESHOLD: '1',
      INCIDENT_PROBE_ATTEMPTS: '1',
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('class=server-error');
    expect(r.stdout).toContain('remediating');
    expect(fs.existsSync(marker)).toBe(true);
  });

  test('correlation window: 5xx long after deploy → rollback SKIPPED (not update-related)', () => {
    const marker = path.join(tmpDir, 'ran.marker');
    const r = run(['owner/repo'], {
      INCIDENT_RESPONSE_ENABLED: '1',
      INCIDENT_AUTO_REMEDIATE: '1',
      INCIDENT_PROBE_CMD: UNHEALTHY_PROBE, // 503 server-error (class-eligible)
      INCIDENT_ROLLBACK_CMD: `touch ${marker}`,
      INCIDENT_FAILURE_THRESHOLD: '1',
      INCIDENT_PROBE_ATTEMPTS: '1',
      INCIDENT_DEPLOY_CORRELATION_WINDOW_MS: '60000', // 1 min window
      INCIDENT_CURRENT_REVISION_DEPLOYED_AT: '2000-01-01T00:00:00Z', // long ago
      INCIDENT_DIR: tmpDir,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not rolling back');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
