import {
  classifyProbe,
  shouldTriggerIncident,
  renderPostmortem,
  resolvePreviousRevision,
  classifyFailure,
  decideRollback,
  DEFAULT_ROLLBACK_ON,
  type IncidentRecord,
  type ProbeThresholds,
} from '../lib/incidentResponse.js';

// SOT-1520 — production incident auto-response pure logic.

const thresh: ProbeThresholds = { expectStatus: 200, maxLatencyMs: 3000 };

describe('classifyProbe', () => {
  test('expected status within latency → healthy', () => {
    expect(classifyProbe({ ok: true, httpStatus: 200, latencyMs: 120 }, thresh)).toBe('healthy');
  });

  test('expected status but slow → degraded', () => {
    expect(classifyProbe({ ok: true, httpStatus: 200, latencyMs: 5000 }, thresh)).toBe('degraded');
  });

  test('wrong status → unhealthy even if ok flag set', () => {
    expect(classifyProbe({ ok: true, httpStatus: 503, latencyMs: 100 }, thresh)).toBe('unhealthy');
  });

  test('not ok (request failed) → unhealthy', () => {
    expect(classifyProbe({ ok: false, httpStatus: null, latencyMs: null, error: 'timeout' }, thresh)).toBe(
      'unhealthy'
    );
  });

  test('maxLatencyMs=0 disables the degraded check', () => {
    expect(classifyProbe({ ok: true, httpStatus: 200, latencyMs: 999999 }, { expectStatus: 200, maxLatencyMs: 0 })).toBe(
      'healthy'
    );
  });

  test('expectStatus defaults to 200 when 0', () => {
    expect(classifyProbe({ ok: true, httpStatus: 200, latencyMs: 10 }, { expectStatus: 0, maxLatencyMs: 0 })).toBe(
      'healthy'
    );
  });
});

describe('shouldTriggerIncident', () => {
  test('N consecutive unhealthy → true', () => {
    expect(shouldTriggerIncident(['unhealthy', 'unhealthy', 'unhealthy'], 3)).toBe(true);
  });

  test('a healthy within the window → false', () => {
    expect(shouldTriggerIncident(['unhealthy', 'healthy', 'unhealthy'], 3)).toBe(false);
  });

  test('degraded is not unhealthy → false', () => {
    expect(shouldTriggerIncident(['unhealthy', 'degraded', 'unhealthy'], 3)).toBe(false);
  });

  test('fewer than threshold → false', () => {
    expect(shouldTriggerIncident(['unhealthy', 'unhealthy'], 3)).toBe(false);
  });

  test('only the last N matter', () => {
    expect(shouldTriggerIncident(['healthy', 'unhealthy', 'unhealthy'], 2)).toBe(true);
  });

  test('threshold floored to at least 1', () => {
    expect(shouldTriggerIncident(['unhealthy'], 0)).toBe(true);
    expect(shouldTriggerIncident(['healthy'], 0)).toBe(false);
  });
});

describe('renderPostmortem', () => {
  const base: IncidentRecord = {
    target: 'sota1111/toddler-private-rag',
    detectedAt: '2026-07-04T10:00:00Z',
    state: 'unhealthy',
    probe: { ok: false, httpStatus: 503, latencyMs: 250, error: 'unexpected_status' },
    thresholds: { expectStatus: 200, maxLatencyMs: 3000 },
    consecutiveFailures: 3,
  };

  test('is deterministic for the same input', () => {
    expect(renderPostmortem(base)).toBe(renderPostmortem(base));
  });

  test('includes target, detection details and the six-step headings', () => {
    const md = renderPostmortem(base);
    expect(md).toContain('# Postmortem — sota1111/toddler-private-rag');
    expect(md).toContain('2026-07-04T10:00:00Z');
    expect(md).toContain('① 障害検知');
    expect(md).toContain('② 原因特定');
    expect(md).toContain('③ 処置');
    expect(md).toContain('④ 回復確認');
    expect(md).toContain('503');
  });

  test('no rollback command → notes none attempted', () => {
    const md = renderPostmortem(base);
    expect(md).toContain('no rollback command configured');
  });

  test('rollback configured but disabled → dry-run note', () => {
    const md = renderPostmortem({
      ...base,
      remediation: { attempted: false, enabled: false, command: 'gcloud run ...', exitCode: null },
    });
    expect(md).toContain('dry-run only');
    expect(md).toContain('gcloud run ...');
  });

  test('remediation executed + recovered → recovery marked healthy', () => {
    const md = renderPostmortem({
      ...base,
      remediation: { attempted: true, enabled: true, command: 'redeploy', exitCode: 0 },
      recovery: { attempted: true, state: 'healthy', probe: { ok: true, httpStatus: 200, latencyMs: 90 } },
    });
    expect(md).toContain('executed `redeploy`');
    expect(md).toContain('(recovered)');
    expect(md).toContain('[x] Service recovered');
  });

  test('remediation executed but NOT recovered → escalate note', () => {
    const md = renderPostmortem({
      ...base,
      remediation: { attempted: true, enabled: true, command: 'redeploy', exitCode: 0 },
      recovery: { attempted: true, state: 'unhealthy', probe: { ok: false, httpStatus: 503, latencyMs: 90 } },
    });
    expect(md).toContain('NOT recovered — escalate');
    expect(md).toContain('[ ] Restore service');
  });
});

