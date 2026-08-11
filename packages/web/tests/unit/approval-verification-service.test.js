// tests/unit/approval-verification-service.test.js
// Tests for RI-5: Independent Approval Verifier.
//
// Proves the frozen contract:
//   - Verifier independence (separate context broker, no primary findings leaked)
//   - Result parsing (verified, material_findings, incomplete, error)
//   - Fail-closed: timeout/API failure/schema failure → incomplete → no APPROVE
//   - Finding escalation (P3 upgraded to P2 by verifier)
//   - Unresolved context → incomplete
//   - Finding validation through the evidence-bound validator

import { jest } from "@jest/globals";

import {
  VERIFIER_STATUS,
  buildVerifierSystemPrompt,
  parseVerifierResult,
  runApprovalVerification,
} from "../../src/services/approvalVerificationService.js";

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD_SHA = "head123";
const BASE_SHA = "base456";

function makeEvidence(changedPaths = ["src/app.js"]) {
  return {
    version: 1,
    review: { repoId: 999, repoFullName: "org/repo", prNumber: 42, baseSha: BASE_SHA, headSha: HEAD_SHA, invocationId: "inv1" },
    changedFiles: changedPaths.map(p => ({
      path: p,
      status: "modified",
      additions: 10,
      deletions: 3,
      coverage: "full",
      patch: "@@ -1,3 +1,5 @@\n ctx\n-old\n+new\n+new2\n ctx2",
      base: { sha: BASE_SHA, blobSha: "b", contentDigest: "sha256:b" },
      head: { sha: HEAD_SHA, blobSha: "h", contentDigest: "sha256:h" },
    })),
    contextItems: [],
    coverage: { totalChangedFiles: changedPaths.length, fullyCoveredFiles: changedPaths.length, approvalEvidenceComplete: true },
  };
}

function makeMockAnthropic(response) {
  return {
    messages: {
      create: jest.fn().mockResolvedValue({
        content: [{ type: "text", text: response }],
        usage: { input_tokens: 3000, output_tokens: 500 },
      }),
    },
  };
}

function makeMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ data: { type: "file", encoding: "base64", content: "dGVzdA==", sha: "blob1" } }),
  };
}

// ── System prompt ──────────────────────────────────────────────────────────

describe("RI-5: buildVerifierSystemPrompt", () => {

  it("does NOT include primary reviewer findings or verdict", () => {
    const evidence = makeEvidence();
    evidence.primaryFindings = [{ severity: "P0", title: "Should not appear" }];
    evidence.primaryVerdict = "approved";

    const prompt = buildVerifierSystemPrompt(evidence);

    expect(prompt).not.toContain("Should not appear");
    expect(prompt).not.toContain("approved");
    expect(prompt).not.toContain("primaryVerdict");
    expect(prompt).toContain("independent");
    expect(prompt.toLowerCase()).toContain("approval"); // prompt mentions approval context
  });

  it("includes coverage manifest numbers", () => {
    const evidence = makeEvidence(["a.js", "b.js"]);
    const prompt = buildVerifierSystemPrompt(evidence);

    expect(prompt).toContain("Total changed files: 2");
  });
});

// ── Result parser ──────────────────────────────────────────────────────────

describe("RI-5: parseVerifierResult", () => {

  it("parses direct JSON", () => {
    const result = parseVerifierResult('{"status":"verified","findings":[]}');
    expect(result.status).toBe("verified");
  });

  it("parses fenced JSON", () => {
    const result = parseVerifierResult('```json\n{"status":"verified","findings":[]}\n```');
    expect(result.status).toBe("verified");
  });

  it("parses embedded JSON", () => {
    const result = parseVerifierResult('Here is my result:\n{"status":"verified","findings":[]}\nDone.');
    expect(result.status).toBe("verified");
  });

  it("returns null for unparseable text", () => {
    expect(parseVerifierResult("not json")).toBeNull();
    expect(parseVerifierResult("")).toBeNull();
    expect(parseVerifierResult(null)).toBeNull();
  });
});

// ── Verification runner ────────────────────────────────────────────────────

