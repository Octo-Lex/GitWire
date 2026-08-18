// tests/unit/verifier-falsification-ledger.test.js
// RI-5 falsification risk-ledger contract (client ruling 2026-08-18, review
// 4959172520): the verifier's contract is a two-phase falsification protocol —
// enumerate correctness-material risk obligations per generic category, then
// resolve every obligation with repository evidence, a material finding, or
// an unresolved reason. `verified` is COMPUTED from the ledger; any
// unresolved obligation or structurally incomplete ledger fails closed.
// All tests are deterministic — the provider is mocked, zero paid calls.

import { jest } from "@jest/globals";

const {
  VERIFIER_STATUS,
  OBLIGATION_OUTCOMES,
  RISK_CATEGORY_IDS,
  buildVerifierSystemPrompt,
  runApprovalVerification,
  validateRiskLedger,
} = await import("../../src/services/approvalVerificationService.js");
const {
  clearedObligation,
  unresolvedObligation,
  materialObligation,
  completeClearedLedger,
  ledgerWithCategory,
  ledgerMissingCategory,
} = await import("./verifierLedgerFixture.js");

const HEAD_SHA = "head123";
const BASE_SHA = "base456";

function makeEvidence() {
  return {
    version: 1,
    review: { repoId: 999, repoFullName: "org/repo", prNumber: 42, baseSha: BASE_SHA, headSha: HEAD_SHA, invocationId: "inv1" },
    changedFiles: [{
      path: "src/app.js",
      status: "modified",
      additions: 10,
      deletions: 3,
      coverage: "full",
      patch: "@@ -1,3 +1,5 @@\n ctx\n-old\n+new\n+new2\n ctx2",
      base: { sha: BASE_SHA, blobSha: "b", contentDigest: "sha256:b" },
      head: { sha: HEAD_SHA, blobSha: "h", contentDigest: "sha256:h" },
    }],
    contextItems: [],
    coverage: { totalChangedFiles: 1, fullyCoveredFiles: 1, approvalEvidenceComplete: true },
  };
}

function makeMockAnthropic(submission) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "text", text: JSON.stringify(submission) }],
        usage: { input_tokens: 3000, output_tokens: 500 },
        stop_reason: "end_turn",
      }),
    },
  };
}

function makeMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ data: { type: "file", encoding: "base64", content: "dGVzdA==", sha: "blob1" } }),
  };
}

function validFinding() {
  return {
    severity: "P2",
    category: "bug",
    claim: "Missing error handling",
    description: "The new code does not handle null input",
    affectedPaths: ["src/app.js"],
    evidenceRefs: ["changed:src/app.js@HEAD:L2-L3"],
    proof: { type: "static_trace", summary: "Line 2 lacks null check" },
  };
}

async function run(submission, evidence = makeEvidence()) {
  return runApprovalVerification({
    evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo",
    anthropic: makeMockAnthropic(submission),
  });
}

// ── The verified path is ledger-gated ───────────────────────────────────────

describe("RI-5 falsification ledger: verified is computed from the ledger", () => {
  it("verified requires a complete ledger with every obligation evidence-cleared", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: completeClearedLedger(), coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.VERIFIED);
    expect(receipt.riskLedger.complete).toBe(true);
    expect(receipt.riskLedger.categories).toHaveLength(6);
    expect(receipt.unresolvedObligations).toEqual([]);
  });

  it("a declared verified status cannot override an unresolved obligation", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("dependency_interface_contracts", [unresolvedObligation()]),
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.approvalSafe).toBe(false);
    expect(receipt.unresolvedObligations).toHaveLength(1);
    expect(receipt.unresolvedObligations[0].category).toBe("dependency_interface_contracts");
  });

  it("a missing ledger fails closed even with a declared verified status", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("Risk-ledger validation failed");
  });
});

// ── Structural completeness is deterministic ────────────────────────────────

