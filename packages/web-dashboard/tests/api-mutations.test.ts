// tests/api-mutations.test.ts
// Test mutation functions — verifies fetch calls with correct URL, method, body
import { jest } from '@jest/globals';

const calls: Array<{ url: string; method: string; body?: string }> = [];
const mockFetch = async (url: string, opts?: RequestInit) => {
  calls.push({
    url: String(url),
    method: opts?.method || 'GET',
    body: opts?.body?.toString(),
  });
  return { ok: true, status: 200, json: async () => ({}) };
};

// Set env before import
process.env.NEXT_PUBLIC_API_URL = '';
process.env.NEXT_PUBLIC_API_KEY = 'test-key';

// @ts-ignore
globalThis.fetch = mockFetch;

import {
  triggerRepoSync, retryRun, triggerStaleScan, triggerBranchCleanup,
  updateSettings, triggerFix, syncMembers, confirmDuplicate, dismissDuplicate,
  triggerEmbeddingBackfill, createPolicy, updatePolicy, deletePolicy,
  suppressViolation, triggerEnforcementRun,
  updateQueueConfig, dequeuePR, createFeedbackRule, updateFeedbackRule, deleteFeedbackRule,
  graduateTest, dismissTest, triggerReconciliation, updateRepoReconcileConfig,
  triggerDepScan, openBatchDepPR, dismissVuln,
  updateReviewConfig, triggerReview, verifyAuditChain, generateComplianceReport,
} from '../src/lib/api';

describe('API mutation functions', () => {
  beforeEach(() => calls.length = 0);

  // ── Repo & Sync ──────────────────────────────────────────────────────
  test('triggerRepoSync calls POST /api/repos/:owner/:repo/sync', async () => {
    await triggerRepoSync('o', 'r');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/repos/o/r/sync');
  });

  test('retryRun calls POST /api/ci/:runId/retry', async () => {
    await retryRun('123');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/api/ci/123/retry');
  });

  // ── Maintainer ──────────────────────────────────────────────────────
  test('triggerStaleScan calls POST', async () => {
    await triggerStaleScan('o', 'r');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/maintainer/o/r/stale-scan');
  });

  test('triggerBranchCleanup calls POST', async () => {
    await triggerBranchCleanup('o', 'r');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/maintainer/o/r/branch-cleanup');
  });

  test('updateSettings sends PATCH with body', async () => {
    await updateSettings('o', 'r', { stale_issue_days: 30 });
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('/maintainer/o/r/settings');
    expect(calls[0].body).toContain('stale_issue_days');
  });

  test('triggerFix calls POST with installation_id', async () => {
    await triggerFix('o', 'r', 42);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/fix/o/r/issues/42');
  });

  test('syncMembers calls POST', async () => {
    await syncMembers();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/maintainer/members/sync');
  });

  // ── Duplicates ──────────────────────────────────────────────────────
  test('confirmDuplicate calls POST', async () => {
    await confirmDuplicate(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/duplicates/1/confirm');
  });

  test('dismissDuplicate calls POST', async () => {
    await dismissDuplicate(2);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/duplicates/2/dismiss');
  });

  test('triggerEmbeddingBackfill calls POST', async () => {
    await triggerEmbeddingBackfill('o', 'r');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/duplicates/backfill/o/r');
  });

  // ── Enforcement ─────────────────────────────────────────────────────
  test('createPolicy sends POST with body', async () => {
    await createPolicy({ name: 'test', branch_pattern: 'main' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/enforcement/policies');
    expect(calls[0].body).toContain('branch_pattern');
  });

  test('updatePolicy sends PUT', async () => {
    await updatePolicy(1, { min_reviews: 2 });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('/enforcement/policies/1');
  });

  test('deletePolicy sends DELETE', async () => {
    await deletePolicy(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/enforcement/policies/1');
  });

  test('suppressViolation calls POST', async () => {
    await suppressViolation(5);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/enforcement/violations/5/suppress');
  });

  test('triggerEnforcementRun calls POST', async () => {
    await triggerEnforcementRun();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/enforcement/run');
  });

  // ── Phase 2 ─────────────────────────────────────────────────────────
  test('updateQueueConfig sends POST with body', async () => {
    await updateQueueConfig('o', 'r', { enabled: true, merge_method: 'squash' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase2/queue/o/r/config');
    expect(calls[0].body).toContain('merge_method');
  });

  test('dequeuePR calls POST', async () => {
    await dequeuePR('o', 'r', 5);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase2/queue/o/r/5/remove');
  });

  test('createFeedbackRule sends POST', async () => {
    await createFeedbackRule({ event_type: 'ci_failure' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase2/feedback');
  });

  test('updateFeedbackRule sends PUT', async () => {
    await updateFeedbackRule(1, { post_pr_comment: false });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('/phase2/feedback/1');
  });

  test('deleteFeedbackRule sends DELETE', async () => {
    await deleteFeedbackRule(1);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/phase2/feedback/1');
  });

  // ── Phase 3 ─────────────────────────────────────────────────────────
  test('graduateTest calls POST', async () => {
    await graduateTest(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/flaky/1/graduate');
  });

  test('dismissTest calls POST', async () => {
    await dismissTest(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/flaky/1/dismiss');
  });

  test('triggerReconciliation calls POST', async () => {
    await triggerReconciliation();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/reconciler/run');
  });

  test('updateRepoReconcileConfig sends PUT', async () => {
    await updateRepoReconcileConfig('o', 'r', { reconcile_skip: true });
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toContain('/phase3/reconciler/repos/o/r');
  });

  test('triggerDepScan calls POST', async () => {
    await triggerDepScan('o', 'r');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/dependencies/o/r/scan');
  });

  test('openBatchDepPR calls POST', async () => {
    await openBatchDepPR('o', 'r', 'npm');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/dependencies/o/r/batch-pr');
  });

  test('dismissVuln calls POST', async () => {
    await dismissVuln(1, 'false positive');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/phase3/dependencies/vuln/1/dismiss');
  });

  // ── Phase 4 ─────────────────────────────────────────────────────────
  test('updateReviewConfig sends POST', async () => {
    await updateReviewConfig('o', 'r', { enabled: true });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/review/config/o/r');
  });

  test('triggerReview calls POST', async () => {
    await triggerReview('o', 'r', 5);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/review/trigger/o/r/5');
  });

  test('verifyAuditChain calls GET', async () => {
    await verifyAuditChain();
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/audit/verify');
  });

  test('generateComplianceReport sends POST', async () => {
    await generateComplianceReport('SOC2', '2026-01-01', '2026-12-31');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain('/audit/reports');
    expect(calls[0].body).toContain('SOC2');
  });
});
