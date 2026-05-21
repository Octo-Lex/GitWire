// tests/unit/service-enforcement.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
function mockOctokit(responses = {}) {
  const calls = [];
  return {
    request: async (route, params) => {
      calls.push({ route, params });
      const h = responses[route];
      if (h) return typeof h === 'function' ? h(params) : h;
      // Default: return empty arrays for list endpoints
      if (route.includes('/issues') && !route.includes('/issues/') && !route.includes('/issues/new')) return { data: [] };
      if (route.includes('/branches')) return { data: [] };
      return { data: {} };
    }, _calls: calls,
  };
}
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
const { enforceRepo } = await import('../../src/services/branchEnforcementService.js');

describe('branchEnforcementService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('no enforcement when no policies', async () => {
    const oct = mockOctokit();
    const r = await enforceRepo({ octokit: oct, repo: { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' }, policies: [], installation: { id: 100 } });
    expect(r).toEqual({ violations: 0, remediated: 0 });
  });

  test('handles 404 on branch protection gracefully', async () => {
    const policy = { id: 1, name: 'test', branch_pattern: 'main', min_reviews: 1, require_linear_history: false, block_force_pushes: false, block_deletions: false, enforce_admins: false, repo_filter: null };
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/branches/{branch}/protection': () => { const e = new Error('Not Found'); e.status = 404; throw e; },
    });
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await enforceRepo({ octokit: oct, repo: { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' }, policies: [policy], installation: { id: 100 } });
    expect(r).toBeDefined();
    expect(r.violations).toBeGreaterThanOrEqual(0);
  });
});