describe("RI-5 falsification ledger: structural completeness gates", () => {
  it("a missing category fails closed", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerMissingCategory("counterexamples"), coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("missing ledger category: counterexamples");
  });

  it("an empty category without noneJustification fails closed", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("state_side_effects", []), coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("state_side_effects: empty category requires a noneJustification");
  });

  it("an empty category WITH a specific noneJustification passes the gate", async () => {
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("state_side_effects", [], "The diff touches pure functions only; no state, I/O, or cleanup paths exist in the changed lines."),
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.VERIFIED);
  });

  it("evidence_cleared without evidenceRefs fails closed — clearing requires evidence", async () => {
    const bad = clearedObligation();
    delete bad.resolution.evidenceRefs;
    const receipt = await run({
      status: "verified", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("changed_behavior", [bad]), coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("evidence_cleared requires at least one evidenceRef");
  });

  it("material_finding with an out-of-bounds findingIndex fails closed", async () => {
    const receipt = await run({
      status: "material_findings", findings: [], unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("normative_docs_tests", [materialObligation()]),
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("material_finding requires findingIndex within findings bounds");
  });
});

// ── Material obligations route through the evidence-bound validator ────────

describe("RI-5 falsification ledger: material obligations", () => {
  it("a material obligation with a valid finding yields MATERIAL_FINDINGS", async () => {
    const receipt = await run({
      status: "material_findings",
      findings: [validFinding()],
      unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("normative_docs_tests", [materialObligation()]),
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.MATERIAL_FINDINGS);
    expect(receipt.materialFindingCount).toBe(1);
  });

  it("a ledger claiming a material obligation with an invalid finding stays fail-closed", async () => {
    const invalid = validFinding();
    delete invalid.evidenceRefs; // fails the evidence-bound validator
    const receipt = await run({
      status: "material_findings",
      findings: [invalid],
      unresolvedContextNeeds: [],
      riskLedger: ledgerWithCategory("normative_docs_tests", [materialObligation()]),
      coverageSatisfied: true,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.approvalSafe).toBe(false);
  });
});

// ── Validator unit level ────────────────────────────────────────────────────

describe("validateRiskLedger unit contract", () => {
  const base = (ledger) => ({ riskLedger: ledger });

  it("accepts the complete cleared ledger", () => {
    const { errors, ledger } = validateRiskLedger(base(completeClearedLedger()), 0);
    expect(errors).toEqual([]);
    expect(ledger.complete).toBe(true);
  });

  it("rejects duplicate categories", () => {
    const dup = completeClearedLedger();
    dup.categories.push({ ...dup.categories[0] });
    const { errors } = validateRiskLedger(base(dup), 0);
    expect(errors.join(" ")).toContain("duplicate ledger category");
  });

  it("rejects unknown categories", () => {
    const bad = completeClearedLedger();
    bad.categories[0].category = "fixture_specific_hints";
    const { errors } = validateRiskLedger(base(bad), 0);
    expect(errors.join(" ")).toContain("unknown ledger category");
  });

  it("rejects unresolved resolutions without a reason", () => {
    const ob = unresolvedObligation();
    delete ob.resolution.reason;
    const { errors } = validateRiskLedger(base(ledgerWithCategory("config_runtime_assumptions", [ob])), 0);
    expect(errors.join(" ")).toContain("unresolved requires a reason");
  });
});

// ── Prompt genericity — the vocabulary stays change-relative ───────────────

describe("RI-5 falsification prompt: generic vocabulary only", () => {
  const prompt = buildVerifierSystemPrompt(makeEvidence());

  it("teaches the two-phase protocol with all six generic categories", () => {
    expect(prompt).toContain("PHASE 1");
    expect(prompt).toContain("PHASE 2");
    for (const id of RISK_CATEGORY_IDS) {
      expect(prompt).toContain('"' + id + '"');
    }
  });

  it("states that the computed status cannot be overridden by the declaration", () => {
    expect(prompt).toContain("The system computes the final status from");
    expect(prompt).toContain("your ledger");
  });

  it("contains NO fixture, corpus, or benchmark specifics", () => {
    const forbidden = [
      "RI-01", "RI-02", "RI-03", "RI-04",
      "basePath", "findCommentByMarker", "dashboard/intelligence",
      "Phase 0", "constitution", "roadmap", "gate 0.5",
      "agent-replacement", "pagination",
    ];
    for (const token of forbidden) {
      expect(prompt).not.toContain(token);
    }
  });
});
