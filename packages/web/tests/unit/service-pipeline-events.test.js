// tests/unit/service-pipeline-events.test.js
// Service mock test: pipelineEvents.record
// ESM-compatible mocking with jest.unstable_mockModule

import { jest } from '@jest/globals';

const mockQuery = jest.fn();

await jest.unstable_mockModule('../../src/lib/db.js', () => ({
  db: { query: mockQuery },
}));

await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));

const { record } = await import('../../src/services/pipelineEvents.js');

describe('pipelineEvents.record', () => {
  beforeEach(() => mockQuery.mockReset());

  test('inserts event with all fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
    await record({ repoId: 5, eventType: 'triage', actor: 'bot', ref: 'main', prNumber: null, durationMs: 150, success: true, metadata: { labels: ['bug'] } });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO pipeline_events');
  });

  test('inserts with minimal fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await record({ repoId: 1, eventType: 'sync', actor: 'system', ref: 'main' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('does not throw on DB error (non-fatal)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));
    await expect(record({ repoId: 1, eventType: 'sync', actor: 'system', ref: 'main' })).resolves.toBeUndefined();
  });
});
