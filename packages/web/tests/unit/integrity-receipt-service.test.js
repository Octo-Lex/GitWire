// tests/unit/integrity-receipt-service.test.js
// Tests for RI-8: persistence and observability.

import { jest } from "@jest/globals";

const mockDbQuery = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockDbQuery },
}));

const { persistIntegrityReceipt, recordReviewMetrics } = await import("../../src/services/integrityReceiptService.js");

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

// ── Persistence ──────────────────────────────────────────────────────────────

describe("RI-8: persistIntegrityReceipt", () => {

  it("persists evidence manifest, verifier receipt, and decision to ai_reviews", async () => {
    const evidence = {
      version: 1,
      review: { repoId: 999, prNumber: 42, baseSha: "base", headSha: "head", invocationId: "inv1" },
      changedFiles: [
        { path: "src/app.js", status: "modified", coverage: "full", additions: 10, deletions: 3,
          representedLines: 13, head: { sha: "head", blobSha: "blob1", contentDigest: "sha256:h" },
          base: { sha: "base", blobSha: "blob0", contentDigest: "sha256:b" } },
      ],
      contextItems: [{ path: "config.js" }],
      retrievalTrace: [{ type: "file_read", result: "ok" }],
      coverage: { totalChangedFiles: 1, fullyCoveredFiles: 1, approvalEvidenceComplete: true,
        policyExemptFiles: 0, partialFiles: 0, unavailableFiles: 0, limitsExceeded: [] },
    };

    const verifierReceipt = {
      status: "verified",
      findings: [],
      hasMaterialFindings: false,
      materialFindingCount: 0,
      coverageSatisfied: true,
      tokensUsed: 2000,
      durationMs: 5000,
      unresolvedContextRequests: [],
      contextTrace: [{ type: "file_read", result: "ok" }],
    };

    const decision = {
      event: "APPROVE",
      checkState: "review_passed",
      approvalEligible: true,
      decisionReason: "No material findings, evidence complete, verifier clean",
    };

    await persistIntegrityReceipt({
      reviewRowId: 1,
      evidence,
      verifierReceipt,
      decision,
      invocationId: "rinv:abc123",
    });

    // One UPDATE call
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("UPDATE ai_reviews SET");
    expect(sql).toContain("evidence_manifest");
    expect(sql).toContain("verification_receipt");
    expect(sql).toContain("approval_eligible");
    expect(sql).toContain("decision_reason");
    expect(sql).toContain("review_invocation_id");
    expect(sql).toContain("integrity_version");

    // Evidence manifest should be JSON (not full file contents)
    const manifest = JSON.parse(params[0]);
    expect(manifest.changedFiles[0].head.contentDigest).toBe("sha256:h");
    expect(manifest.changedFiles[0].head.blobSha).toBe("blob1");
    expect(manifest.contextItemsCount).toBe(1);

    // Verifier receipt is trimmed (no full body)
    const vReceipt = JSON.parse(params[1]);
    expect(vReceipt.status).toBe("verified");
    expect(vReceipt.tokensUsed).toBe(2000);

    expect(params[2]).toBe(true); // approval_eligible
    expect(params[4]).toBe("rinv:abc123"); // invocation ID
    expect(params[5]).toBe(1); // integrity version
  });

  it("handles null verifier receipt (verifier not run)", async () => {
    await persistIntegrityReceipt({
      reviewRowId: 2,
      evidence: { coverage: { approvalEvidenceComplete: false } },
      verifierReceipt: null,
      decision: { approvalEligible: false, decisionReason: "verifier not run" },
      invocationId: "rinv:def456",
    });

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const params = mockDbQuery.mock.calls[0][1];
    expect(params[1]).toBeNull(); // verification_receipt is null
    expect(params[2]).toBe(false); // approval_eligible is false
  });
});

// ── Observability ────────────────────────────────────────────────────────────

describe("RI-8: recordReviewMetrics", () => {

  it("records structured metrics with all frozen fields", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "APPROVE", checkState: "review_passed", approvalEligible: true },
      evidence: { coverage: { approvalEvidenceComplete: true, totalChangedFiles: 3,
        fullyCoveredFiles: 2, policyExemptFiles: 1, partialFiles: 0, unavailableFiles: 0,
        limitsExceeded: [] } },
      verifierReceipt: { status: "verified", findings: [], materialFindingCount: 0,
        tokensUsed: 2000, durationMs: 5000, unresolvedContextRequests: [], contextTrace: [] },
      primaryFindings: [{ severity: "P3" }],
      primaryTokens: 1500,
      primaryLatencyMs: 3000,
      totalLatencyMs: 10000,
      budgetState: { fileReads: 5, searches: 2, contextRounds: 1, retrievedChars: 5000, exhausted: false },
    });

    expect(metrics.event).toBe("APPROVE");
    expect(metrics.coverageComplete).toBe(true);
    expect(metrics.primaryFindingCount).toBe(1);
    expect(metrics.primaryMaterialCount).toBe(0);
    expect(metrics.verifierStatus).toBe("verified");
    expect(metrics.verifierFindingCount).toBe(0);
    expect(metrics.totalTokens).toBe(3500);
    expect(metrics.contextReads).toBe(5);
    expect(metrics.contextExhausted).toBe(false);

    // One INSERT to metrics table
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).toContain("INSERT INTO review_metrics_log");
  });

  it("records incomplete verifier metrics", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "COMMENT", checkState: "review_incomplete", approvalEligible: false },
      evidence: { coverage: { approvalEvidenceComplete: false } },
      verifierReceipt: { status: "incomplete", findings: [], materialFindingCount: 0,
        tokensUsed: 500, durationMs: 2000, unresolvedContextRequests: ["needed X"], contextTrace: [] },
      primaryFindings: [],
      primaryTokens: 1000,
    });

    expect(metrics.verifierStatus).toBe("incomplete");
    expect(metrics.verifierIncomplete).toBe(true);
    expect(metrics.verifierUnresolvedContext).toBe(1);
    expect(metrics.approvalEligible).toBe(false);
  });

  it("records material findings metrics", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "REQUEST_CHANGES", checkState: "review_blocked", approvalEligible: false },
      evidence: { coverage: { approvalEvidenceComplete: true } },
      verifierReceipt: { status: "material_findings", findings: [{ severity: "P1" }],
        materialFindingCount: 1, tokensUsed: 2000, durationMs: 5000,
        unresolvedContextRequests: [], contextTrace: [] },
      primaryFindings: [{ severity: "P0" }],
      primaryTokens: 1500,
    });

    expect(metrics.event).toBe("REQUEST_CHANGES");
    expect(metrics.primaryMaterialCount).toBe(1);
    expect(metrics.verifierMaterialCount).toBe(1);
    expect(metrics.verifierStatus).toBe("material_findings");
  });

  it("handles missing metrics table gracefully (non-fatal)", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("relation does not exist"));

    const metrics = await recordReviewMetrics({
      decision: { event: "APPROVE", approvalEligible: true },
      evidence: {},
      verifierReceipt: null,
      primaryFindings: [],
    });

    // Should not throw — metrics returned even if table missing
    expect(metrics.event).toBe("APPROVE");
  });
});
