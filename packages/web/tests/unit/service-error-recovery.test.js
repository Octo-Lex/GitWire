// tests/unit/service-error-recovery.test.js
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
await jest.unstable_mockModule('../../src/lib/github.js', () => ({
  getInstallationClient: jest.fn(),
}));
await jest.unstable_mockModule('../../src/services/pipelineEvents.js', () => ({
  Events: { record: jest.fn() },
}));
await jest.unstable_mockModule('../../src/services/feedbackService.js', () => ({
  sendFeedback: jest.fn(),
}));
const { evaluateRollback } = await import('../../src/services/errorRecoveryService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r', default_branch: 'main' };

describe('errorRecoveryService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('returns early for non-failure conclusion', async () => {
    const r = await evaluateRollback({ run: { id: 1, head_sha: 'abc', conclusion: 'success', name: 'deploy', path: '.github/workflows/deploy.yml', head_branch: 'main' }, repository: REPO, installation: { id: 100 } });
    expect(r).toBeUndefined();
  });

  test('returns early for non-default branch', async () => {
    const r = await evaluateRollback({ run: { id: 1, head_sha: 'abc', conclusion: 'failure', name: 'deploy', path: '.github/workflows/deploy.yml', head_branch: 'feat/x' }, repository: REPO, installation: { id: 100 } });
    expect(r).toBeUndefined();
  });

  test('returns early for non-deploy workflow', async () => {
    const r = await evaluateRollback({ run: { id: 1, head_sha: 'abc', conclusion: 'failure', name: 'test', path: '.github/workflows/test.yml', head_branch: 'main' }, repository: REPO, installation: { id: 100 } });
    expect(r).toBeUndefined();
  });

  test('skips rollback when config disabled', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await evaluateRollback({ run: { id: 1, head_sha: 'abc', conclusion: 'failure', name: 'deploy', path: '.github/workflows/deploy.yml', head_branch: 'main' }, repository: REPO, installation: { id: 100 } });
    expect(r).toBeUndefined();
  });
});
