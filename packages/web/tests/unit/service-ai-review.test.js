// tests/unit/service-ai-review.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
function mockOctokit(responses = {}) {
  const calls = [];
  return { request: async (route, params) => { calls.push({ route, params }); const h = responses[route]; if (h) return typeof h === 'function' ? h(params) : h; return { data: {} }; }, _calls: calls };
}
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
await jest.unstable_mockModule('../../src/services/auditTrailService.js', () => ({
  Trail: { appendEntry: jest.fn() },
}));
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn() },
}));
// Mock Anthropic SDK
const mockCreate = jest.fn();
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: mockCreate }; } },
}));
await jest.unstable_mockModule('../../config/index.js', () => ({
  config: { server: { env: 'test' }, anthropic: { apiKey: 'test', baseURL: 'http://test' }, ai: { model: 'test-model' } },
}));
const { reviewPR } = await import('../../src/services/aiReviewService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r', default_branch: 'main' };

describe('aiReviewService', () => {
  beforeEach(() => { mockQuery.mockReset(); mockCreate.mockReset(); });

  test('skips when no config found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const oct = mockOctokit();
    await reviewPR({ pr: { number: 5 }, repository: REPO, octokit: oct });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('skips bot PRs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { user: { login: 'dependabot[bot]' }, title: 'bump' } },
    });
    await reviewPR({ pr: { number: 5 }, repository: REPO, octokit: oct });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('reviews PR: full flow with AI', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, enabled: true, review_mode: 'comment', repo_filter: null, max_files: 20 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] })
      .mockResolvedValue({ rows: [] });
    mockCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'approve', findings: [], summary: 'LGTM' }) }] });
    const oct = mockOctokit({
      'POST /repos/{owner}/{repo}/check-runs': { data: { id: 10 } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}': { data: { user: { login: 'dev' }, title: 'feat: add x', changed_files: 1, additions: 10, deletions: 0, head: { sha: 'abc' } } },
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files': { data: [{ filename: 'src/index.js', patch: '+hello' }] },
      'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}': { data: {} },
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': { data: { id: 1 } },
    });
    const r = await reviewPR({ pr: { number: 5, head: { sha: 'abc' } }, repository: REPO, octokit: oct });
    // Verify DB was queried for config
    expect(mockQuery).toHaveBeenCalled();
  });
});
