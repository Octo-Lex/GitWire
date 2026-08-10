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
import { createHash } from "node:crypto";

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
  const contentMap = new Map(); // key: `${ref}:${path}` → content string

  return {
    request: function(route, params) {
      calls.push({ route, params });

      // PR files endpoint
      if (route.includes("/pulls/") && route.includes("/files")) {
        const page = params.page || 1;
        const data = pages[page - 1] || [];
        return Promise.resolve({ data });
      }

      // Content endpoint — resolve {path} from params and serve from contentMap
      if (route.includes("GET") && route.includes("/contents/")) {
        const path = params.path || route.match(/contents\/(.+?)(?:\?|$)/)?.[1] || "";
        const ref = params.ref || "head";
        const key = ref + ":" + path;
        if (contentMap.has(key)) {
          const content = contentMap.get(key);
          return Promise.resolve({
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(content).toString("base64"),
              path,
              sha: "blobsha_" + path,
            },
          });
        }
        return Promise.reject(new Error("404 Not Found: " + path));
      }

      // Root contents listing
      if (route.includes("GET") && route.includes("/contents") && !route.includes("/contents/")) {
        return Promise.resolve({ data: [] });
      }

      return Promise.resolve({ data: {} });
    },
    _calls: calls,
    _contentMap: contentMap,
    // Helper to populate content for tests
    setContent(ref, path, content) {
      contentMap.set(ref + ":" + path, content);
    },
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
  });

  it("does NOT classify missing patch as binary (may be large)", () => {
    const result = classifyExemption(makeFile("large.js", { patch: undefined }));
    expect(result).toBeNull();
  });

  it("returns null for normal source files", () => {
    expect(classifyExemption(makeFile("src/app.js"))).toBeNull();
  });
});

// ── Changed-file acquisition (pagination) ────────────────────────────────────

describe("RI-2: acquireChangedFiles (pagination)", () => {

  it("paginates through more than 100 files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeFile("file" + i + ".js"));
    const page2 = Array.from({ length: 100 }, (_, i) => makeFile("file" + (100 + i) + ".js"));
    const page3 = Array.from({ length: 50 }, (_, i) => makeFile("file" + (200 + i) + ".js"));
    const octokit = makeOctokit([page1, page2, page3]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42, 250);

    expect(allFiles).toHaveLength(250);
    expect(paginatedFully).toBe(true);
  });

  it("handles a single page (fewer than 100 files)", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42, 5);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(true);
  });

  it("throws when expectedFileCount is not provided (mandatory)", async () => {
    const octokit = makeOctokit([[]]);
    await expect(
      acquireChangedFiles(octokit, "org", "repo", 42)
    ).rejects.toThrow("expectedFileCount");
  });

  it("sets paginatedFully=false when acquired count differs from expected (API ceiling)", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeFile("file" + i + ".js"));
    const octokit = makeOctokit([files]);

    const { allFiles, paginatedFully } = await acquireChangedFiles(octokit, "org", "repo", 42, 10);

    expect(allFiles).toHaveLength(5);
    expect(paginatedFully).toBe(false);
  });
});

// ── Coverage preflight ───────────────────────────────────────────────────────

