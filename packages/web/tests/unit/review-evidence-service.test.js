// tests/unit/review-evidence-service.test.js
// Tests for RI-2: ReviewEvidence schema, changed-file acquisition,
// policy exemption, and coverage preflight.
//
// All tests are deterministic — no model calls, no network.

import {
  COVERAGE,
  EXEMPTION_RULES,
  classifyExemption,
  acquireChangedFiles,
  buildReviewEvidence,
} from "../../src/services/reviewEvidenceService.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(filename, overrides = {}) {
  return {
    filename,
    status: "modified",
    additions: 10,
    deletions: 3,
    patch: "@@ -1,3 +1,5 @@\n+new line\n",
    sha: "blob_" + filename,
    ...overrides,
  };
}

function makeOctokit(pages) {
  const calls = [];
  return {
    request: function(route, params) {
      calls.push({ route, params });
      if (route.includes("/pulls/") && route.includes("/files")) {
        const page = params.page || 1;
        const data = pages[page - 1] || [];
        return Promise.resolve({ data });
      }
      return Promise.resolve({ data: {} });
    },
    _calls: calls,
  };
}

const REVIEW_ROOT = {
  repoId: 999,
  repoFullName: "org/repo",
  prNumber: 42,
  baseSha: "base123",
  headSha: "head456",
  invocationId: "inv-001",
};

// ── Exemption classification ─────────────────────────────────────────────────

describe("RI-2: classifyExemption", () => {

  it("exempts binary files by extension", () => {
    const result = classifyExemption(makeFile("logo.png"));
    expect(result.rule).toBe(EXEMPTION_RULES.BINARY);
    expect(result.source).toBe("built_in");
  });

  it("exempts generated artifacts (dist/, build/, .min.js)", () => {
    expect(classifyExemption(makeFile("dist/bundle.js")).rule).toBe(EXEMPTION_RULES.GENERATED_ARTIFACT);
    expect(classifyExemption(makeFile("build/output.js")).rule).toBe(EXEMPTION_RULES.GENERATED_ARTIFACT);
    expect(classifyExemption(makeFile("app.min.js")).rule).toBe(EXEMPTION_RULES.GENERATED_ARTIFACT);
  });

  it("exempts vendored source (vendor/, node_modules/)", () => {
    expect(classifyExemption(makeFile("vendor/lib.js")).rule).toBe(EXEMPTION_RULES.VENDORED_SOURCE);
    expect(classifyExemption(makeFile("node_modules/react/index.js")).rule).toBe(EXEMPTION_RULES.VENDORED_SOURCE);
  });

  it("exempts configured ignore patterns using minimatch glob semantics", () => {
    const result = classifyExemption(
      makeFile("secrets/private.key"),
      ["secrets/*"]
    );
    expect(result.rule).toBe(EXEMPTION_RULES.CONFIGURED_IGNORE);
    expect(result.source).toBe("repository_policy");
  });

  it("exempts pure renames with no content change", () => {
    const result = classifyExemption(makeFile("new-name.js", {
      status: "renamed",
      additions: 0,
      deletions: 0,
      previous_filename: "old-name.js",
    }));
    expect(result.rule).toBe(EXEMPTION_RULES.PURE_RENAME);
  });

  it("does NOT exempt renames with content changes", () => {
    const result = classifyExemption(makeFile("new-name.js", {
      status: "renamed",
      additions: 5,
      deletions: 2,
      previous_filename: "old-name.js",
    }));
    expect(result).toBeNull();
  });

  it("does NOT exempt lockfiles (not globally exempt)", () => {
    expect(classifyExemption(makeFile("package-lock.json"))).toBeNull();
    expect(classifyExemption(makeFile("yarn.lock"))).toBeNull();
    expect(classifyExemption(makeFile("Cargo.lock"))).toBeNull();
  });

  it("does NOT classify missing patch as binary (may be large)", () => {
    const result = classifyExemption(makeFile("large.js", { patch: undefined }));
    expect(result).toBeNull(); // not exempt — buildReviewEvidence handles as unavailable
  });

  it("returns null for normal source files", () => {
    expect(classifyExemption(makeFile("src/app.js"))).toBeNull();
    expect(classifyExemption(makeFile("docs/guide.md"))).toBeNull();
  });
});

