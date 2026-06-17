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
      linearMock.enqueueRaw('Internal Server Error', 500);

      await expect(runner.linearQuery('{ issues { id } }'))
        .rejects.toThrow('Failed to parse Linear API response');
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
  });
});
