// tests/unit/service-flaky-test.test.js
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
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn() },
}));
await jest.unstable_mockModule('@anthropic-ai/sdk', () => ({
  default: class { constructor() { this.messages = { create: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '[]' }] }) }; } },
}));
await jest.unstable_mockModule('../../config/index.js', () => ({
  config: { server: { env: 'test' }, anthropic: { apiKey: 'test', baseURL: 'http://test' }, ai: { model: 'test-model' } },
}));
const { ingestTestResults, checkGraduation } = await import('../../src/services/flakyTestService.js');

describe('flakyTestService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('ingestTestResults handles empty annotations', async () => {
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts': { data: { artifacts: [] } },
    });
    mockQuery.mockResolvedValue({ rows: [] });
    await ingestTestResults({
      run: { id: 1, head_sha: 'abc', conclusion: 'failure', name: 'test' },
      repository: { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' },
      octokit: oct,
      installation: { id: 100 },
    });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('checkGraduation detects stable tests', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, test_name: 'auth.test', run_count: 10, fail_count: 2, last_pass: new Date() }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await checkGraduation(1);
    expect(mockQuery).toHaveBeenCalled();
  });
});
