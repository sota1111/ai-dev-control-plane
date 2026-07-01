import { jest } from '@jest/globals';

const mockHttps = {
  request: jest.fn(),
};

const mockFs = {
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  appendFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
};

jest.unstable_mockModule('node:https', () => ({
  default: mockHttps,
  ...mockHttps,
}));

jest.unstable_mockModule('node:fs', () => ({
  default: mockFs,
  ...mockFs,
}));

const https = await import('node:https');
const fs = await import('node:fs');
const runner = await import('../runner.js');
const { installLinearHttpMock } = await import('../__test_helpers__/linearMock.js');
const { sanitizeLabelIds } = await import('../lib/linearApi.js');

describe('Linear Integration', () => {
  let linearMock;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LINEAR_API_KEY = 'test-api-key';
    linearMock = installLinearHttpMock();
    
    // Mock fs to prevent actual file writes
    fs.existsSync.mockReturnValue(true);
    fs.mkdirSync.mockReturnValue(undefined);
    fs.appendFileSync.mockReturnValue(undefined);
    fs.writeFileSync.mockReturnValue(undefined);
    fs.renameSync.mockReturnValue(undefined);
  });

  afterEach(() => {
    linearMock.restore();
  });

  describe('linearQuery', () => {
    it('executes a GraphQL query and returns data', async () => {
      const mockData = { issue: { id: '123', title: 'Test Issue' } };
      linearMock.enqueue({ data: mockData });

      const result = await runner.linearQuery('query { issue(id: "123") { id title } }');

      expect(result).toEqual(mockData);
      expect(linearMock.calls).toHaveLength(1);
      expect(linearMock.calls[0].headers.Authorization).toBe('test-api-key');
      expect(linearMock.calls[0].query).toContain('issue(id: "123")');
    });

    it('throws error when Linear returns GraphQL errors', async () => {
      linearMock.enqueue({ errors: [{ message: 'Something went wrong' }] });

      await expect(runner.linearQuery('{ issues { id } }'))
        .rejects.toThrow('Something went wrong');
    });

    it('throws error on non-2xx HTTP response', async () => {
      // SOT-1440: 5xx is now classified as a transient HTTP error. Disable retry here so this
      // stays a single-attempt "non-2xx throws" assertion.
      const origMax = process.env.LINEAR_RETRY_MAX;
      process.env.LINEAR_RETRY_MAX = '0';
      try {
        linearMock.enqueueRaw('Internal Server Error', 500);
        await expect(runner.linearQuery('{ issues { id } }'))
          .rejects.toThrow('Linear API HTTP 500');
      } finally {
        if (origMax === undefined) delete process.env.LINEAR_RETRY_MAX;
        else process.env.LINEAR_RETRY_MAX = origMax;
      }
    });

    it('throws error when LINEAR_API_KEY is missing', async () => {
      delete process.env.LINEAR_API_KEY;
      await expect(runner.linearQuery('{ issues { id } }'))
        .rejects.toThrow('LINEAR_API_KEY not set');
    });
  });

  describe('High-level runner functions', () => {
    it('postUsageLimitComment checks for duplicates and posts comment', async () => {
      const issueId = 'ISS-1';
      const uuid = 'uuid-123';
      const resetEpoch = 1623912000; // Some timestamp

      // 1. Get issue UUID
      linearMock.enqueue({ data: { issue: { id: uuid } } });
      // 2. Fetch existing comments (empty)
      linearMock.enqueue({ data: { issue: { comments: { nodes: [] } } } });
      // 3. Post comment
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      await runner.postUsageLimitComment(issueId, resetEpoch);

      expect(linearMock.calls).toHaveLength(3);
      
      // Check 3rd call (mutation)
      const lastCall = linearMock.calls[2];
      expect(lastCall.query).toContain('mutation');
      expect(lastCall.query).toContain('commentCreate');
      expect(lastCall.variables.issueId).toBe(uuid);
      expect(lastCall.variables.body).toContain('usage-limit: Next auto run:');
    });

    it('addUsageLimitLabel creates label if missing and adds to issue', async () => {
      const issueId = 'ISS-1';
      const uuid = 'uuid-123';
      const teamId = 'team-789';
      const labelId = 'label-456';

      // 1. Get issue details
      linearMock.enqueue({ data: { issue: { id: uuid, labelIds: [], team: { id: teamId } } } });
      // 2. Search for existing label (not found)
      linearMock.enqueue({ data: { issueLabels: { nodes: [] } } });
      // 3. Create label
      linearMock.enqueue({ data: { issueLabelCreate: { issueLabel: { id: labelId } } } });
      // 4. Update issue with label
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      await runner.addUsageLimitLabel(issueId);

      expect(linearMock.calls).toHaveLength(4);
      
      // Check label search
      expect(linearMock.calls[1].variables.filter).toBeUndefined(); // filter is in query string usually in this impl
      expect(linearMock.calls[1].query).toContain('issueLabels(filter: { name: { eq: "usage-limit" } })');

      // Check label creation
      expect(linearMock.calls[2].query).toContain('issueLabelCreate');
      expect(linearMock.calls[2].variables.name).toBe('usage-limit');
      expect(linearMock.calls[2].variables.teamId).toBe(teamId);

      // Check issue update
      expect(linearMock.calls[3].query).toContain('issueUpdate');
      expect(linearMock.calls[3].variables.labelIds).toContain(labelId);
    });

    // SOT-1438 / P3: reaper In Review exclusion at the query layer.
    it('fetchActiveIssues() default includes In Review and does not add a name exclusion', async () => {
      linearMock.enqueue({ data: { issues: { nodes: [
        { id: 'u1', identifier: 'ENG-1', state: { type: 'unstarted', name: 'Todo' } },
        { id: 'u2', identifier: 'ENG-2', state: { type: 'started', name: 'In Review' } },
      ] } } });

      const result = await runner.fetchActiveIssues(50);

      expect(linearMock.calls[0].query).not.toContain('nin');
      // No excludeHold → In Review is returned unchanged.
      expect(result.map((r) => r.identifier)).toEqual(['ENG-1', 'ENG-2']);
    });

    it('fetchActiveIssues(first, { excludeHold: true }) excludes In Review by query + JS filter', async () => {
      linearMock.enqueue({ data: { issues: { nodes: [
        { id: 'u1', identifier: 'ENG-1', state: { type: 'unstarted', name: 'Todo' } },
        { id: 'u2', identifier: 'ENG-2', state: { type: 'started', name: 'In Progress' } },
        // Server-side name filter would omit this, but include it to prove the JS backstop drops it too.
        { id: 'u3', identifier: 'ENG-3', state: { type: 'started', name: 'In Review' } },
      ] } } });

      const result = await runner.fetchActiveIssues(50, { excludeHold: true });

      // Query-level exclusion present.
      expect(linearMock.calls[0].query).toContain('name: { nin: ["In Review"] }');
      // In Review dropped; the two actionable issues remain.
      expect(result.map((r) => r.identifier)).toEqual(['ENG-1', 'ENG-2']);
    });
  });

  // SOT-1440 / P7: transient-error backoff retry + labelIds sanitize.
  describe('linearQuery retry + sanitizeLabelIds (SOT-1440)', () => {
    const origBase = process.env.LINEAR_RETRY_BASE_MS;
    beforeEach(() => { process.env.LINEAR_RETRY_BASE_MS = '1'; }); // keep backoff tiny in tests
    afterEach(() => {
      if (origBase === undefined) delete process.env.LINEAR_RETRY_BASE_MS;
      else process.env.LINEAR_RETRY_BASE_MS = origBase;
    });

    it('retries a transient 503 then succeeds', async () => {
      linearMock.enqueue({ data: { ok: true } }, 503); // transient
      linearMock.enqueue({ data: { ok: true, n: 2 } }, 200); // success on retry

      const result = await runner.linearQuery('query { ok }');

      expect(result).toEqual({ ok: true, n: 2 });
      expect(linearMock.calls).toHaveLength(2); // one retry
    });

    it('does NOT retry a permanent GraphQL error', async () => {
      linearMock.enqueue({ errors: [{ message: 'validation failed' }] }, 200);

      await expect(runner.linearQuery('mutation { x }')).rejects.toThrow('validation failed');
      expect(linearMock.calls).toHaveLength(1); // no retry
    });

    it('retries: 0 disables retry even for transient errors', async () => {
      linearMock.enqueue({ data: { ok: true } }, 503);

      await expect(runner.linearQuery('query { ok }', {}, { retries: 0 })).rejects.toThrow();
      expect(linearMock.calls).toHaveLength(1);
    });

    it('sanitizeLabelIds dedupes and drops empty/non-string ids', () => {
      expect(sanitizeLabelIds(['a', 'a', ' b ', '', null, undefined, 5, 'c'])).toEqual(['a', 'b', 'c']);
      expect(sanitizeLabelIds([])).toEqual([]);
      expect(sanitizeLabelIds(null)).toEqual([]);
    });
  });
});
