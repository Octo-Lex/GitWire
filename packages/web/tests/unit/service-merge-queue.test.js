// tests/unit/service-merge-queue.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params) : h;
      if (route.includes('/reviews')) return { data: [{ state: 'APPROVED', user: { login: 'reviewer' } }] };
      if (route.includes('/pulls') && !route.includes('/merge')) return { data: { state: 'open', draft: false, base: { ref: 'main' }, mergeable: true, merged: false, mergeable_state: 'clean', head: { sha: 'abc' } } };
      if (route.includes('/statuses')) return { data: { state: 'success' } };
      if (route.includes('/check-suites') || route.includes('/check-runs')) return { data: { check_suites: [], check_runs: [], total_count: 0 } };
      if (route.includes('/comments')) return { data: {} };
      if (route.includes('/labels')) return { data: {} };
      if (route.includes('/issues/') && route.includes('/labels')) return { data: {} };
      return { data: {} };
    }, _calls: calls,
  };
}
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { prAdmitted: jest.fn(), prBlocked: jest.fn() },
}));
await jest.unstable_mockModule('../../src/services/feedbackService.js', () => ({
  sendFeedback: jest.fn(),
}));
const { admitToQueue, processQueue, removeFromQueue } = await import('../../src/services/mergeQueueService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };

describe('mergeQueueService', () => {
  beforeEach(() => mockQuery.mockReset());

  describe('admitToQueue', () => {
    test('rejects when queue disabled', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const r = await admitToQueue({ pr: { number: 5, base: { ref: 'main' }, head: { sha: 'abc', ref: 'feat/x' }, title: 'test', user: { login: 'dev' } }, repository: REPO, octokit: mockOctokit() });
      expect(r).toBeFalsy();
    });

    test('rejects draft PR', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ enabled: true, merge_method: 'squash', base_branch: 'main' }] });
      const oct = mockOctokit();
      const r = await admitToQueue({ pr: { number: 5, draft: true, base: { ref: 'main' }, head: { sha: 'abc', ref: 'feat/x' }, title: 'test', user: { login: 'dev' } }, repository: REPO, octokit: oct });
      expect(r).toBeFalsy();
    });

    test('admits eligible PR', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ enabled: true, merge_method: 'squash', required_checks: [], delete_branch: false, max_queue_depth: 10, base_branch: 'main' }] })
        .mockResolvedValueOnce({ rows: [{ count: '0' }] })
        .mockResolvedValueOnce({ rows: [{ max_pos: 0 }] })
        .mockResolvedValueOnce({ rows: [{ id: 1, position: 1 }] });
      const oct = mockOctokit();
      const r = await admitToQueue({ pr: { number: 5, base: { ref: 'main' }, head: { sha: 'abc', ref: 'feat/x' }, title: 'test', user: { login: 'dev' } }, repository: REPO, octokit: oct });
      expect(r).toBeTruthy();
    });
  });

  describe('processQueue', () => {
    test('skips empty queue', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ enabled: true }] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      await processQueue(1, REPO, mockOctokit());
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test('merges ready PR', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 1, pr_number: 5, repository_id: 1, head_sha: 'abc', head_branch: 'feat/x', status: 'ready' }] }) // select ready
        .mockResolvedValueOnce({ rowCount: 1 }) // update to merging
        .mockResolvedValueOnce({ rowCount: 1 }) // update to merged
        .mockResolvedValueOnce({ rows: [] }); // rebalance
      const oct = mockOctokit({
        'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { state: 'open', draft: false, mergeable: true, merged: false, mergeable_state: 'clean', head: { sha: 'abc' } } },
        'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge': { data: { merged: true } },
      });
      await processQueue(1, REPO, oct);
      expect(oct._calls.find(c => c.route.includes('/merge'))).toBeTruthy();
    });
  });

  describe('removeFromQueue', () => {
    test('updates entry status to removed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      await removeFromQueue({ repoId: 1, prNumber: 5, reason: 'test' });
      expect(mockQuery.mock.calls[0][0]).toContain('UPDATE');
    });
  });
});
