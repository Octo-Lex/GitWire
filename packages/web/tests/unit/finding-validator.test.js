// tests/unit/finding-validator.test.js
// Tests for RI-4: evidence-bound finding schema and validation.

import {
  SEVERITY,
  PROOF_TYPES,
  parseEvidenceRef,
  validateFinding,
  validateFindings,
} from "../../src/services/findingValidator.js";

// ── Test fixtures ───────────────────────────────────────────────────────────

const HEAD_SHA = "head123";
const BASE_SHA = "base456";

function makeEvidence(changedPaths = ["src/app.js", "src/utils.js"]) {
  return {
    version: 1,
    review: { baseSha: BASE_SHA, headSha: HEAD_SHA, invocationId: "inv1", repoId: 999, repoFullName: "org/repo", prNumber: 42 },
    changedFiles: changedPaths.map(p => ({
      path: p,
      status: "modified",
      coverage: "full",
      representedLines: 100,
      base: { sha: BASE_SHA, blobSha: "b_" + p, contentDigest: "sha256:base_" + p },
      head: { sha: HEAD_SHA, blobSha: "h_" + p, contentDigest: "sha256:head_" + p },
      // Patch with hunks at lines 1-10 (HEAD side) and 1-10 (BASE side)
      patch: "@@ -1,5 +1,7 @@\n old line 1\n-old line 2\n+new line 2\n+new line 2b\n context line\n-old line 4\n+new line 4\n context line 5",
    })),
    contextItems: [],
    coverage: { approvalEvidenceComplete: true },
  };
}

function makeEvidenceWithStatus(path, status) {
  return {
    version: 1,
    review: { baseSha: BASE_SHA, headSha: HEAD_SHA, invocationId: "inv1", repoId: 999, repoFullName: "org/repo", prNumber: 42 },
    changedFiles: [{
      path,
      status,
      coverage: "full",
      representedLines: 100,
      base: status === "added" ? null : { sha: BASE_SHA, blobSha: "b", contentDigest: "sha256:b" },
      head: status === "removed" ? null : { sha: HEAD_SHA, blobSha: "h", contentDigest: "sha256:h" },
    }],
    contextItems: [],
    coverage: { approvalEvidenceComplete: true },
  };
}

const CONTEXT_ITEMS = [
  { path: "src/config.js", type: "file_read", ref: HEAD_SHA, resolvedSha: HEAD_SHA },
];

function makeFinding(overrides = {}) {
  return {
    findingId: "F-1",
    severity: "P2",
    category: "bug",
    claim: "The subtract function uses + instead of -",
    description: "src/calculator.js subtract() returns a+b instead of a-b",
    affectedPaths: [],
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
  });
});

// ── Finding validation ──────────────────────────────────────────────────────

