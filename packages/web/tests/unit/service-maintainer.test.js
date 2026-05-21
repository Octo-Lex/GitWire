// tests/unit/service-maintainer.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
const { syncMembers, syncCollaborators, syncBranchRules, audit } = await import('../../src/services/maintainerService.js');

describe('maintainerService', () => {
  beforeEach(() => mockQuery.mockReset());

  test('syncMembers syncs org members', async () => {
    let page = 0;
    const oct = {
      request: async (route, params) => {
        if (route.includes('/members') && !route.includes('/memberships')) {
          page++;
          return { data: page === 1 ? [{ login: 'alice', id: 1, avatar_url: 'u' }] : [] };
        }
        if (route.includes('/memberships')) return { data: { role: 'member' } };
        return { data: {} };
      }, _calls: [],
    };
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await syncMembers(oct, 100, 'org');
    expect(mockQuery).toHaveBeenCalled();
  });

  test('syncMembers handles empty list', async () => {
    const oct = { request: async (route) => ({ data: [] }), _calls: [] };
    await syncMembers(oct, 100, 'empty');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('syncCollaborators syncs repo collabs', async () => {
    let page = 0;
    const oct = {
      request: async (route, params) => {
        if (route.includes('/collaborators')) {
          page++;
          return { data: page === 1 ? [{ login: 'alice', id: 1, permissions: { admin: true } }] : [] };
        }
        return { data: {} };
      }, _calls: [],
    };
    mockQuery.mockResolvedValue({ rows: [] });
    await syncCollaborators(oct, 'o', 'r', 1);
    expect(mockQuery).toHaveBeenCalled();
  });

  test('syncBranchRules handles 404 gracefully', async () => {
    const oct = {
      request: async (route) => { const e = new Error('Not Found'); e.status = 404; throw e; },
      _calls: [],
    };
    await expect(syncBranchRules(oct, 'o', 'r', 1)).resolves.toBeUndefined();
  });

  test('audit records action in audit_log', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await audit({ actor: 'alice', action: 'stale_warn', targetType: 'issue', targetId: 42, payload: {} });
    expect(mockQuery.mock.calls[0][0]).toContain('audit_log');
  });
});
