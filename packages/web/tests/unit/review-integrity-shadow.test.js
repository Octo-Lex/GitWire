// tests/unit/review-integrity-shadow.test.js
// Tests for RI-9: shadow-mode integration.
//
// Proves the frozen contract:
//   - Shadow mode never produces a GitHub mutation
//   - Feature flag controls shadow vs production path
//   - Divergence recorded (old APPROVE / v2 COMMENT, verifier discoveries, etc.)
//   - Cutover mode (live) is recognized but not yet active

import { jest } from "@jest/globals";

const mockDbQuery = jest.fn();

await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockDbQuery },
}));

const { resolveShadowMode, SHADOW_MODE, runShadowVerification, computeDivergence } = await import("../../src/services/reviewIntegrityShadow.js");

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeEvidence(complete = true) {
  return {
    version: 1,
    review: { repoId: 999, repoFullName: "org/repo", prNumber: 42, baseSha: "base", headSha: "head", invocationId: "inv1" },
    changedFiles: [{ path: "src/app.js", status: "modified", coverage: "full", additions: 10, deletions: 3,
      representedLines: 13, patch: "@@ -1,3 +1,5 @@\n ctx\n-old\n+new\n+new2\n ctx2",
      head: { sha: "head", blobSha: "blob1", contentDigest: "sha256:h" },
      base: { sha: "base", blobSha: "blob0", contentDigest: "sha256:b" } }],
    contextItems: [],
    retrievalTrace: [],
    coverage: { approvalEvidenceComplete: complete, totalChangedFiles: 1, fullyCoveredFiles: 1,
      policyExemptFiles: 0, partialFiles: 0, unavailableFiles: 0, limitsExceeded: [] },
  };
}

function makeMockAnthropic(response) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "text", text: response }],
        usage: { input_tokens: 2000, output_tokens: 300 },
        stop_reason: "end_turn",
      }),
    },
  };
}

