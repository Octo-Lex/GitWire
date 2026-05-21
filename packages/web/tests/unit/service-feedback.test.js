// tests/unit/service-feedback.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
const mockFetch = jest.fn();
global.fetch = mockFetch;
function mockOctokit(responses = {}) {
  const calls = [];
  return { request: async (route, params) => { calls.push({ route, params }); const h = responses[route]; if (h) return typeof h === 'function' ? h(params) : h; return { data: {} }; }, _calls: calls };
}
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
const { sendFeedback } = await import('../../src/services/feedbackService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' };

describe('feedbackService', () => {
  beforeEach(() => { mockQuery.mockReset(); mockFetch.mockReset(); });

  test('posts PR comment when rule enabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, event_type: 'ci_failure', post_pr_comment: true, slack_webhook: null, teams_webhook: null, repo_filter: null }] });
    const oct = mockOctokit({ 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': { data: { id: 1 } } });
    await sendFeedback({ eventType: 'ci_failure', repoId: 1, repository: REPO, prNumber: 5, octokit: oct, data: { runName: 'CI', conclusion: 'failure' } });
    expect(mockQuery).toHaveBeenCalled();
  });

  test('posts to Slack webhook', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 2, event_type: 'ci_failure', post_pr_comment: false, slack_webhook: 'https://hooks.slack.com/x', teams_webhook: null, repo_filter: null }] });
    mockFetch.mockResolvedValueOnce({ ok: true });
    await sendFeedback({ eventType: 'ci_failure', repoId: 1, repository: REPO, prNumber: 5, octokit: mockOctokit(), data: { runName: 'CI', conclusion: 'failure' } });
    expect(mockFetch).toHaveBeenCalledWith('https://hooks.slack.com/x', expect.objectContaining({ method: 'POST' }));
  });

  test('does nothing when no rules match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await sendFeedback({ eventType: 'unknown', repoId: 1, repository: REPO, prNumber: 5, octokit: mockOctokit(), data: {} });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('handles fetch error gracefully', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3, event_type: 'ci_heal', post_pr_comment: false, slack_webhook: 'https://fail', teams_webhook: null, repo_filter: null }] });
    mockFetch.mockRejectedValueOnce(new Error('net'));
    await expect(sendFeedback({ eventType: 'ci_heal', repoId: 1, repository: REPO, prNumber: 5, octokit: mockOctokit(), data: {} })).resolves.toBeUndefined();
  });
});