describe("RI-2: buildReviewEvidence (coverage preflight)", () => {

  it("assigns FULL coverage to files within budget", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "app content");
    octokit.setContent(REVIEW_ROOT.headSha, "src/utils.js", "utils content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old app content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/utils.js", "old utils content");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js"), makeFile("src/utils.js")],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.changedFiles).toHaveLength(2);
    expect(evidence.changedFiles.every(f => f.coverage === COVERAGE.FULL)).toBe(true);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("includes the immutable review root", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old content");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.review).toEqual(REVIEW_ROOT);
  });

  it("stores side-specific base/head identity with actual content digests", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "head content here");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "base content here");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    const cf = evidence.changedFiles[0];
    // HEAD identity: digest from actual head file content, not from the patch
    expect(cf.head).toBeDefined();
    expect(cf.head.sha).toBe(REVIEW_ROOT.headSha);
    expect(cf.head.contentDigest).toBe("sha256:" + createHash("sha256").update("head content here", "utf8").digest("hex"));
    // BASE identity: digest from actual base file content
    expect(cf.base).toBeDefined();
    expect(cf.base.sha).toBe(REVIEW_ROOT.baseSha);
    expect(cf.base.contentDigest).toBe("sha256:" + createHash("sha256").update("base content here", "utf8").digest("hex"));
  });

  it("removed files have null head (no HEAD version exists)", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.baseSha, "src/deleted.js", "deleted content");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/deleted.js", { status: "removed", additions: 0, deletions: 50 })],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.changedFiles[0].head).toBeNull();
    expect(evidence.changedFiles[0].base).toBeDefined();
    expect(evidence.changedFiles[0].base.contentDigest).toMatch(/^sha256:/);
  });

  it("added files have null base (no BASE version exists)", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/new.js", "new file content");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/new.js", { status: "added", additions: 20, deletions: 0 })],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.changedFiles[0].base).toBeNull();
    expect(evidence.changedFiles[0].head).toBeDefined();
  });

  it("approvalEvidenceComplete is false when review root is null", async () => {
    const octokit = makeOctokit([]);

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: null,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("approvalEvidenceComplete is false when review root is missing required fields", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent("head456", "src/app.js", "content");
    octokit.setContent("base123", "src/app.js", "old");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: { repoId: 999, repoFullName: "org/repo", prNumber: 42, baseSha: "base123" }, // missing headSha
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("approvalEvidenceComplete is false when review root is missing invocationId", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      review: { repoId: 999, repoFullName: "org/repo", prNumber: 42, baseSha: REVIEW_ROOT.baseSha, headSha: REVIEW_ROOT.headSha }, // missing invocationId
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("identity-fetch failure forces file to unavailable — never full and approval-eligible", async () => {
    // Don't set any content — the fetchFileIdentity will return null sha/digest
    const octokit = makeOctokit([]);

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")], // modified — needs both BASE and HEAD identity
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    const cf = evidence.changedFiles[0];
    expect(cf.coverage).toBe(COVERAGE.UNAVAILABLE);
    expect(cf.coverageReason).toContain("Side identity incomplete");
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("accounts removed files with FULL coverage", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "app content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old app");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/deleted.js", "deleted content");

    const evidence = await buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("src/deleted.js", { status: "removed", additions: 0, deletions: 50 }),
      ],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    const removed = evidence.changedFiles.find(f => f.path === "src/deleted.js");
    expect(removed).toBeDefined();
    expect(removed.coverage).toBe(COVERAGE.FULL);
    expect(removed.status).toBe("removed");
  });

  it("accounts renamed files with both old and new paths", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/new-name.js", "new content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/old-name.js", "old content");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/new-name.js", {
        status: "renamed",
        previous_filename: "src/old-name.js",
        additions: 5,
        deletions: 2,
      })],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.changedFiles[0].path).toBe("src/new-name.js");
    expect(evidence.changedFiles[0].previousPath).toBe("src/old-name.js");
    expect(evidence.changedFiles[0].status).toBe("renamed");
  });

  it("assigns POLICY_EXEMPT to exempt files and they don't consume budget", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "app content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old app");

    const evidence = await buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("logo.png"),
        makeFile("dist/bundle.js"),
      ],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.fullyCoveredFiles).toBe(1);
    expect(evidence.coverage.policyExemptFiles).toBe(2);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(true);
  });

  it("marks file as PARTIAL when it crosses the line limit, with bounded patch and represented lines", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "file1.js", "a".repeat(100));
    octokit.setContent(REVIEW_ROOT.baseSha, "file1.js", "b".repeat(100));
    octokit.setContent(REVIEW_ROOT.headSha, "file2.js", "c".repeat(100));
    octokit.setContent(REVIEW_ROOT.baseSha, "file2.js", "d".repeat(100));

    const evidence = await buildReviewEvidence({
      allFiles: [
        makeFile("file1.js", { additions: 1500, deletions: 0, patch: generatePatch(1500) }),
        makeFile("file2.js", { additions: 1000, deletions: 0, patch: generatePatch(1000) }),
        makeFile("file3.js", { additions: 100, deletions: 0, patch: generatePatch(100) }),
      ],
      maxFiles: 30,
      maxLines: 2000,
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    const file2 = evidence.changedFiles.find(f => f.path === "file2.js");
    const file3 = evidence.changedFiles.find(f => f.path === "file3.js");

    expect(file2.coverage).toBe(COVERAGE.PARTIAL);
    expect(file2.representedLines).toBe(500);
    expect(file2.patch).toContain("truncated");
    expect(file3.coverage).toBe(COVERAGE.UNAVAILABLE);
    expect(evidence.coverage.changedLinesRepresented).toBeLessThanOrEqual(2000);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("marks files as UNAVAILABLE when file limit is exceeded", async () => {
    const files = Array.from({ length: 35 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const octokit = makeOctokit([]);
    // Set content for all files
    for (const f of files) {
      octokit.setContent(REVIEW_ROOT.headSha, f.filename, "x");
      octokit.setContent(REVIEW_ROOT.baseSha, f.filename, "y");
    }

    const evidence = await buildReviewEvidence({
      allFiles: files,
      maxFiles: 10,
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.totalChangedFiles).toBe(35);
    expect(evidence.coverage.fullyCoveredFiles).toBe(10);
    expect(evidence.coverage.unavailableFiles).toBe(25);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("marks non-exempt files with missing patch as UNAVAILABLE", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old");
    octokit.setContent(REVIEW_ROOT.headSha, "large.js", "large");
    octokit.setContent(REVIEW_ROOT.baseSha, "large.js", "old large");

    const evidence = await buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js"),
        makeFile("large.js", { patch: undefined, additions: 500, deletions: 0 }),
      ],
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    const large = evidence.changedFiles.find(f => f.path === "large.js");
    expect(large.coverage).toBe(COVERAGE.UNAVAILABLE);
    expect(large.coverageReason).toContain("No text diff");
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
  });

  it("approvalEvidenceComplete is false when pagination is incomplete", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old");

    const evidence = await buildReviewEvidence({
      allFiles: [makeFile("src/app.js")],
      paginatedFully: false,
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.acquisitionComplete).toBe(false);
    expect(evidence.coverage.approvalEvidenceComplete).toBe(false);
    expect(evidence.coverage.limitsExceeded).toContain("pagination_incomplete");
  });

  it("no silent truncation — all files are accounted", async () => {
    const files = Array.from({ length: 50 }, (_, i) => makeFile("file" + i + ".js", { additions: 1, deletions: 0 }));
    const octokit = makeOctokit([]);
    for (const f of files) {
      octokit.setContent(REVIEW_ROOT.headSha, f.filename, "x");
      octokit.setContent(REVIEW_ROOT.baseSha, f.filename, "y");
    }

    const evidence = await buildReviewEvidence({
      allFiles: files,
      maxFiles: 5,
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.changedFiles).toHaveLength(50);
    expect(evidence.coverage.totalChangedFiles).toBe(50);
  });

  it("changedLinesTotal counts all files including exempt and unavailable", async () => {
    const octokit = makeOctokit([]);
    octokit.setContent(REVIEW_ROOT.headSha, "src/app.js", "content");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/app.js", "old");
    octokit.setContent(REVIEW_ROOT.headSha, "src/over.js", "over");
    octokit.setContent(REVIEW_ROOT.baseSha, "src/over.js", "old over");

    const evidence = await buildReviewEvidence({
      allFiles: [
        makeFile("src/app.js", { additions: 100, deletions: 10 }),
        makeFile("logo.png", { additions: 0, deletions: 0 }),
        makeFile("src/over.js", { additions: 5000, deletions: 0, patch: generatePatch(5000) }),
      ],
      maxFiles: 30,
      maxLines: 200,
      review: REVIEW_ROOT,
      octokit, owner: "org", repo: "repo",
    });

    expect(evidence.coverage.changedLinesTotal).toBe(5110);
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