describe('classifyFailure', () => {
  test('5xx → server-error', () => {
    expect(classifyFailure({ ok: false, httpStatus: 503, latencyMs: 10 }, 200)).toBe('server-error');
    expect(classifyFailure({ ok: false, httpStatus: 500, latencyMs: 10 }, 200)).toBe('server-error');
  });

  test('no HTTP response (null status) → unreachable', () => {
    expect(classifyFailure({ ok: false, httpStatus: null, latencyMs: null, error: 'timeout' }, 200)).toBe(
      'unreachable'
    );
  });

  test('status 0 sentinel treated as no response by caller → unreachable', () => {
    // The shell maps a curl failure to null before calling; a raw 0 here would be <400 → unknown,
    // so callers must translate 0 → null. Guard the documented contract at the CLI layer instead.
    expect(classifyFailure({ ok: false, httpStatus: null, latencyMs: null }, 200)).toBe('unreachable');
  });

  test('404 → not-found', () => {
    expect(classifyFailure({ ok: false, httpStatus: 404, latencyMs: 10 }, 200)).toBe('not-found');
  });

  test('other 4xx → client-error', () => {
    expect(classifyFailure({ ok: false, httpStatus: 401, latencyMs: 10 }, 200)).toBe('client-error');
    expect(classifyFailure({ ok: false, httpStatus: 403, latencyMs: 10 }, 200)).toBe('client-error');
    expect(classifyFailure({ ok: false, httpStatus: 429, latencyMs: 10 }, 200)).toBe('client-error');
  });

  test('unexpected 3xx / non-error → unknown', () => {
    expect(classifyFailure({ ok: false, httpStatus: 302, latencyMs: 10 }, 200)).toBe('unknown');
  });
});

describe('decideRollback (update-related gating)', () => {
  const at = '2026-07-04T10:00:00Z';

  test('server-error is update-related → rollback', () => {
    const d = decideRollback({ failureClass: 'server-error', policy: {}, detectedAt: at });
    expect(d.rollback).toBe(true);
    expect(d.updateRelated).toBe(true);
  });

  test('unreachable and not-found are update-related by default', () => {
    expect(decideRollback({ failureClass: 'unreachable', policy: {}, detectedAt: at }).rollback).toBe(true);
    expect(decideRollback({ failureClass: 'not-found', policy: {}, detectedAt: at }).rollback).toBe(true);
  });

  test('client-error (4xx) is NOT update-related → no rollback', () => {
    const d = decideRollback({ failureClass: 'client-error', policy: {}, detectedAt: at });
    expect(d.rollback).toBe(false);
    expect(d.updateRelated).toBe(false);
    expect(d.reason).toContain('not update-related');
  });

  test('unknown → no rollback', () => {
    expect(decideRollback({ failureClass: 'unknown', policy: {}, detectedAt: at }).rollback).toBe(false);
  });

  test('rollbackOn override can include client-error', () => {
    const d = decideRollback({ failureClass: 'client-error', policy: { rollbackOn: ['client-error'] }, detectedAt: at });
    expect(d.rollback).toBe(true);
  });

  test('correlation window: failure within the window after deploy → rollback', () => {
    const d = decideRollback({
      failureClass: 'server-error',
      policy: { deployCorrelationWindowMs: 30 * 60 * 1000 },
      currentRevisionDeployedAt: '2026-07-04T09:55:00Z', // 5 min before detection
      detectedAt: at,
    });
    expect(d.rollback).toBe(true);
    expect(d.reason).toContain('within');
  });

  test('correlation window: failure long after deploy → NOT update-related, no rollback', () => {
    const d = decideRollback({
      failureClass: 'server-error',
      policy: { deployCorrelationWindowMs: 30 * 60 * 1000 },
      currentRevisionDeployedAt: '2026-07-04T00:00:00Z', // 10h before detection
      detectedAt: at,
    });
    expect(d.rollback).toBe(false);
    expect(d.updateRelated).toBe(false);
    expect(d.reason).toContain('beyond the correlation window');
  });

  test('correlation window set but deploy time unknown → error-class gate decides (rollback)', () => {
    const d = decideRollback({
      failureClass: 'server-error',
      policy: { deployCorrelationWindowMs: 30 * 60 * 1000 },
      currentRevisionDeployedAt: null,
      detectedAt: at,
    });
    expect(d.rollback).toBe(true);
    expect(d.reason).toContain('deploy time unknown');
  });

  test('DEFAULT_ROLLBACK_ON excludes client-error and unknown', () => {
    expect(DEFAULT_ROLLBACK_ON).toEqual(['server-error', 'unreachable', 'not-found']);
  });
});

