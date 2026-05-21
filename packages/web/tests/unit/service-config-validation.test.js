// tests/unit/service-config-validation.test.js
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
const { validatePushConfigs, getFileType } = await import('../../src/services/configValidationService.js');

describe('configValidationService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('getFileType returns correct types', () => {
    expect(getFileType('package.json')).toBe('package_json');
    expect(getFileType('tsconfig.json')).toBe('tsconfig');
    expect(getFileType('.github/workflows/ci.yml')).toBe('github_actions');
    expect(getFileType('Dockerfile')).toBe(null);
    expect(getFileType('random.txt')).toBe(null);
  });

  test('validatePushConfigs returns skipped when no config files', async () => {
    const oct = mockOctokit();
    mockQuery.mockResolvedValue({ rows: [] });
    const r = await validatePushConfigs({
      push: { after: 'abc1234567890', commits: [{ added: ['readme.md'], modified: [], removed: [] }] },
      repository: { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r' },
      octokit: oct,
      installation: { id: 100 },
    });
    expect(r.skipped).toBe(true);
  });
});