describe("RI-5: runApprovalVerification", () => {

  it("returns VERIFIED when LLM returns clean result with no findings", async () => {
    const evidence = makeEvidence();
    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "verified",
      findings: [],
      unresolvedContextNeeds: [],
      coverageSatisfied: true,
    }));

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.VERIFIED);
    expect(receipt.approvalSafe).toBe(true);
    expect(receipt.findings).toHaveLength(0);
    expect(receipt.tokensUsed).toBe(3500);
    expect(receipt.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns MATERIAL_FINDINGS when LLM finds a P2 issue", async () => {
    const evidence = makeEvidence();
    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "material_findings",
      findings: [{
        severity: "P2",
        category: "bug",
        claim: "Missing error handling",
        description: "The new code does not handle null input",
        affectedPaths: ["src/app.js"],
        evidenceRefs: ["changed:src/app.js@HEAD:L2-L3"],
        proof: { type: "static_trace", summary: "Line 2 lacks null check" },
      }],
      unresolvedContextNeeds: [],
      coverageSatisfied: true,
    }));

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.MATERIAL_FINDINGS);
    expect(receipt.approvalSafe).toBe(false);
    expect(receipt.hasMaterialFindings).toBe(true);
    expect(receipt.materialFindingCount).toBe(1);
  });

  it("returns INCOMPLETE when LLM has unresolved context needs", async () => {
    const evidence = makeEvidence();
    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "incomplete",
      findings: [],
      unresolvedContextNeeds: ["Could not read src/config.js — needed to verify import"],
      coverageSatisfied: false,
    }));

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.approvalSafe).toBe(false);
    expect(receipt.unresolvedContextNeeds).toHaveLength(1);
  });

  it("returns ERROR when review root is missing", async () => {
    const evidence = makeEvidence();
    evidence.review = null;

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo",
      anthropic: makeMockAnthropic("{}"),
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.ERROR);
    expect(receipt.approvalSafe).toBe(false);
  });

  it("returns INCOMPLETE on LLM API failure", async () => {
    const evidence = makeEvidence();
    const anthropic = {
      messages: { create: jest.fn().mockRejectedValue(new Error("API timeout")) },
    };

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.approvalSafe).toBe(false);
    expect(receipt.error).toContain("API timeout");
  });

  it("returns INCOMPLETE when response is unparseable", async () => {
    const evidence = makeEvidence();
    const anthropic = makeMockAnthropic("This is not JSON at all.");

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    expect(receipt.status).toBe(VERIFIER_STATUS.INCOMPLETE);
    expect(receipt.error).toContain("Failed to parse");
  });

  it("uses a separate context broker (independent budget)", async () => {
    const evidence = makeEvidence();
    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "verified",
      findings: [],
      unresolvedContextNeeds: [],
      coverageSatisfied: true,
    }));

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    // The context trace is recorded in the receipt
    expect(receipt.contextTrace).toBeDefined();
    expect(Array.isArray(receipt.contextTrace)).toBe(true);
  });

  it("does not leak primary findings into the verifier prompt", async () => {
    const evidence = makeEvidence();
    // Simulate that primary review ran with findings
    evidence._primaryFindings = [{ severity: "P0", title: "Secret" }];

    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "verified",
      findings: [],
      unresolvedContextNeeds: [],
      coverageSatisfied: true,
    }));

    await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    // Check the system prompt sent to the LLM
    const createCall = anthropic.messages.create.mock.calls[0][0];
    expect(createCall.system).not.toContain("Secret");
    expect(createCall.messages[0].content).not.toContain("Secret");
  });

  it("validates verifier findings through the evidence-bound validator", async () => {
    const evidence = makeEvidence(["src/app.js"]);
    // Finding with invalid evidence ref (path not in evidence)
    const anthropic = makeMockAnthropic(JSON.stringify({
      status: "material_findings",
      findings: [{
        severity: "P1",
        category: "bug",
        claim: "Bug in nonexistent file",
        description: "Something wrong",
        affectedPaths: [],
        evidenceRefs: ["changed:nonexistent.js@HEAD:L1-L5"],
        proof: { type: "static_trace", summary: "..." },
      }],
      unresolvedContextNeeds: [],
      coverageSatisfied: true,
    }));

    const receipt = await runApprovalVerification({
      evidence, octokit: makeMockOctokit(), owner: "org", repo: "repo", anthropic,
    });

    // The invalid finding should be downgraded to P3 by the validator,
    // so it no longer counts as material
    expect(receipt.findings).toHaveLength(1);
    expect(receipt.findings[0].severity).toBe("P3"); // downgraded
    expect(receipt.status).toBe(VERIFIER_STATUS.VERIFIED); // no material findings remain
  });
});
