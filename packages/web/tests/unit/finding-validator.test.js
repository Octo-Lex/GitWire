// tests/unit/finding-validator.test.js
// Tests for RI-4: evidence-bound finding schema and validation.
//
// Proves the frozen CI gates:
//   P2 finding without evidence → rejected
//   cross-file evidence references validated
//   invalid evidence reference → rejected or downgraded
//   P3 findings don't require evidence
//   valid P0/P1/P2 with evidence → accepted

import {
  SEVERITY,
  PROOF_TYPES,
  parseEvidenceRef,
  validateFinding,
  validateFindings,
} from "../../src/services/findingValidator.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

function makeEvidence(changedPaths = ["src/app.js", "src/utils.js"]) {
  return {
    version: 1,
    review: { baseSha: "base", headSha: "head", invocationId: "inv1" },
    changedFiles: changedPaths.map(p => ({
      path: p,
      status: "modified",
      coverage: "full",
      base: { sha: "base", blobSha: "b_" + p, contentDigest: "sha256:base_" + p },
      head: { sha: "head", blobSha: "h_" + p, contentDigest: "sha256:head_" + p },
    })),
    contextItems: [],
    coverage: { approvalEvidenceComplete: true },
  };
}

const CONTEXT_ITEMS = [
  { path: "src/config.js", type: "file_read", ref: "head", resolvedSha: "head" },
];

function makeFinding(overrides = {}) {
  return {
    findingId: "F-1",
    severity: "P2",
    category: "bug",
    claim: "The subtract function uses + instead of -",
    description: "src/calculator.js subtract() returns a+b instead of a-b",
    affectedPaths: ["src/calculator.js"],
    evidenceRefs: ["changed:src/calculator.js@HEAD:L5-L7"],
    proof: { type: "static_trace", summary: "Line 5 shows return a + b" },
    confidence: 0.8,
    ...overrides,
  };
}

// ── Evidence reference parser ───────────────────────────────────────────────

describe("RI-4: parseEvidenceRef", () => {

  it("parses a changed-file range reference", () => {
    const result = parseEvidenceRef("changed:src/foo.js@HEAD:L20-L35");
    expect(result.type).toBe("changed");
    expect(result.path).toBe("src/foo.js");
    expect(result.side).toBe("HEAD");
    expect(result.startLine).toBe(20);
    expect(result.endLine).toBe(35);
  });

  it("parses a repo-read single-line reference", () => {
    const result = parseEvidenceRef("repo-read:src/bar.js@BASE:L55");
    expect(result.type).toBe("repo-read");
    expect(result.path).toBe("src/bar.js");
    expect(result.side).toBe("BASE");
    expect(result.startLine).toBe(55);
    expect(result.endLine).toBe(55);
  });

  it("returns null for unparseable references", () => {
    expect(parseEvidenceRef("not a ref")).toBeNull();
    expect(parseEvidenceRef("")).toBeNull();
    expect(parseEvidenceRef(null)).toBeNull();
    expect(parseEvidenceRef("changed:src/foo.js")).toBeNull(); // missing @SIDE:L part
  });
});

// ── Finding validation ──────────────────────────────────────────────────────

describe("RI-4: validateFinding", () => {

  it("accepts a valid P2 finding with evidence reference to a changed file", () => {
    const evidence = makeEvidence(["src/calculator.js"]);
    const finding = makeFinding();
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validEvidenceRefs).toHaveLength(1);
  });

  it("rejects a P0 finding with no evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({
      severity: "P0",
      evidenceRefs: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("requires at least one valid evidence reference");
  });

  it("rejects a P2 finding with no evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ evidenceRefs: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("requires at least one valid evidence reference");
  });

  it("downgrades a P2 finding when all evidence refs are invalid (path not in evidence)", () => {
    const evidence = makeEvidence(["src/app.js"]); // does NOT contain src/calculator.js
    const finding = makeFinding({
      evidenceRefs: ["changed:src/calculator.js@HEAD:L5-L7"],
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true); // not rejected — downgraded
    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
    expect(result.finding.downgradeReason).toContain("invalid");
  });

  it("accepts a P3 finding without evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({
      severity: "P3",
      evidenceRefs: [],
      proof: { type: "inference", summary: "Style suggestion" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
  });

  it("validates repo-read evidence refs against contextItems", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      evidenceRefs: ["repo-read:src/config.js@HEAD:L10-L15"],
      affectedPaths: ["src/config.js"],
    });
    const result = validateFinding(finding, evidence, CONTEXT_ITEMS);

    expect(result.valid).toBe(true);
    expect(result.validEvidenceRefs).toHaveLength(1);
  });

  it("rejects repo-read evidence ref when path is not in evidence or context", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      evidenceRefs: ["repo-read:nonexistent.js@HEAD:L1"],
    });
    const result = validateFinding(finding, evidence, CONTEXT_ITEMS);

    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
  });

  it("rejects a finding with invalid severity", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ severity: "P9" });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid or missing severity");
  });

  it("rejects a finding with missing claim", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ claim: null });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Missing or invalid claim");
  });

  it("warns on behavior claim with inference proof at P1", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      category: "bug",
      evidenceRefs: ["changed:src/app.js@HEAD:L5-L7"],
      proof: { type: "inference", summary: "I think this might be wrong" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("inference"))).toBe(true);
  });

  it("accepts behavior claim with static_trace proof at P0", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P0",
      category: "security",
      evidenceRefs: ["changed:src/app.js@HEAD:L5-L7"],
      proof: { type: "static_trace", summary: "SQL injection at line 5" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("inference"))).toBe(false);
  });
});

// ── Batch validation ────────────────────────────────────────────────────────

describe("RI-4: validateFindings (batch)", () => {

  it("separates valid, rejected, and downgraded findings", () => {
    const evidence = makeEvidence(["src/app.js", "src/utils.js"]);
    const findings = [
      // Valid P2 with evidence
      makeFinding({
        findingId: "F-1",
        evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      }),
      // Rejected — P1 with no evidence
      makeFinding({
        findingId: "F-2",
        severity: "P1",
        evidenceRefs: [],
      }),
      // Downgraded — P2 with invalid ref
      makeFinding({
        findingId: "F-3",
        evidenceRefs: ["changed:nonexistent.js@HEAD:L1"],
      }),
    ];

    const result = validateFindings(findings, evidence);

    expect(result.valid).toHaveLength(2); // F-1 (valid) + F-3 (downgraded to P3)
    expect(result.rejected).toHaveLength(1); // F-2
    expect(result.downgraded).toHaveLength(1); // F-3
    expect(result.rejected[0].finding.findingId).toBe("F-2");
  });

  it("handles empty findings array", () => {
    const result = validateFindings([], makeEvidence());
    expect(result.valid).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("handles null/undefined findings", () => {
    const result = validateFindings(null, makeEvidence());
    expect(result.valid).toHaveLength(0);
  });
});
