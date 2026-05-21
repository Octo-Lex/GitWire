// tests/unit/service-dependency.test.js
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
const { scanRepo, inferEcosystem } = await import('../../src/services/dependencyService.js');

const REPO = { id: 1, full_name: 'o/r', owner: { login: 'o' }, name: 'r', default_branch: 'main' };

describe('dependencyService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('inferEcosystem detects npm', () => {
    expect(inferEcosystem('package.json')).toBe('npm');
  });

  test('inferEcosystem detects pip', () => {
    expect(inferEcosystem('requirements.txt')).toBe('pip');
  });

  test('inferEcosystem returns unknown for unrecognized', () => {
    expect(inferEcosystem('readme.md')).toBe('unknown');
  });

  test('scanRepo finds package.json', async () => {
    const oct = mockOctokit({
      'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': { data: { tree: [{ path: 'package.json', type: 'blob' }] } },
      'GET /repos/{owner}/{repo}/contents/{path}': { data: { content: Buffer.from('{"dependencies":{"express":"^4.0.0"}}').toString('base64') } },
    });
    mockQuery.mockResolvedValue({ rows: [] });
    await scanRepo({ repository: REPO, octokit: oct });
    expect(mockQuery).toHaveBeenCalled();
  });
});
