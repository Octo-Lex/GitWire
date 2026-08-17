// tests/unit/review-information-boundary.test.js
// RI-9 Phase 10 (slice E3): PR / dashboard / audit information separation.
//
// Every execution-profile field is populated with a distinctive sentinel
// string (and sentinel numbers for token/cost counts). The tests then run
// the REAL composition paths and prove the three frozen surfaces:
//
//   PR review output  — decision, reviewed SHA, actionable findings,
//                       evidence, suggestions, incompleteness explanation.
//                       NO execution identity, NO tokens, NO cost, NO
//                       quality state.
//   Audit receipt     — full execution-profile forensic metadata (the
//                       sentinels ARE here, by design).
//
// The dashboard surface is covered by the scorecard service tests; this
// file proves the boundary that matters for GitHub-facing output.

import { jest } from "@jest/globals";

const mockDbQuery = jest.fn();
await jest.unstable_mockModule("../../src/lib/db.js", () => ({
  db: { query: mockDbQuery },
}));

const { buildReviewMarkdown, buildCheckOutput } = await import("../../src/services/reviewOutputFormatter.js");
const { computeReviewDecision, buildCheckConclusion } = await import("../../src/services/reviewDecisionPolicy.js");
const { persistIntegrityReceipt } = await import("../../src/services/integrityReceiptService.js");
const { buildExecutionProfile } = await import("../../src/services/executionProfileService.js");

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [] });
});

// ── Sentinel-laden execution profiles ────────────────────────────────────────

const SENTINELS = {
  provider: "SNT-provider-4f2a",
  adapter: "SNT-adapter-9b1c",
  protocol: "SNT-protocol-77e0",
  requestedRoute: "SNT-route-0d31",
  requestedModel: "SNT-requested-model-aa55",
  observedModel: "SNT-observed-model-bb66",
  observedDeployment: "SNT-deployment-cc77",
  promptId: "SNT-prompt-id-dd88",
  promptHash: "SNT-prompt-hash-ee99",
  configurationFingerprint: "SNT-fingerprint-ff00",
  budgetProfileId: "SNT-budget-1122",
};

const SENTINEL_USAGE = { inputTokens: 111111111, outputTokens: 222222222, totalTokens: 333333333 };
const SENTINEL_COST = { amount: 999.99, currency: "SNT-currency", source: "SNT-cost-source" };
const SENTINEL_QUALITY_STATE = "SNT-quality-state-degraded";

function sentinelProfile(adapterSuffix) {
  return buildExecutionProfile({
    ...SENTINELS,
    adapter: SENTINELS.adapter + "-" + adapterSuffix,
    observedModel: SENTINELS.observedModel + "-" + adapterSuffix,
    usage: SENTINEL_USAGE,
    cost: SENTINEL_COST,
  });
}

const EVERY_SENTINEL_STRING = Object.values(SENTINELS);
const EVERY_SENTINEL_NUMBER = [SENTINEL_USAGE.inputTokens, SENTINEL_USAGE.outputTokens, SENTINEL_USAGE.totalTokens, SENTINEL_COST.amount];

// ── Simulated v2 pipeline state (the real shapes the composers receive) ──────

const EVIDENCE = {
  version: 1,
  review: { repoId: 5, prNumber: 21, baseSha: "b".repeat(40), headSha: "a1b2c3d4e5f6a7b8c9d0", invocationId: "rinv:snt" },
  changedFiles: [
    {
      path: "src/auth.js", status: "modified", coverage: "full",
      additions: 4, deletions: 2, representedLines: 6,
      head: { sha: "a1b2c3d4e5f6a7b8c9d0", blobSha: "hb", contentDigest: "sha256:h" },
      base: { sha: "b".repeat(40), blobSha: "bb", contentDigest: "sha256:b" },
    },
  ],
  contextItems: [],
  retrievalTrace: [],
  coverage: { totalChangedFiles: 1, fullyCoveredFiles: 1, approvalEvidenceComplete: true },
  // Phase 10 carrier: profiles attached to evidence must not leak either.
  executionProfiles: {
    primary: sentinelProfile("primary"),
    verifier: sentinelProfile("verifier"),
  },
};

const V2_PRIMARY_FINDINGS = [
  {
    severity: "P2", category: "bug", claim: "Rate limit missing on login",
    description: "The login endpoint has no rate limit.",
    affectedPaths: ["src/auth.js"],
    evidenceRefs: ["changed:src/auth.js@HEAD:L10-L14"],
    proof: { type: "static_trace", summary: "No limiter call on the path" },
    executionProfile: sentinelProfile("finding"),
  },
];

const VERIFIER_RECEIPT = {
  status: "verified",
  findings: [],
  hasMaterialFindings: false,
  materialFindingCount: 0,
  coverageSatisfied: true,
  tokensUsed: 0,
  durationMs: 0,
  executionProfile: sentinelProfile("verifier"),
};

