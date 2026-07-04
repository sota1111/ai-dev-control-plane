import {
  classifyProbe,
  shouldTriggerIncident,
  renderPostmortem,
  resolvePreviousRevision,
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
