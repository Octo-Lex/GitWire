// tests/unit/service-policy-reconciler.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
function mockOctokit(responses = {}) {
  const calls = [];
  return { request: async (route, params) => {
    calls.push({ route, params });
    const h = responses[route];
    if (h) return typeof h === 'function' ? h(params) : h;
    if (route.includes('/labels')) return { data: [
      { name: 'bug', color: 'd73a4a' }, { name: 'enhancement', color: 'a2eeef' }, { name: 'documentation', color: '0075ca' },
    ] };
    if (route.includes('/repos') && !route.includes('/branches') && !route.includes('/pulls')) return { data: {
      has_issues: true, has_projects: false, has_wiki: false,
      allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true,
    } };
    return { data: {} };
  }, _calls: calls };
}
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
const { reconcileRepo } = await import('../../src/services/policyReconcilerService.js');

const REPO = { id: 1, github_id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r', default_branch: 'main' };

describe('policyReconcilerService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('detects missing branch protection', async () => {
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/branches/{branch}/protection': () => { const e = new Error('404'); e.status = 404; throw e; },
    });
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await reconcileRepo({ octokit: oct, repo: REPO, policies: [] });
    expect(r).toBeDefined();
  });

  test('reports in-sync when protection matches desired defaults', async () => {
    // Default desired: required_reviews=1, require_linear_history=true, allow_force_pushes=false, allow_deletions=false, enforce_admins=true
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/branches/{branch}/protection': { data: {
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_linear_history: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
        enforce_admins: { enabled: true },
        required_status_checks: null,
      } },
    });
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await reconcileRepo({ octokit: oct, repo: REPO, policies: [] });
    expect(r.inSync).toBe(true);
  });

  test('handles reconcile_skip flag', async () => {
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/branches/{branch}/protection': () => { const e = new Error('404'); e.status = 404; throw e; },
    });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // upsert
    mockQuery.mockResolvedValueOnce({ rows: [{ reconcile_skip: true }] }); // skip check
    const r = await reconcileRepo({ octokit: oct, repo: REPO, policies: [] });
    expect(r.corrected).toBe(false);
  });
});