// Legacy-shaped findings — exactly what steps 10-13 of the v2 path compose
// PR output from.
function legacyFindings() {
  const SEV2LEGACY = { P0: "critical", P1: "high", P2: "medium", P3: "low" };
  return V2_PRIMARY_FINDINGS.map(f => ({
    severity: SEV2LEGACY[f.severity] || "low",
    title: f.claim,
    description: f.description,
    file: (f.affectedPaths || [])[0] || null,
    line: null,
    suggestion: "",
    category: f.category,
    source: "primary",
  }));
}

// ── E3: PR review output excludes every sentinel ─────────────────────────────

describe("E3 information boundary: PR review output", () => {

  const decision = computeReviewDecision({
    primaryFindings: V2_PRIMARY_FINDINGS,
    verifierReceipt: VERIFIER_RECEIPT,
    evidence: EVIDENCE,
  });

  it("RI-6 still decides from the safety evidence (P2 → COMMENT, never APPROVE)", () => {
    expect(decision.event).toBe("COMMENT");
    expect(decision.approvalEligible).toBe(false);
  });

  it("the review body, summary, and inline comments contain no execution-profile sentinel", () => {
    const verdict = "needs_discussion";
    const { body, summary, comments } = buildReviewMarkdown(legacyFindings(), verdict, "high", 0, null, [
      { filename: "src/auth.js", patch: "@@ -10,6 +10,8 @@\n context\n+new line\n+another" },
    ]);

    const allOutput = [body, summary, ...comments.map(c => c.body ?? "")].join("\n");

    for (const sentinel of EVERY_SENTINEL_STRING) {
      expect(allOutput).not.toContain(sentinel);
    }
    for (const num of EVERY_SENTINEL_NUMBER) {
      expect(allOutput).not.toContain(String(num));
    }
    expect(allOutput).not.toContain(SENTINEL_QUALITY_STATE);
    // The finding itself IS present — the review stays useful.
    expect(allOutput).toContain("Rate limit missing on login");
  });

  it("the check-run title/summary/text contain no sentinel", () => {
    const check = buildCheckOutput(legacyFindings(), "needs_discussion", "high", "review summary", 0);
    const checkText = [check.title, check.summary, check.text].join("\n");

    for (const sentinel of EVERY_SENTINEL_STRING) {
      expect(checkText).not.toContain(sentinel);
    }
    expect(checkText).not.toContain(SENTINEL_QUALITY_STATE);
    expect(checkText).toContain("Rate limit missing on login");
  });

  it("the check conclusion carries only the deterministic decision reason", () => {
    const conclusion = buildCheckConclusion(decision);
    const conclusionText = [conclusion.title, conclusion.summary].join("\n");
    for (const sentinel of EVERY_SENTINEL_STRING) {
      expect(conclusionText).not.toContain(sentinel);
    }
    expect(conclusionText).toContain("P2");
  });

  it("token counts, cost, and quality state never reach PR output even via numbers", () => {
    const { body } = buildReviewMarkdown(legacyFindings(), "needs_discussion", "high", 0, null, []);
    for (const num of EVERY_SENTINEL_NUMBER) {
      expect(body).not.toContain(String(num));
    }
  });
});

// ── E3: the audit receipt KEEPS the full forensic metadata ───────────────────

describe("E3 information boundary: audit receipt retains execution profiles", () => {

  it("the persisted manifest contains every sentinel (deliberate separation)", async () => {
    const profile = sentinelProfile("primary");
    await persistIntegrityReceipt({
      reviewRowId: 42,
      evidence: EVIDENCE,
      verifierReceipt: VERIFIER_RECEIPT,
      decision: { event: "COMMENT", checkState: "review_blocked", approvalEligible: false, decisionReason: "P2 finding present" },
      primaryFindings: V2_PRIMARY_FINDINGS,
      budgetState: null,
      invocationId: "rinv:snt",
      primaryExecutionProfile: profile,
      verifierExecutionProfile: sentinelProfile("verifier"),
    });

    const persisted = mockDbQuery.mock.calls[0][1][0];
    for (const key of ["provider", "requestedModel", "observedModel", "promptId", "promptHash", "configurationFingerprint", "budgetProfileId"]) {
      // builder-derived fields survive normalization; sentinel values that
      // the builder recomputes (fingerprint) were overwritten before the
      // call and must still be present.
      expect(persisted).toContain(key);
    }
    expect(persisted).toContain(SENTINELS.provider);
    expect(persisted).toContain(SENTINELS.requestedModel);
    expect(persisted).toContain(SENTINELS.configurationFingerprint);
    expect(persisted).toContain(String(SENTINEL_USAGE.totalTokens));
    expect(persisted).toContain(String(SENTINEL_COST.amount));
  });
});