// ── Changed-file acquisition (pagination) ────────────────────────────────────

describe("RI-2: acquireChangedFiles (pagination)", () => {

  it("paginates through more than 100 files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeFile("file" + i + ".js"));
    const page2 = Array.from({ length: 100 }, (_, i) => makeFile("file" + (100 + i) + ".js"));
    const page3 = Array.from({ length: 50 }, (_, i) => makeFile("file" + (200 + i) + ".js"));
    const octokit = makeOctokit([page1, page2, page3]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42);

    expect(allFiles).toHaveLength(250);
    expect(paginatedFully).toBe(true);
    const fileCalls = octokit._calls.filter(c => c.route.includes("/files"));
    expect(fileCalls).toHaveLength(3);
  });

  it("handles a single page (fewer than 100 files)", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(true);
  });

  it("sets paginatedFully=false when acquired count differs from expected", async () => {
    // Simulate a PR with 3005 files, but GitHub API caps at 3000
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42, 10);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(false); // 5 acquired ≠ 10 expected
  });

  it("sets paginatedFully=true when acquired count matches expected", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42, 5);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(true); // 5 acquired = 5 expected
  });
});

// ── Coverage preflight ───────────────────────────────────────────────────────

describe("RI-2: buildReviewEvidence (coverage preflight)", () => {

  it("assigns FULL coverage to files within budget", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js"), makeFile("src/utils.js")],
      review: REVIEW_ROOT,
    });

    expect(evidence.changedFiles).toHaveLength(2);
    expect(evidence.changedFiles.every(f => f.coverage === COVERAGE.FULL)).toBe(true);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("includes the immutable review root", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: REVIEW_ROOT,
    });

    expect(evidence.review).toEqual(REVIEW_ROOT);
  });

  it("stores side-specific base/head identity with blob SHAs and content digests", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js", { sha: "abc123" })],
      review: REVIEW_ROOT,
    });

    const cf = evidence.changedFiles[0];
    expect(cf.head).toBeDefined();
    expect(cf.head.blobSha).toBe("abc123");
    expect(cf.head.sha).toBe(REVIEW_ROOT.headSha);
    expect(cf.head.contentDigest).toMatch(/^sha256:/);
    // Modified file has both base and head
    expect(cf.base).toBeDefined();
    expect(cf.base.sha).toBe(REVIEW_ROOT.baseSha);
  });

  it("removed files have null head (no HEAD version exists)", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/deleted.js", { status: "removed", additions: 0, deletions: 50 })],
      review: REVIEW_ROOT,
    });

    expect(evidence.changedFiles[0].head).toBeNull();
    expect(evidence.changedFiles[0].base).toBeDefined();
  });

  it("added files have null base (no BASE version exists)", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/new.js", { status: "added", additions: 20, deletions: 0 })],
      review: REVIEW_ROOT,
    });

    expect(evidence.changedFiles[0].base).toBeNull();
    expect(evidence.changedFiles[0].head).toBeDefined();
  });

  it("approvalEvidenceComplete is false when review root is null", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: null,
    });

    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("accounts removed files with FULL coverage (diff shows everything removed)", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("src/deleted.js", { status: "removed", additions: 0, deletions: 50 }),
      ],
      review: REVIEW_ROOT,
    });

    const removed = evidence.changedFiles.find(f => f.path === "src/deleted.js");
    expect(removed).toBeDefined();
    expect(removed.coverage).toBe(COVERAGE.FULL);
    expect(removed.status).toBe("removed");
  });

  it("accounts renamed files with both old and new paths", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/new-name.js", {
        status: "renamed",
        previous_filename: "src/old-name.js",
        additions: 5,
        deletions: 2,
      })],
      review: REVIEW_ROOT,
    });

    expect(evidence.changedFiles[0].path).toBe("src/new-name.js");
    expect(evidence.changedFiles[0].previousPath).toBe("src/old-name.js");
    expect(evidence.changedFiles[0].status).toBe("renamed");
  });

  it("assigns POLICY_EXEMPT to exempt files and they don't consume budget", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("logo.png"),       // binary → exempt
        makeFile("dist/bundle.js"), // generated → exempt
      ],
      review: REVIEW_ROOT,
    });

    expect(evidence.coverage.fullyCoveredFiles).toBe(1);
    expect(evidence.coverage.policyExemptFiles).toBe(2);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("marks file as PARTIAL when it crosses the line limit, with bounded patch and represented lines", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("file1.js", { additions: 1500, deletions: 0, patch: generatePatch(1500) }),
        makeFile("file2.js", { additions: 1000, deletions: 0, patch: generatePatch(1000) }),
        makeFile("file3.js", { additions: 100, deletions: 0, patch: generatePatch(100) }),
      ],
      maxFiles: 30,
      maxLines: 2000,
      review: REVIEW_ROOT,
    });

    const file2 = evidence.changedFiles.find(f => f.path === "file2.js");
    const file3 = evidence.changedFiles.find(f => f.path === "file3.js");

    expect(file2.coverage).toBe(COVERAGE.PARTIAL);
    expect(file2.representedLines).toBe(500); // only 2000-1500=500 lines represented
    expect(file2.patch).toContain("truncated"); // patch is bounded
    expect(file3.coverage).toBe(COVERAGE.UNAVAILABLE);

    // changedLinesRepresented must not exceed maxLines
    expect(evidence.coverage.changedLinesRepresented).toBeLessThanOrEqual(2000);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("marks files as UNAVAILABLE when file limit is exceeded", () => {
    const files = Array.from({ length: 35 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const evidence = buildReviewEvidence({
      allFiles: files,
      maxFiles: 10,
      review: REVIEW_ROOT,
    });

    expect(evidence.coverage.totalChangedFiles).toBe(35);
    expect(evidence.coverage.fullyCoveredFiles).toBe(10);
    expect(evidence.coverage.unavailableFiles).toBe(25);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("marks non-exempt files with missing patch as UNAVAILABLE (not binary)", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("large.js", { patch: undefined, additions: 500, deletions: 0 }),
      ],
      review: REVIEW_ROOT,
    });

    const large = evidence.changedFiles.find(f => f.path === "large.js");
    expect(large.coverage).toBe(COVERAGE.UNAVAILABLE);
    expect(large.coverageReason).toContain("No text diff");
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("approvalEvidenceComplete is false when pagination is incomplete", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      paginatedFully: false,
      review: REVIEW_ROOT,
    });

    expect(evidence.coverage.acquisitionComplete).toBe(false);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
    expect(evidence.coverage.limitsExceeded).toContain("pagination_incomplete");
  });

  it("no silent truncation — all files are accounted even when beyond limits", () => {
    const files = Array.from({ length: 50 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const evidence = buildReviewEvidence({
      allFiles: files,
      maxFiles: 5,
      review: REVIEW_ROOT,
    });

    expect(evidence.changedFiles).toHaveLength(50);
    expect(evidence.coverage.totalChangedFiles).toBe(50);
  });

  it("changedLinesTotal counts all files including exempt and unavailable", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js", { additions: 100, deletions: 10 }),
        makeFile("logo.png", { additions: 0, deletions: 0 }),
        makeFile("src/over.js", { additions: 5000, deletions: 0, patch: generatePatch(5000) }),
      ],
      maxFiles: 30,
      maxLines: 200,
      review: REVIEW_ROOT,
    });

    expect(evidence.coverage.changedLinesTotal).toBe(5110);
    // changedLinesRepresented must not exceed maxLines
    expect(evidence.coverage.changedLinesRepresented).toBeLessThanOrEqual(200);
  });
});

// ── Helper: generate a patch with N added lines ──────────────────────────────

function generatePatch(addedLines) {
  let patch = "@@ -1,1 +1," + (addedLines + 1) + " @@\n";
  for (let i = 0; i < addedLines; i++) {
    patch += "+line" + i + "\n";
  }
  return patch;
}
