// tests/unit/service-audit-trail.test.js
import { jest } from '@jest/globals';
const mockQuery = jest.fn();
await jest.unstable_mockModule('../../src/lib/db.js', () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule('../../src/lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) },
}));
const { appendEntry, verifyChain, generateReport } = await import('../../src/services/auditTrailService.js');

describe('auditTrailService', () => {
  beforeEach(() => mockQuery.mockReset());

  describe('appendEntry', () => {
    test('inserts audit entry', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] });
      await appendEntry({ eventType: 'ai_decision', actor: 'ai', repoId: 5, payload: { verdict: 'approved' }, complianceTags: ['SOC2'], repoFullName: 'o/r' });
      expect(mockQuery).toHaveBeenCalled();
      expect(mockQuery.mock.calls[0][0]).toContain('audit_trail_entries');
    });
    test('handles DB error gracefully (returns null)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('down'));
      const r = await appendEntry({ eventType: 'x', actor: 'a', repoId: 1, payload: {} });
      expect(r).toBeNull();
    });
  });

  describe('verifyChain', () => {
    test('valid for empty chain', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const r = await verifyChain();
      expect(r.valid).toBe(true);
    });
    test('valid for single entry', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ seq: 1, prev_hash: null, payload_hash: 'abc', payload: {} }] });
      const r = await verifyChain();
      expect(r.valid).toBe(true);
      expect(r.entries_checked).toBe(1);
    });
    test('detects broken chain', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { seq: 1, prev_hash: null, payload_hash: 'h1', payload: {} },
        { seq: 2, prev_hash: 'wrong', payload_hash: 'h2', payload: {} },
      ] });
      const r = await verifyChain();
      expect(r.valid).toBe(false);
      expect(r.broken_at).toBe(2);
    });
  });

  describe('generateReport', () => {
    test('generates report', async () => {
      // generateReport makes 7 DB queries — mock all with valid shapes
      mockQuery
        .mockResolvedValueOnce({ rows: [] })                          // categoryCounts
        .mockResolvedValueOnce({ rows: [] })                          // controls
        .mockResolvedValueOnce({ rows: [] })                          // aiStats
        .mockResolvedValueOnce({ rows: [] })                          // mergeStats
        .mockResolvedValueOnce({ rows: [{ total: '0', first_seq: null, last_seq: null }] }) // seqRange
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })                 // report insert
        .mockResolvedValueOnce({ rows: [] });                          // entries insert
      const r = await generateReport({ reportType: 'SOC2', from: '2026-01-01', to: '2026-12-31', generatedBy: 'admin' });
      expect(mockQuery).toHaveBeenCalled();
    });
  });
});
