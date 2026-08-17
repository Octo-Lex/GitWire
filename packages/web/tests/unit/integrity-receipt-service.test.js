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

  it("persists full audit receipt with context items, retrieval trace, findings, and budget", async () => {
    const evidence = {
      version: 1,
      review: { repoId: 999, prNumber: 42, baseSha: "base", headSha: "head", invocationId: "inv1" },
      changedFiles: [
        { path: "src/app.js", status: "modified", coverage: "full", additions: 10, deletions: 3,
          representedLines: 13, head: { sha: "head", blobSha: "blob1", contentDigest: "sha256:h" },
          base: { sha: "base", blobSha: "blob0", contentDigest: "sha256:b" } },
      ],
      contextItems: [
        { id: "ctx-0", type: "file_read", path: "config.js", ref: "head",
          resolvedSha: "head", blobSha: "cblob", contentDigest: "sha256:cfg",
          range: { startLine: 1, endLine: 5 }, truncated: false,
          content: "SHOULD NOT BE PERSISTED", retrievalReason: "verify import" },
      ],
      retrievalTrace: [
        { type: "file_read", result: "ok", path: "config.js", ref: "head", round: 1,
          contentLength: 200 },
      ],
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
      contextTrace: [{ type: "file_read", result: "ok", path: "config.js", ref: "head", round: 1 }],
    };

    const decision = {
      event: "APPROVE", checkState: "review_passed", approvalEligible: true,
      decisionReason: "No material findings, evidence complete, verifier clean",
    };

    const primaryFindings = [
      { severity: "P3", category: "maintainability", claim: "Minor style",
        evidenceRefs: ["changed:src/app.js@HEAD:L2-L4"],
        proof: { type: "inference", summary: "Style" }, affectedPaths: ["src/app.js"] },
    ];

    const budgetState = {
      fileReads: 5, searches: 2, retrievedChars: 5000, contextRounds: 1,
      exhausted: false, limits: { maxFileReads: 20 },
    };

    await persistIntegrityReceipt({
      reviewRowId: 1, evidence, verifierReceipt, decision, primaryFindings, budgetState,
      invocationId: "rinv:abc123",
    });

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const params = mockDbQuery.mock.calls[0][1];
    const manifest = JSON.parse(params[0]);

    // Changed files have immutable identity
    expect(manifest.changedFiles[0].head.contentDigest).toBe("sha256:h");
    expect(manifest.changedFiles[0].head.blobSha).toBe("blob1");

    // Context items have immutable identity but NO content
    expect(manifest.contextItems).toHaveLength(1);
    expect(manifest.contextItems[0].path).toBe("config.js");
    expect(manifest.contextItems[0].blobSha).toBe("cblob");
    expect(manifest.contextItems[0].contentDigest).toBe("sha256:cfg");
    expect(manifest.contextItems[0].range).toEqual({ startLine: 1, endLine: 5 });
    // Content MUST NOT be in the manifest
    expect(JSON.stringify(manifest)).not.toContain("SHOULD NOT BE PERSISTED");

    // Retrieval trace entries present
    expect(manifest.retrievalTrace).toHaveLength(1);
    expect(manifest.retrievalTrace[0].type).toBe("file_read");
    expect(manifest.retrievalTrace[0].result).toBe("ok");

    // Primary findings with evidence refs
    expect(manifest.primaryFindings).toHaveLength(1);
    expect(manifest.primaryFindings[0].evidenceRefs).toEqual(["changed:src/app.js@HEAD:L2-L4"]);
    expect(manifest.primaryFindings[0].proofType).toBe("inference");

    // Budget consumption
    expect(manifest.budgetConsumption.fileReads).toBe(5);
    expect(manifest.budgetConsumption.searches).toBe(2);
    expect(manifest.budgetConsumption.retrievedChars).toBe(5000);
    expect(manifest.budgetConsumption.exhausted).toBe(false);
    expect(manifest.budgetConsumption.limits.maxFileReads).toBe(20);

    // Verifier receipt trimmed
    const vReceipt = JSON.parse(params[1]);
    expect(vReceipt.status).toBe("verified");
    expect(vReceipt.contextTrace).toHaveLength(1);
    expect(vReceipt.contextTrace[0].path).toBe("config.js");
    // No full content in verifier receipt either
    expect(JSON.stringify(vReceipt)).not.toContain("SHOULD NOT BE PERSISTED");

    expect(params[2]).toBe(true); // approval_eligible
    expect(params[4]).toBe("rinv:abc123");
  });

  it("handles null verifier receipt and missing budget state", async () => {
    await persistIntegrityReceipt({
      reviewRowId: 2,
      evidence: { coverage: { approvalEvidenceComplete: false } },
      verifierReceipt: null,
      decision: { approvalEligible: false, decisionReason: "verifier not run" },
      primaryFindings: [],
      budgetState: null,
      invocationId: "rinv:def456",
    });

    const params = mockDbQuery.mock.calls[0][1];
    expect(params[1]).toBeNull(); // verification_receipt null
    const manifest = JSON.parse(params[0]);
    expect(manifest.budgetConsumption).toBeNull();
    expect(manifest.primaryFindings).toEqual([]);
  });
});

