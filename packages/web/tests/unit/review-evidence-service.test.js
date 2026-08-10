// tests/unit/review-evidence-service.test.js
// Tests for RI-2: ReviewEvidence schema, changed-file acquisition,
// policy exemption, and coverage preflight.
//
// All tests are deterministic — no model calls, no network.
// These prove the CI gates from the frozen plan:
//   >100 file pagination
//   removed-file accounting
//   rename accounting
//   policy exemption accounting
//   no silent truncation
//   context-budget exhaustion

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

// ── Exemption classification ─────────────────────────────────────────────────

describe("RI-2: classifyExemption", () => {

  it("exempts binary files by extension", () => {
    const result = classifyExemption(makeFile("logo.png"));
    expect(result.rule).toBe(EXEMPTION_RULES.BINARY);
    expect(result.source).toBe("built_in");
  });

  it("exempts files with no patch (binary or large)", () => {
    const result = classifyExemption(makeFile("large.dat", { patch: undefined }));
    expect(result.rule).toBe(EXEMPTION_RULES.BINARY);
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

  it("exempts configured ignore patterns", () => {
    const result = classifyExemption(
      makeFile("secrets/private.key"),
      ["secrets/.*"]
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

  it("exempts lockfiles as generated-lockfile", () => {
    expect(classifyExemption(makeFile("package-lock.json")).rule).toBe(EXEMPTION_RULES.GENERATED_LOCKFILE);
    expect(classifyExemption(makeFile("yarn.lock")).rule).toBe(EXEMPTION_RULES.GENERATED_LOCKFILE);
    expect(classifyExemption(makeFile("Cargo.lock")).rule).toBe(EXEMPTION_RULES.GENERATED_LOCKFILE);
  });

  it("returns null for normal source files", () => {
    expect(classifyExemption(makeFile("src/app.js"))).toBeNull();
    expect(classifyExemption(makeFile("docs/guide.md"))).toBeNull();
    expect(classifyExemption(makeFile("tests/unit/test.js"))).toBeNull();
  });
});

// ── Changed-file acquisition (pagination) ────────────────────────────────────

describe("RI-2: acquireChangedFiles (pagination)", () => {

  it("paginates through more than 100 files", async () => {
    // 250 files: 3 pages (100, 100, 50)
    const page1 = Array.from({ length: 100 }, (_, i) => makeFile("file" + i + ".js"));
    const page2 = Array.from({ length: 100 }, (_, i) => makeFile("file" + (100 + i) + ".js"));
    const page3 = Array.from({ length: 50 }, (_, i) => makeFile("file" + (200 + i) + ".js"));
    const octokit = makeOctokit([page1, page2, page3]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42);

    expect(allFiles).toHaveLength(250);
    expect(paginatedFully).toBe(true);
    // Must have fetched 3 pages
    const fileCalls = octokit._calls.filter(c => c.route.includes("/files"));
    expect(fileCalls).toHaveLength(3);
    expect(fileCalls[0].params.page).toBe(1);
    expect(fileCalls[1].params.page).toBe(2);
    expect(fileCalls[2].params.page).toBe(3);
  });

  it("handles a single page (fewer than 100 files)", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(true);
  });
});

// ── Coverage preflight ───────────────────────────────────────────────────────

describe("RI-2: buildReviewEvidence (coverage preflight)", () => {

  it("assigns FULL coverage to files within budget", () => {
    const evidence = buildReviewEvidence({
      allFiles: [makeFile("src/app.js"), makeFile("src/utils.js")],
      maxFiles: 30,
      maxLines: 2000,
    });

    expect(evidence.changedFiles).toHaveLength(2);
    expect(evidence.changedFiles.every(f => f.coverage === COVERAGE.FULL)).toBe(true);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("accounts removed files with FULL coverage (diff shows everything removed)", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("src/deleted.js", { status: "removed", additions: 0, deletions: 50 }),
      ],
      maxFiles: 30,
      maxLines: 2000,
    });

    expect(evidence.changedFiles).toHaveLength(2);
    const removed = evidence.changedFiles.find(f => f.path === "src/deleted.js");
    expect(removed).toBeDefined();
    expect(removed.coverage).toBe(COVERAGE.FULL); // removed files are fully represented by the diff
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
    });

    expect(evidence.changedFiles).toHaveLength(1);
    expect(evidence.changedFiles[0].path).toBe("src/new-name.js");
    expect(evidence.changedFiles[0].previousPath).toBe("src/old-name.js");
    expect(evidence.changedFiles[0].status).toBe("renamed");
  });

  it("assigns POLICY_EXEMPT to exempt files and they don't consume budget", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),  // full
        makeFile("logo.png"),    // binary → exempt
        makeFile("dist/bundle.js"), // generated → exempt
      ],
      maxFiles: 30,
      maxLines: 2000,
    });

    expect(evidence.changedFiles).toHaveLength(3);
    expect(evidence.coverage.fullyCoveredFiles).toBe(1);
    expect(evidence.coverage.policyExemptFiles).toBe(2);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("marks file as PARTIAL when it crosses the line limit", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("file1.js", { additions: 1500, deletions: 0 }), // 1500 lines, fits
        makeFile("file2.js", { additions: 1000, deletions: 0 }), // 1000 lines, crosses 2000 limit
        makeFile("file3.js", { additions: 100, deletions: 0 }),  // beyond limit
      ],
      maxFiles: 30,
      maxLines: 2000,
    });

    const file2 = evidence.changedFiles.find(f => f.path === "file2.js");
    const file3 = evidence.changedFiles.find(f => f.path === "file3.js");

    expect(file2.coverage).toBe(COVERAGE.PARTIAL);
    expect(file3.coverage).toBe(COVERAGE.UNAVAILABLE);
    expect(evidence.coverage.partialFiles).toBe(1);
    expect(evidence.coverage.unavailableFiles).toBe(1);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("marks files as UNAVAILABLE when file limit is exceeded", () => {
    const files = Array.from({ length: 35 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const evidence = buildReviewEvidence({
      allFiles: files,
      maxFiles: 10,
      maxLines: 2000,
    });

    expect(evidence.coverage.totalChangedFiles).toBe(35);
    expect(evidence.coverage.fullyCoveredFiles).toBe(10);
    expect(evidence.coverage.unavailableFiles).toBe(25);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("approvalEvidenceComplete is false when any non-exempt file is partial or unavailable", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("src/over-limit.js", { additions: 5000, deletions: 0 }),
        makeFile("src/beyond.js", { additions: 10, deletions: 0 }),
      ],
      maxFiles: 30,
      maxLines: 100,
    });

    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
    expect(evidence.coverage.limitsExceeded).toContain("line_limit_partial");
  });

  it("no silent truncation — all files are accounted even when beyond limits", () => {
    const files = Array.from({ length: 50 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const evidence = buildReviewEvidence({
      allFiles: files,
      maxFiles: 5,
      maxLines: 2000,
    });

    // Every file appears in changedFiles — none are silently dropped
    expect(evidence.changedFiles).toHaveLength(50);
    expect(evidence.coverage.totalChangedFiles).toBe(50);
    expect(evidence.coverage.fullyCoveredFiles).toBe(5);
    expect(evidence.coverage.unavailableFiles).toBe(45);
  });

  it("changedLinesTotal counts all files including exempt and unavailable", () => {
    const evidence = buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js", { additions: 100, deletions: 10 }),
        makeFile("logo.png", { additions: 0, deletions: 0 }), // binary, exempt
        makeFile("src/over.js", { additions: 5000, deletions: 0 }), // crosses limit
      ],
      maxFiles: 30,
      maxLines: 200,
    });

    expect(evidence.coverage.changedLinesTotal).toBe(5110); // 110 + 0 + 5000
  });
});
