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

      await expect(runner.linearQuery('{ issues { id } }')).rejects.toThrow('Something went wrong');
    });

    it('throws error on non-2xx HTTP response', async () => {
      // SOT-1440: 5xx is now classified as a transient HTTP error. Disable retry here so this
      // stays a single-attempt "non-2xx throws" assertion.
      const origMax = process.env.LINEAR_RETRY_MAX;
      process.env.LINEAR_RETRY_MAX = '0';
      try {
        linearMock.enqueueRaw('Internal Server Error', 500);
        await expect(runner.linearQuery('{ issues { id } }')).rejects.toThrow(
          'Linear API HTTP 500'
        );
      } finally {
        if (origMax === undefined) delete process.env.LINEAR_RETRY_MAX;
        else process.env.LINEAR_RETRY_MAX = origMax;
      }
    });

    it('throws error when LINEAR_API_KEY is missing', async () => {
      delete process.env.LINEAR_API_KEY;
      await expect(runner.linearQuery('{ issues { id } }')).rejects.toThrow(
        'LINEAR_API_KEY not set'
      );
    });
  });

  describe('linearQuery retry + sanitizeLabelIds (SOT-1440)', () => {
    const origBase = process.env.LINEAR_RETRY_BASE_MS;
    beforeEach(() => {
      process.env.LINEAR_RETRY_BASE_MS = '1';
    }); // keep backoff tiny in tests
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
      expect(sanitizeLabelIds(['a', 'a', ' b ', '', null, undefined, 5, 'c'])).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(sanitizeLabelIds([])).toEqual([]);
      expect(sanitizeLabelIds(null)).toEqual([]);
    });
  });

  describe('setIssueInReview (reaper loop-breaker, SOT-1438)', () => {
    it('moves an active (In Progress) issue to In Review and posts the comment', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'u1',
            state: { name: 'In Progress', type: 'started' },
            team: { id: 't1' },
            relations: {
              nodes: [
                { id: 'blocks-out', type: 'blocks' },
                { id: 'related', type: 'related' },
              ],
            },
            inverseRelations: { nodes: [{ id: 'blocks-in', type: 'blocks' }] },
          },
        },
      });
      linearMock.enqueue({
        data: {
          workflowStates: {
            nodes: [
              { id: 'sp', name: 'In Progress', type: 'started' },
              { id: 'sr', name: 'In Review', type: 'started' },
            ],
          },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });
      linearMock.enqueue({ data: { issueRelationDelete: { success: true } } });
      linearMock.enqueue({ data: { issueRelationDelete: { success: true } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      const moved = await runner.setIssueInReview('SOT-1', 'ran a pass');
      expect(moved).toBe(true);
      const update = linearMock.calls.find((c) => c.query.includes('issueUpdate'));
      expect(update.variables.stateId).toBe('sr');
      const deletedIds = linearMock.calls
        .filter((c) => c.query.includes('issueRelationDelete'))
        .map((c) => c.variables.id);
      expect(deletedIds).toEqual(['blocks-out', 'blocks-in']);
      expect(deletedIds).not.toContain('related');
      expect(linearMock.calls.some((c) => c.query.includes('commentCreate'))).toBe(true);
    });

    it('is a no-op when the issue is already In Review (no mutation)', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'In Review', type: 'started' }, team: { id: 't1' } },
        },
      });
      const moved = await runner.setIssueInReview('SOT-1');
      expect(moved).toBe(false);
      expect(linearMock.calls).toHaveLength(1); // only the state query, no workflowStates/issueUpdate
    });

    it('cleans stale blocking relations when the issue is already In Review', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'u1',
            state: { name: 'In Review', type: 'started' },
            team: { id: 't1' },
            relations: { nodes: [{ id: 'blocks-out', type: 'blocks' }] },
            inverseRelations: { nodes: [{ id: 'blocks-in', type: 'blocks' }] },
          },
        },
      });
      linearMock.enqueue({ data: { issueRelationDelete: { success: true } } });
      linearMock.enqueue({ data: { issueRelationDelete: { success: true } } });

      const moved = await runner.setIssueInReview('SOT-1');
      expect(moved).toBe(false);
      expect(linearMock.calls.filter((c) => c.query.includes('issueRelationDelete'))).toHaveLength(
        2
      );
      expect(linearMock.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
    });

    it('is a no-op for a terminal (Done) issue', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Done', type: 'completed' }, team: { id: 't1' } },
        },
      });
      const moved = await runner.setIssueInReview('SOT-1');
      expect(moved).toBe(false);
      expect(linearMock.calls).toHaveLength(1);
    });
  });

  describe('repairPrematureDone', () => {
    it('reopens only a Done issue into In Review', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'u1',
            state: { name: 'Done', type: 'completed' },
            team: { id: 't1' },
          },
        },
      });
      linearMock.enqueue({
        data: { workflowStates: { nodes: [{ id: 'sr', name: 'In Review', type: 'started' }] } },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      const repaired = await runner.repairPrematureDone('SOT-1');

      expect(repaired).toBe(true);
      const update = linearMock.calls.find((call) => call.query.includes('issueUpdate'));
      expect(update.variables).toEqual({ id: 'u1', stateId: 'sr' });
    });

    it.each([
      ['Canceled', 'canceled'],
      ['Duplicate', 'duplicate'],
      ['On Hold', 'completed'],
      ['In Review', 'started'],
    ])('does not reopen %s', async (name, type) => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'u1',
            state: { name, type },
            team: { id: 't1' },
          },
        },
      });

      expect(await runner.repairPrematureDone('SOT-1')).toBe(false);
      expect(linearMock.calls).toHaveLength(1);
    });
  });


  describe('setIssueInProgress (early pipeline-start transition, SOT-1590)', () => {
    it('moves a Todo issue to In Progress via the started workflow state', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1' } },
        },
      });
      linearMock.enqueue({
        data: { workflowStates: { nodes: [{ id: 'sp', name: 'In Progress' }] } },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      await runner.setIssueInProgress('SOT-1');
      const update = linearMock.calls.find((c) => c.query.includes('issueUpdate'));
      expect(update).toBeTruthy();
      expect(update.variables.stateId).toBe('sp');
    });

    it('selects In Progress by name even when In Review (also "started") is listed first (SOT-1591)', async () => {
      // Both In Review and In Progress are type "started"; a first-of-type pick would wrongly return
      // In Review. Resolving by name must land on the In Progress state id.
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1' } },
        },
      });
      linearMock.enqueue({
        data: {
          workflowStates: {
            nodes: [
              { id: 'sr', name: 'In Review', type: 'started' },
              { id: 'sp', name: 'In Progress', type: 'started' },
            ],
          },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      await runner.setIssueInProgress('SOT-1');
      const update = linearMock.calls.find((c) => c.query.includes('issueUpdate'));
      expect(update).toBeTruthy();
      expect(update.variables.stateId).toBe('sp');
    });

    it('is a no-op when the team has no In Progress state (SOT-1591)', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Todo', type: 'unstarted' }, team: { id: 't1' } },
        },
      });
      linearMock.enqueue({
        data: { workflowStates: { nodes: [{ id: 'sr', name: 'In Review', type: 'started' }] } },
      });

      await runner.setIssueInProgress('SOT-1');
      expect(linearMock.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
    });

    it('is a no-op when the issue is already started (In Progress)', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'In Progress', type: 'started' }, team: { id: 't1' } },
        },
      });
      await runner.setIssueInProgress('SOT-1');
      expect(linearMock.calls).toHaveLength(1); // only the state query, no workflowStates/issueUpdate
    });

    it('is a no-op for a terminal (Done) issue — never reopens it', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Done', type: 'completed' }, team: { id: 't1' } },
        },
      });
      await runner.setIssueInProgress('SOT-1');
      expect(linearMock.calls).toHaveLength(1);
      expect(linearMock.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
    });

    it('preserves a worker-set Blocked state during incomplete-run cleanup', async () => {
      linearMock.enqueue({
        data: {
          issue: { id: 'u1', state: { name: 'Blocked', type: 'unstarted' }, team: { id: 't1' } },
        },
      });
      await runner.setIssueInProgress('SOT-1', { preserveBlocked: true });
      expect(linearMock.calls).toHaveLength(1);
      expect(linearMock.calls.some((c) => c.query.includes('issueUpdate'))).toBe(false);
    });

    it('does nothing when the issue is missing', async () => {
      linearMock.enqueue({ data: { issue: null } });
      await runner.setIssueInProgress('SOT-1');
      expect(linearMock.calls).toHaveLength(1);
    });
  });

  describe('setIssueBlocked (human intervention)', () => {
    it('moves an auth-stopped issue to Blocked and explains how to resume', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'u1',
            state: { name: 'In Progress', type: 'started' },
            team: { id: 't1' },
          },
        },
      });
      linearMock.enqueue({
        data: {
          workflowStates: { nodes: [{ id: 'blocked', name: 'Blocked', type: 'unstarted' }] },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      const moved = await runner.setIssueBlocked('SOT-1', '再認証後に再開してください');
      expect(moved).toBe(true);
      expect(
        linearMock.calls.find((call) => call.query.includes('issueUpdate')).variables.stateId
      ).toBe('blocked');
      expect(
        linearMock.calls.find((call) => call.query.includes('commentCreate')).variables.body
      ).toContain('再認証');
    });
  });

  describe('getIssueExecutionEligibility dependency waiting (SOT-2020)', () => {
    it('rejects a malformed ERL contract again immediately before execution', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'invalid-erl',
            identifier: 'SOT-ERL-BAD',
            description:
              '<!-- epistemic-research-loop:experiment-request:v1 -->\n```json\n{"run_id":"missing-fields"}\n```',
            archivedAt: null,
            state: { name: 'Todo', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        },
      });

      const result = await runner.getIssueExecutionEligibility('SOT-ERL-BAD');

      expect(result.eligible).toBe(false);
      expect(result.reason).toMatch(/invalid experiment request before run/);
      expect(result.meaningState).toBe('human_wait');
    });

    it('removes an explicit Blocked issue with no dependency from automatic retries', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'blocked',
            identifier: 'SOT-2226',
            archivedAt: null,
            state: { name: 'Blocked', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        },
      });

      await expect(runner.getIssueExecutionEligibility('SOT-2226')).resolves.toEqual({
        eligible: false,
        reason: 'human wait state (Blocked) before run',
        meaningState: 'human_wait',
      });
    });

    it('keeps a Blocked issue ineligible while a blocking issue is active', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'dependent',
            identifier: 'SOT-2020-B',
            archivedAt: null,
            state: { name: 'Blocked', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: {
              nodes: [
                {
                  type: 'blocks',
                  issue: {
                    id: 'blocker',
                    identifier: 'SOT-2020-A',
                    archivedAt: null,
                    state: { name: 'In Progress', type: 'started' },
                  },
                },
              ],
            },
          },
        },
      });

      await expect(runner.getIssueExecutionEligibility('SOT-2020-B')).resolves.toEqual({
        eligible: false,
        reason: 'waiting on blockers: SOT-2020-A',
        waitingOnBlockers: ['SOT-2020-A'],
        meaningState: 'dependency_wait',
      });
    });

    it('keeps a dependency-waiting issue in Todo without removing it from retries', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'dependent',
            identifier: 'SOT-2098',
            archivedAt: null,
            state: { name: 'Blocked', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: {
              nodes: [
                {
                  type: 'blocks',
                  issue: {
                    id: 'blocker',
                    identifier: 'SOT-2097',
                    archivedAt: null,
                    state: { name: 'In Progress', type: 'started' },
                  },
                },
              ],
            },
          },
        },
      });
      linearMock.enqueue({
        data: {
          workflowStates: {
            nodes: [
              { id: 'todo-state', name: 'Todo', type: 'unstarted' },
              { id: 'blocked-state', name: 'Blocked', type: 'unstarted' },
            ],
          },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      await expect(runner.getIssueExecutionEligibility('SOT-2098')).resolves.toEqual({
        eligible: false,
        reason: 'waiting on blockers: SOT-2097',
        waitingOnBlockers: ['SOT-2097'],
        meaningState: 'dependency_wait',
      });

      const update = linearMock.calls.find((call) => call.query.includes('issueUpdate'));
      expect(update.variables).toEqual({ id: 'dependent', stateId: 'todo-state' });
    });

    it('allows the next round after the blocker reaches In Review', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'dependent',
            identifier: 'SOT-2020-B',
            archivedAt: null,
            state: { name: 'Todo', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: {
              nodes: [
                {
                  type: 'blocks',
                  issue: {
                    id: 'blocker',
                    identifier: 'SOT-2020-A',
                    archivedAt: null,
                    state: { name: 'In Review', type: 'started' },
                  },
                },
              ],
            },
          },
        },
      });

      await expect(runner.getIssueExecutionEligibility('SOT-2020-B')).resolves.toEqual({
        eligible: true,
        isLongRun: false,
        meaningState: 'actionable',
      });
    });

    it('does not mistake On Hold for completed even when Linear gives it a completed type', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            id: 'dependent',
            identifier: 'SOT-2020-B',
            archivedAt: null,
            state: { name: 'Todo', type: 'unstarted' },
            team: { id: 'team-1' },
            labels: { nodes: [] },
            inverseRelations: {
              nodes: [
                {
                  type: 'blocks',
                  issue: {
                    id: 'blocker',
                    identifier: 'SOT-2020-A',
                    archivedAt: null,
                    state: { name: 'On Hold', type: 'completed' },
                  },
                },
              ],
            },
          },
        },
      });

      const result = await runner.getIssueExecutionEligibility('SOT-2020-B');
      expect(result.eligible).toBe(false);
      expect(result.waitingOnBlockers).toEqual(['SOT-2020-A']);
    });
  });
});