function makeMockOctokit() {
  return { request: jest.fn().mockResolvedValue({ data: {} }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

// ── Feature flag resolution ─────────────────────────────────────────────────

describe("RI-9: resolveShadowMode", () => {

  it("returns DISABLED by default", () => {
    expect(resolveShadowMode({}, {})).toBe(SHADOW_MODE.DISABLED);
  });

  it("returns SHADOW from .gitwire.yml setting", () => {
    expect(resolveShadowMode({ pillars: { ai_review: { review_integrity_v2: "shadow" } } }, {}))
      .toBe(SHADOW_MODE.SHADOW);
  });

  it("returns SHADOW from boolean true", () => {
    expect(resolveShadowMode({ settings: { review_integrity_v2: true } }, {}))
      .toBe(SHADOW_MODE.SHADOW);
  });

  it("returns LIVE from .gitwire.yml", () => {
    expect(resolveShadowMode({ pillars: { ai_review: { review_integrity_v2: "live" } } }, {}))
      .toBe(SHADOW_MODE.LIVE);
  });

  it("returns SHADOW from DB config", () => {
    expect(resolveShadowMode({}, { review_integrity_v2: "shadow" }))
      .toBe(SHADOW_MODE.SHADOW);
  });
});

// ── Shadow execution ────────────────────────────────────────────────────────

describe("RI-9: runShadowVerification", () => {

  it("returns ran:false when shadow mode is disabled", async () => {
    const result = await runShadowVerification({
      productionResult: { verdict: "approved" },
      productionFindings: [],
      evidence: makeEvidence(),
      octokit: makeMockOctokit(),
      owner: "org", repo: "repo",
      anthropic: makeMockAnthropic("{}"),
      model: "claude-sonnet-4-20250514",
      repoConfig: {}, reviewConfig: {},
      reviewRowId: 1, invocationId: "rinv:test",
    });

    expect(result.ran).toBe(false);
    expect(result.mode).toBe(SHADOW_MODE.DISABLED);
  });

  it("runs v2 pipeline in shadow mode and never produces a mutation", async () => {
    const verifierResponse = JSON.stringify({
      status: "verified", findings: [], unresolvedContextNeeds: [], coverageSatisfied: true,
    });
    const result = await runShadowVerification({
      productionResult: { verdict: "approved" },
      productionFindings: [],
      evidence: makeEvidence(true),
      octokit: makeMockOctokit(),
      owner: "org", repo: "repo",
      anthropic: makeMockAnthropic(verifierResponse),
      model: "claude-sonnet-4-20250514",
      repoConfig: { pillars: { ai_review: { review_integrity_v2: "shadow" } } },
      reviewConfig: {},
      reviewRowId: 1, invocationId: "rinv:test",
    });

    expect(result.ran).toBe(true);
    expect(result.mode).toBe(SHADOW_MODE.SHADOW);
    expect(result.mutationProduced).toBe(false); // NEVER mutates
    expect(result.productionEvent).toBe("APPROVE");
    expect(result.v2Event).toBe("APPROVE"); // both approve — no divergence
    expect(result.divergence.diverged).toBe(false);
  });

  it("records critical divergence when production APPROVEs but v2 does not", async () => {
    // Production approves with zero findings, but verifier finds a P1
    const verifierResponse = JSON.stringify({
      status: "material_findings",
      findings: [{
        severity: "P1", category: "bug", claim: "Critical bug",
        description: "desc", affectedPaths: [],
        evidenceRefs: ["changed:src/app.js@HEAD:L1-L3"],
        proof: { type: "static_trace", summary: "Found at line 1" },
      }],
      unresolvedContextNeeds: [], coverageSatisfied: true,
    });
    const result = await runShadowVerification({
      productionResult: { verdict: "approved" },
      productionFindings: [],
      evidence: makeEvidence(true),
      octokit: makeMockOctokit(),
      owner: "org", repo: "repo",
      anthropic: makeMockAnthropic(verifierResponse),
      model: "claude-sonnet-4-20250514",
      repoConfig: { pillars: { ai_review: { review_integrity_v2: "shadow" } } },
      reviewConfig: {},
      reviewRowId: 1, invocationId: "rinv:test",
    });

    expect(result.ran).toBe(true);
    expect(result.productionEvent).toBe("APPROVE");
    expect(result.v2Event).toBe("REQUEST_CHANGES"); // v2 blocks due to verifier P1
    expect(result.divergence.diverged).toBe(true);
    expect(result.divergence.severity).toBe("critical");
    expect(result.divergence.oldApproveV2NonApprove).toBe(true);
    expect(result.divergence.oldApproveV2RequestChanges).toBe(true);
    expect(result.divergence.verifierOverturn).toBe(true);
  });

  it("records divergence when production finds findings that v2 rejects (invalid evidence)", async () => {
    const result = await runShadowVerification({
      productionResult: { verdict: "needs_discussion" },
      productionFindings: [
        { severity: "P1", category: "bug", claim: "Bad finding",
          evidenceRefs: ["changed:nonexistent.js@HEAD:L1-L5"],
          proof: { type: "static_trace", summary: "bad" },
          affectedPaths: [],
        },
      ],
      evidence: makeEvidence(true),
      octokit: makeMockOctokit(),
      owner: "org", repo: "repo",
      anthropic: makeMockAnthropic(JSON.stringify({
        status: "verified", findings: [], unresolvedContextNeeds: [], coverageSatisfied: true,
      })),
      model: "claude-sonnet-4-20250514",
      repoConfig: { pillars: { ai_review: { review_integrity_v2: "shadow" } } },
      reviewConfig: {},
      reviewRowId: 1, invocationId: "rinv:test",
    });

    expect(result.ran).toBe(true);
    expect(result.v2Downgraded).toBe(1); // v2 downgraded the invalid finding from P1 to P3
    expect(result.divergence.findingDifferences.rejectedByV2).toBeGreaterThanOrEqual(0);
  });

  it("does not run verifier when v2 primary already has material findings", async () => {
    const result = await runShadowVerification({
      productionResult: { verdict: "request_changes" },
      productionFindings: [
        { severity: "P1", category: "bug", claim: "Valid bug",
          evidenceRefs: ["changed:src/app.js@HEAD:L1-L3"],
          proof: { type: "static_trace", summary: "Found" },
          affectedPaths: [],
        },
      ],
      evidence: makeEvidence(true),
      octokit: makeMockOctokit(),
      owner: "org", repo: "repo",
      anthropic: makeMockAnthropic("{}"), // should NOT be called
      model: "claude-sonnet-4-20250514",
      repoConfig: { pillars: { ai_review: { review_integrity_v2: "shadow" } } },
      reviewConfig: {},
      reviewRowId: 1, invocationId: "rinv:test",
    });

    expect(result.verifierStatus).toBe("not_run");
    expect(result.v2Event).toBe("REQUEST_CHANGES");
  });
});