// ── Observability ────────────────────────────────────────────────────────────

describe("RI-8: recordReviewMetrics", () => {

  it("records all frozen metrics including verifier overturn, coverage reasons, mutation safety, three-way tokens", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "APPROVE", checkState: "review_passed", approvalEligible: true },
      evidence: { coverage: { approvalEvidenceComplete: true, totalChangedFiles: 3,
        fullyCoveredFiles: 2, policyExemptFiles: 1, partialFiles: 0, unavailableFiles: 0,
        limitsExceeded: [] } },
      verifierReceipt: { status: "verified", findings: [], materialFindingCount: 0,
        hasMaterialFindings: false, tokensUsed: 2000, durationMs: 5000,
        unresolvedContextRequests: [], contextTrace: [] },
      primaryFindings: [{ severity: "P3" }],
      primaryTokens: 1500,
      primaryLatencyMs: 3000,
      totalLatencyMs: 10000,
      budgetState: { fileReads: 5, searches: 2, contextRounds: 1, retrievedChars: 5000, exhausted: false },
      mutationRetries: 1,
      duplicatePreventionEvents: 1,
    });

    expect(metrics.event).toBe("APPROVE");
    expect(metrics.verifierOverturn).toBe(false);
    expect(metrics.mutationRetries).toBe(1);
    expect(metrics.duplicatePreventionEvents).toBe(1);
    expect(metrics.coverageFailureReasons).toEqual([]);

    // Three-way token arithmetic: primary + verifier + context retrieval
    expect(metrics.contextRetrievalTokens).toBe(1250); // 5000 chars / 4
    expect(metrics.totalTokens).toBe(1500 + 2000 + 1250); // 4750

    // INSERT includes all frozen columns
    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).toContain("mutation_retries");
    expect(sql).toContain("duplicate_prevention_events");
    expect(sql).toContain("verifier_overturn");
    expect(sql).toContain("context_retrieval_tokens");
  });

  it("records verifier overturn when verifier finds material but primary found none", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "COMMENT", checkState: "review_blocked", approvalEligible: false },
      evidence: { coverage: { approvalEvidenceComplete: true } },
      verifierReceipt: { status: "material_findings", findings: [{ severity: "P1" }],
        materialFindingCount: 1, hasMaterialFindings: true,
        tokensUsed: 2000, durationMs: 5000,
        unresolvedContextRequests: [], contextTrace: [] },
      primaryFindings: [], // primary found nothing material
      primaryTokens: 1000,
    });

    expect(metrics.verifierOverturn).toBe(true);
    // INSERT binds verifier_overturn = true
    const params = mockDbQuery.mock.calls[0][1];
    expect(params).toContain(true); // verifier_overturn bound as true
  });

  it("records coverage failure reasons as JSON array", async () => {
    const metrics = await recordReviewMetrics({
      decision: { event: "COMMENT", checkState: "review_incomplete", approvalEligible: false },
      evidence: { coverage: { approvalEvidenceComplete: false, limitsExceeded: ["line_limit_partial", "pagination_incomplete"] } },
      verifierReceipt: null,
      primaryFindings: [],
    });

    expect(metrics.coverageFailureReasons).toEqual(["line_limit_partial", "pagination_incomplete"]);
  });

  it("emits structured JSON to stdout when metrics table unavailable (fallback sink)", async () => {
    // Suppress console output during this test
    const origWarn = console.warn;
    const origLog = console.log;
    const warnCalls = [];
    const logCalls = [];
    console.warn = (msg) => warnCalls.push(msg);
    console.log = (msg) => logCalls.push(msg);

    mockDbQuery.mockRejectedValueOnce(new Error("relation does not exist"));

    const metrics = await recordReviewMetrics({
      decision: { event: "APPROVE", approvalEligible: true },
      evidence: {},
      verifierReceipt: null,
      primaryFindings: [],
    });

    console.warn = origWarn;
    console.log = origLog;

    expect(metrics.event).toBe("APPROVE");
    // Should have emitted structured JSON to stdout
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(logCalls[0]);
    expect(parsed.type).toBe("review_metrics");
    expect(parsed.event).toBe("APPROVE");
  });
});
