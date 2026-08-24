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
const { findOpenImproveCycleParent, sanitizeLabelIds, cancelStrandedBlockedChildren } =
  await import('../lib/linearApi.js');

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

  describe('High-level runner functions', () => {
    it('findOpenImproveCycleParent counts In Review cycle parents but ignores non-parent children', async () => {
      // 完了駆動ループの直列ガード: 親は Todo/In Progress/In Review で捕捉し、恒久的に In Review 止まりに
      // なる実装子Issue（親タイトルに一致しない）は無視する。
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              { identifier: 'SOT-CHILD', title: 'usage-limit後のresumeメタデータ保存を追加する' },
              {
                identifier: 'SOT-PARENT',
                title: '[biohub-claude] Kaggle順位向上サイクル第3次 — 改善方針の立案と実施',
              },
            ],
          },
        },
      });

      await expect(findOpenImproveCycleParent('biohub-claude')).resolves.toBe('SOT-PARENT');

      expect(linearMock.calls).toHaveLength(1);
      expect(linearMock.calls[0].query).toContain(
        'state: { name: { in: ["Todo", "In Progress", "In Review"] } }'
      );
      expect(linearMock.calls[0].variables).toEqual({
        name: 'biohub-claude',
        label: 'auto-improve',
      });
    });

    it('findOpenImproveCycleParent returns null when only In Review children remain (no deadlock)', async () => {
      // 実装子Issueだけが In Review で残っている状態では次サイクルをブロックしない（親が無い＝完了）。
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [{ identifier: 'SOT-CHILD', title: 'submission.py の exec 互換を修正する' }],
          },
        },
      });

      await expect(findOpenImproveCycleParent('biohub-claude')).resolves.toBeNull();
    });

    // Regression (biohub SOT-2773): a completion-report comment that merely QUOTES the
    // `<!-- auto-parent-resumed -->` marker must NOT be mistaken for an actual resume, or the parent
    // is stranded In Review forever (never submits, whole competition loop blocked).
    const KAGGLE_PARENT = {
      id: 'parent-uuid',
      identifier: 'SOT-9999',
      title: '[biohub-claude] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
      description: 'workers: solo=claude:fable\n\n## 入力材料（cronが自動収集・要約なし）\n本文…',
      state: { name: 'In Review', type: 'started' },
      team: { id: 'team-1' },
      children: {
        nodes: [{ identifier: 'SOT-CHILD', state: { name: 'Done', type: 'completed' } }],
      },
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    };

    it('finalizeParent resumes when a comment only QUOTES the resume marker mid-text', async () => {
      linearMock.enqueue({ data: { issue: KAGGLE_PARENT } });
      // Completion report that quotes the marker inside prose (the SOT-2773 pattern).
      linearMock.enqueue({
        data: {
          issue: {
            comments: {
              nodes: [
                {
                  body: '## Completion Report\n全子完了後に webhookが `<!-- auto-parent-resumed -->` を付け親を Todo へ戻す。',
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
              { id: 'todo-1', name: 'Todo', type: 'unstarted' },
              { id: 'ir-1', name: 'In Review', type: 'started' },
            ],
          },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      await expect(
        runner.finalizeParentIfChildrenComplete('SOT-CHILD', 'parent-uuid')
      ).resolves.toBe(true);

      const update = linearMock.calls.find((c) => c.query.includes('issueUpdate'));
      expect(update).toBeTruthy();
      expect(update.variables.stateId).toBe('todo-1'); // resumed to Todo
    });

    it('finalizeParent stays idempotent when a real marker leads a comment', async () => {
      linearMock.enqueue({ data: { issue: KAGGLE_PARENT } });
      linearMock.enqueue({
        data: {
          issue: {
            comments: {
              nodes: [
                { body: '<!-- auto-parent-resumed -->\n## 親Issue自動再開（集約・提出フェーズ）' },
              ],
            },
          },
        },
      });

      await expect(
        runner.finalizeParentIfChildrenComplete('SOT-CHILD', 'parent-uuid')
      ).resolves.toBe(false);

      // Skipped before resolving states / mutating (only parent + comments were queried).
      expect(linearMock.calls.find((c) => c.query.includes('issueUpdate'))).toBeUndefined();
    });

    // 恒久対策・型C: 前提が死んだ Blocked 子（他に動いている子がない）を reaper が自動 Cancel する。
    const KAGGLE_PARENT_META = {
      identifier: 'SOT-2924',
      title: '[kaggriculture-gpt] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
      description: 'workers: solo=codex\n\n## 入力材料（cronが自動収集・要約なし）\n本文…',
      team: { id: 'team-1' },
    };

    it('cancelStrandedBlockedChildren cancels a premise-dead Blocked child when nothing else is running', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            ...KAGGLE_PARENT_META,
            children: {
              nodes: [
                {
                  id: 'c-done',
                  identifier: 'SOT-2925',
                  state: { name: 'Done', type: 'completed' },
                },
                {
                  id: 'c-blocked',
                  identifier: 'SOT-2926',
                  state: { name: 'Blocked', type: 'unstarted' },
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
              { id: 'canceled-1', name: 'Canceled', type: 'canceled' },
              { id: 'todo-1', name: 'Todo', type: 'unstarted' },
            ],
          },
        },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      await expect(cancelStrandedBlockedChildren('parent-uuid')).resolves.toBe(1);
      const update = linearMock.calls.find((c) => c.query.includes('issueUpdate'));
      expect(update.variables.id).toBe('c-blocked');
      expect(update.variables.stateId).toBe('canceled-1');
    });

    it('cancelStrandedBlockedChildren does NOT cancel while a sibling is still running', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            ...KAGGLE_PARENT_META,
            children: {
              nodes: [
                {
                  id: 'c-run',
                  identifier: 'SOT-2925',
                  state: { name: 'In Progress', type: 'started' },
                },
                {
                  id: 'c-blocked',
                  identifier: 'SOT-2926',
                  state: { name: 'Blocked', type: 'unstarted' },
                },
              ],
            },
          },
        },
      });

      await expect(cancelStrandedBlockedChildren('parent-uuid')).resolves.toBe(0);
      expect(linearMock.calls.find((c) => c.query.includes('issueUpdate'))).toBeUndefined();
    });

    it('cancelStrandedBlockedChildren is a no-op for non-improvement parents', async () => {
      linearMock.enqueue({
        data: {
          issue: {
            identifier: 'SOT-1',
            title: 'ordinary issue',
            description: 'no material',
            team: { id: 'team-1' },
            children: {
              nodes: [
                {
                  id: 'c-blocked',
                  identifier: 'SOT-2',
                  state: { name: 'Blocked', type: 'unstarted' },
                },
              ],
            },
          },
        },
      });
      await expect(cancelStrandedBlockedChildren('parent-uuid')).resolves.toBe(0);
      expect(linearMock.calls.find((c) => c.query.includes('workflowStates'))).toBeUndefined();
    });

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
      expect(linearMock.calls[1].query).toContain(
        'issueLabels(filter: { name: { eq: "usage-limit" } })'
      );

      // Check label creation
      expect(linearMock.calls[2].query).toContain('issueLabelCreate');
      expect(linearMock.calls[2].variables.name).toBe('usage-limit');
      expect(linearMock.calls[2].variables.teamId).toBe(teamId);

      // Check issue update
      expect(linearMock.calls[3].query).toContain('issueUpdate');
      expect(linearMock.calls[3].variables.labelIds).toContain(labelId);
    });

    // SOT-1460: usage-limit label is added ONLY to In Progress issues (not Todo / In Review),
    // even though In Review is also a `started` type. Comments still go to all active issues.
    it('notifyUsageLimitToAllActiveIssues labels only In Progress, not Todo / In Review', async () => {
      const resetEpoch = 1623912000;
      const labelId = 'label-ul';

      // 1. Fetch active issues (Todo / In Progress / In Review) — now selects state.name.
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              { id: 'todo-1', state: { name: 'Todo' } },
              { id: 'ip-1', state: { name: 'In Progress' } },
              { id: 'ir-1', state: { name: 'In Review' } },
            ],
          },
        },
      });

      // For each issue postUsageLimitComment runs 3 calls (get uuid / fetch comments / create).
      // addUsageLimitLabel runs only for the In Progress issue (3 calls: details / label search / update).

      // --- todo-1: comment only ---
      linearMock.enqueue({ data: { issue: { id: 'todo-1' } } });
      linearMock.enqueue({ data: { issue: { comments: { nodes: [] } } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      // --- ip-1: comment + label ---
      linearMock.enqueue({ data: { issue: { id: 'ip-1' } } });
      linearMock.enqueue({ data: { issue: { comments: { nodes: [] } } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });
      linearMock.enqueue({ data: { issue: { id: 'ip-1', labelIds: [], team: { id: 'team-1' } } } });
      linearMock.enqueue({ data: { issueLabels: { nodes: [{ id: labelId }] } } });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });

      // --- ir-1: comment only ---
      linearMock.enqueue({ data: { issue: { id: 'ir-1' } } });
      linearMock.enqueue({ data: { issue: { comments: { nodes: [] } } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      await runner.notifyUsageLimitToAllActiveIssues(resetEpoch);

      // Fetch query still filters on both types but now also requests state name.
      expect(linearMock.calls[0].query).toContain('type: { in: ["unstarted","started"] }');
      expect(linearMock.calls[0].query).toContain('state { name }');

      // Exactly one label-add mutation, and it targets the In Progress issue's uuid.
      const labelUpdates = linearMock.calls.filter(
        (c) => c.query.includes('issueUpdate') && c.variables && Array.isArray(c.variables.labelIds)
      );
      expect(labelUpdates).toHaveLength(1);
      expect(labelUpdates[0].variables.id).toBe('ip-1');
      expect(labelUpdates[0].variables.labelIds).toContain(labelId);

      // The label-search query (addUsageLimitLabel-only) ran exactly once → Todo / In Review skipped.
      const labelSearches = linearMock.calls.filter((c) =>
        c.query.includes('issueLabels(filter: { name: { eq: "usage-limit" } })')
      );
      expect(labelSearches).toHaveLength(1);
    });

    // SOT-1438 / P3: reaper In Review exclusion at the query layer.
    it('fetchActiveIssues() default includes In Review and does not add a name exclusion', async () => {
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              { id: 'u1', identifier: 'ENG-1', state: { type: 'unstarted', name: 'Todo' } },
              { id: 'u2', identifier: 'ENG-2', state: { type: 'started', name: 'In Review' } },
            ],
          },
        },
      });

      const result = await runner.fetchActiveIssues(50);

      expect(linearMock.calls[0].query).not.toContain('nin');
      // No excludeHold → In Review is returned unchanged.
      expect(result.map((r) => r.identifier)).toEqual(['ENG-1', 'ENG-2']);
    });

    it('fetchActiveIssues(first, { excludeHold: true }) excludes In Review by query + JS filter', async () => {
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              { id: 'u1', identifier: 'ENG-1', state: { type: 'unstarted', name: 'Todo' } },
              { id: 'u2', identifier: 'ENG-2', state: { type: 'started', name: 'In Progress' } },
              // Server-side name filter would omit this, but include it to prove the JS backstop drops it too.
              { id: 'u3', identifier: 'ENG-3', state: { type: 'started', name: 'In Review' } },
            ],
          },
        },
      });

      const result = await runner.fetchActiveIssues(50, { excludeHold: true });

      // Query-level exclusion present.
      expect(linearMock.calls[0].query).toContain('name: { nin: ["In Review"] }');
      // In Review dropped; the two actionable issues remain.
      expect(result.map((r) => r.identifier)).toEqual(['ENG-1', 'ENG-2']);
    });

    it('maps incoming blocks relations to blockedBy identifiers', async () => {
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              {
                id: 'u2',
                identifier: 'ENG-2',
                state: { type: 'unstarted', name: 'Todo' },
                inverseRelations: {
                  nodes: [
                    {
                      type: 'blocks',
                      issue: { id: 'u1', identifier: 'ENG-1' },
                      relatedIssue: { id: 'u2', identifier: 'ENG-2' },
                    },
                    {
                      type: 'blocks',
                      issue: { id: 'u2', identifier: 'ENG-2' },
                      relatedIssue: { id: 'u2', identifier: 'ENG-2' },
                    },
                    {
                      type: 'related',
                      issue: { id: 'u3', identifier: 'ENG-3' },
                      relatedIssue: { id: 'u2', identifier: 'ENG-2' },
                    },
                  ],
                },
              },
            ],
          },
        },
      });
      const [issue] = await runner.fetchActiveIssues(50);
      expect(issue.blockedByIssueIds).toEqual(['u1', 'ENG-1']);
    });
  });

  // SOT-1440 / P7: transient-error backoff retry + labelIds sanitize.
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

  describe('reconcileReadyKaggleParents', () => {
    it('resumes a held auto-improve parent through the idempotent finalizer', async () => {
      linearMock.enqueue({
        data: {
          issues: {
            nodes: [
              {
                id: 'parent-uuid',
                identifier: 'SOT-2000',
                children: { nodes: [{ identifier: 'SOT-2001' }] },
              },
            ],
          },
        },
      });
      // 型C の cancelStrandedBlockedChildren が先に親の子を照会する（Blocked 子なし→0で早期return）。
      linearMock.enqueue({
        data: {
          issue: {
            identifier: 'SOT-2000',
            title: '[demo-gpt] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
            description: '## 入力材料（cronが自動収集・要約なし）',
            team: { id: 't1' },
            children: {
              nodes: [
                { id: 'c1', identifier: 'SOT-2001', state: { name: 'In Review', type: 'started' } },
              ],
            },
          },
        },
      });
      linearMock.enqueue({
        data: {
          issue: {
            id: 'parent-uuid',
            identifier: 'SOT-2000',
            title: '[demo-gpt] Kaggle順位向上サイクル第2次 — 改善方針の立案と実施',
            description: '## 入力材料（cronが自動収集・要約なし）',
            state: { name: 'In Review', type: 'started' },
            team: { id: 't1' },
            children: {
              nodes: [{ identifier: 'SOT-2001', state: { name: 'In Review', type: 'started' } }],
            },
            relations: { nodes: [] },
            inverseRelations: { nodes: [] },
          },
        },
      });
      linearMock.enqueue({ data: { issue: { comments: { nodes: [] } } } });
      linearMock.enqueue({
        data: { workflowStates: { nodes: [{ id: 'todo', name: 'Todo', type: 'unstarted' }] } },
      });
      linearMock.enqueue({ data: { issueUpdate: { success: true } } });
      linearMock.enqueue({ data: { commentCreate: { success: true } } });

      expect(await runner.reconcileReadyKaggleParents()).toBe(1);
      const update = linearMock.calls.find((call) => call.query.includes('issueUpdate'));
      expect(update.variables).toEqual({ id: 'parent-uuid', stateId: 'todo' });
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