describe("RI-4: validateFinding", () => {

  it("accepts a valid P2 finding with evidence reference to a changed file", () => {
    const evidence = makeEvidence(["src/calculator.js"]);
    const finding = makeFinding({ affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.validEvidenceRefs).toHaveLength(1);
  });

  it("rejects a P0 finding with no evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ severity: "P0", evidenceRefs: [], affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("requires at least one valid evidence reference");
  });

  it("rejects a P2 finding with no evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ evidenceRefs: [], affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("requires at least one valid evidence reference");
  });

  it("downgrades a P2 finding when ALL evidence refs are invalid (path not in evidence)", () => {
    const evidence = makeEvidence(["src/app.js"]); // does NOT contain src/calculator.js
    const finding = makeFinding({ affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true); // not rejected — downgraded
    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
  });

  it("downgrades a P2 finding when SOME evidence refs are invalid (mixed valid/invalid)", () => {
    const evidence = makeEvidence(["src/app.js", "src/calculator.js"]);
    const finding = makeFinding({
      evidenceRefs: [
        "changed:src/calculator.js@HEAD:L5-L7",  // valid
        "changed:nonexistent.js@HEAD:L1-L5",       // invalid — path not in evidence
      ],
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true); // not rejected — downgraded
    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
    expect(result.finding.downgradeReason).toContain("invalid");
  });

  it("rejects evidence ref citing BASE on an added file (no BASE side)", () => {
    const evidence = makeEvidenceWithStatus("src/new.js", "added");
    const finding = makeFinding({
      evidenceRefs: ["changed:src/new.js@BASE:L1-L5"], // added file has no BASE
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.downgraded).toBe(true); // downgraded because ref is invalid
    expect(result.finding.severity).toBe("P3");
  });

  it("rejects evidence ref citing HEAD on a removed file (no HEAD side)", () => {
    const evidence = makeEvidenceWithStatus("src/deleted.js", "removed");
    const finding = makeFinding({
      evidenceRefs: ["changed:src/deleted.js@HEAD:L1-L5"],
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
  });

  it("accepts a P3 finding without evidence references", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({
      severity: "P3",
      evidenceRefs: [],
      affectedPaths: [],
      proof: { type: "inference", summary: "Style suggestion" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
  });

  it("validates repo-read evidence refs against contextItems with matching ref", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      evidenceRefs: ["repo-read:src/config.js@HEAD:L10-L15"],
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence, CONTEXT_ITEMS);

    expect(result.valid).toBe(true);
    expect(result.validEvidenceRefs).toHaveLength(1);
  });

  it("rejects repo-read evidence ref when context item ref does not match requested side", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const wrongContext = [{ path: "src/config.js", type: "file_read", ref: BASE_SHA, resolvedSha: BASE_SHA }];
    const finding = makeFinding({
      severity: "P1",
      evidenceRefs: ["repo-read:src/config.js@HEAD:L10-L15"], // requests HEAD but context is at BASE
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence, wrongContext);

    expect(result.downgraded).toBe(true);
    expect(result.finding.severity).toBe("P3");
  });

  // ── Cross-file affectedPath validation ───────────────────────────────────

  it("rejects a P2 finding whose affectedPath is not in evidence", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: ["src/nonexistent.js"], // not in evidence
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("affectedPath not in evidence");
  });

  it("accepts a P3 finding whose affectedPath is not in evidence (warning only)", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P3",
      evidenceRefs: [],
      affectedPaths: ["src/nonexistent.js"],
      proof: { type: "inference", summary: "Maybe affects this file" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("affectedPath"))).toBe(true);
  });

  // ── Proof validation ─────────────────────────────────────────────────────

  it("rejects a P1 behavior finding with no proof object", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      category: "bug",
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: [],
      proof: null,
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("requires a proof object");
  });

  it("rejects a P0 finding with invalid proof type", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P0",
      category: "security",
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: [],
      proof: { type: "guess", summary: "I'm guessing" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid or missing proof type");
  });

  it("accepts a P1 behavior finding with inference proof (warned)", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P1",
      category: "bug",
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: [],
      proof: { type: "inference", summary: "I think this might be wrong" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("inference"))).toBe(true);
  });

  it("accepts a P0 security finding with static_trace proof", () => {
    const evidence = makeEvidence(["src/app.js"]);
    const finding = makeFinding({
      severity: "P0",
      category: "security",
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: [],
      proof: { type: "static_trace", summary: "SQL injection at line 5" },
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
  });

  // ── Range-bound evidence validation ──────────────────────────────────────

  it("rejects evidence ref citing a line outside the patch hunks", () => {
    const evidence = makeEvidence(["src/app.js"]); // patch hunks cover lines 1-7
    const finding = makeFinding({
      evidenceRefs: ["changed:src/app.js@HEAD:L999-L1000"], // way outside
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.downgraded).toBe(true); // ref invalid → downgraded
    expect(result.invalidEvidenceRefs[0].reason).toBe("line_range_not_in_patch_hunks");
  });

  it("accepts evidence ref citing a line within the patch hunks", () => {
    const evidence = makeEvidence(["src/app.js"]); // patch hunks at lines 1-7
    const finding = makeFinding({
      evidenceRefs: ["changed:src/app.js@HEAD:L2-L4"], // within range
      affectedPaths: [],
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.validEvidenceRefs).toHaveLength(1);
  });

  // ── affectedPaths checks evidence.contextItems ───────────────────────────

  it("accepts a P2 finding whose affectedPath exists only in evidence.contextItems", () => {
    const evidence = makeEvidence(["src/app.js"]);
    evidence.contextItems = [{ path: "src/config.js", type: "file_read", ref: HEAD_SHA }];
    const finding = makeFinding({
      evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
      affectedPaths: ["src/config.js"], // in evidence.contextItems, not changedFiles
    });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // ── Basic field validation ───────────────────────────────────────────────

  it("rejects a finding with invalid severity", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ severity: "P9", affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Invalid or missing severity");
  });

  it("rejects a finding with missing claim", () => {
    const evidence = makeEvidence();
    const finding = makeFinding({ claim: null, affectedPaths: [] });
    const result = validateFinding(finding, evidence);

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Missing or invalid claim");
  });
});

// ── Batch validation ────────────────────────────────────────────────────────

describe("RI-4: validateFindings (batch)", () => {

  it("separates valid, rejected, and downgraded findings", () => {
    const evidence = makeEvidence(["src/app.js", "src/utils.js"]);
    const findings = [
      makeFinding({
        findingId: "F-1",
        evidenceRefs: ["changed:src/app.js@HEAD:L1-L5"],
        affectedPaths: [],
      }),
      makeFinding({
        findingId: "F-2",
        severity: "P1",
        evidenceRefs: [],
        affectedPaths: [],
      }),
      makeFinding({
        findingId: "F-3",
        evidenceRefs: ["changed:nonexistent.js@HEAD:L1"],
        affectedPaths: [],
      }),
    ];

    const result = validateFindings(findings, evidence);

    expect(result.valid).toHaveLength(2); // F-1 (valid) + F-3 (downgraded)
    expect(result.rejected).toHaveLength(1); // F-2
    expect(result.downgraded).toHaveLength(1); // F-3
  });

  it("handles empty and null findings", () => {
    expect(validateFindings([], makeEvidence()).valid).toHaveLength(0);
    expect(validateFindings(null, makeEvidence()).valid).toHaveLength(0);
  });
});