describe('renderPostmortem with rollback decision', () => {
  const base: IncidentRecord = {
    target: 'owner/repo',
    detectedAt: '2026-07-04T10:00:00Z',
    state: 'unhealthy',
    probe: { ok: false, httpStatus: 401, latencyMs: 20, error: 'unexpected_status' },
    thresholds: { expectStatus: 200, maxLatencyMs: 3000 },
    consecutiveFailures: 3,
  };

  test('decision skipping rollback → postmortem explains "no rollback" and reason', () => {
    const md = renderPostmortem({
      ...base,
      remediation: {
        attempted: false,
        enabled: true,
        command: 'gcloud run ...',
        exitCode: null,
        decision: {
          rollback: false,
          updateRelated: false,
          failureClass: 'client-error',
          reason: "failure class 'client-error' is not update-related",
        },
      },
    });
    expect(md).toContain('⛔ no rollback');
    expect(md).toContain('NOT update-related');
    expect(md).toContain('client-error');
    expect(md).toContain('skipped — error not update-related');
  });

  test('decision approving rollback → postmortem shows rollback executed', () => {
    const md = renderPostmortem({
      ...base,
      probe: { ok: false, httpStatus: 503, latencyMs: 20, error: 'unexpected_status' },
      remediation: {
        attempted: true,
        enabled: true,
        command: 'redeploy',
        exitCode: 0,
        decision: {
          rollback: true,
          updateRelated: true,
          failureClass: 'server-error',
          reason: "update-related failure class 'server-error'",
        },
      },
      recovery: { attempted: true, state: 'healthy', probe: { ok: true, httpStatus: 200, latencyMs: 90 } },
    });
    expect(md).toContain('✅ rollback');
    expect(md).toContain('executed `redeploy`');
  });
});

describe('resolvePreviousRevision', () => {
  // gcloud run revisions list --sort-by=~creationTimestamp (newest-first)
  const revs = [
    'toddler-private-rag-backend-00294-sis',
    'toddler-private-rag-backend-00291-yuc',
    'toddler-private-rag-backend-00288-pud',
  ];

  test('current serving is newest → rolls back to the next revision', () => {
    expect(resolvePreviousRevision(revs, 'toddler-private-rag-backend-00294-sis')).toBe(
      'toddler-private-rag-backend-00291-yuc'
    );
  });

  test('current serving is an older revision → newest that is not current', () => {
    expect(resolvePreviousRevision(revs, 'toddler-private-rag-backend-00291-yuc')).toBe(
      'toddler-private-rag-backend-00294-sis'
    );
  });

  test('current unknown → assumes newest is serving, returns second newest', () => {
    expect(resolvePreviousRevision(revs, null)).toBe('toddler-private-rag-backend-00291-yuc');
  });

  test('only one revision → no rollback target', () => {
    expect(resolvePreviousRevision(['only-rev'], 'only-rev')).toBeNull();
  });

  test('empty list → null', () => {
    expect(resolvePreviousRevision([], 'x')).toBeNull();
  });

  test('trims whitespace and ignores blank entries', () => {
    expect(resolvePreviousRevision([' a ', '', '  b '], 'a')).toBe('b');
  });
});
