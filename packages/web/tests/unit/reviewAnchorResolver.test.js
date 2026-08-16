// Review inline-comment anchor resolution (NodeChain P1 correction).
// Pure parser tests — deterministic, no mocks, no LLM.

import {
  resolvePatchAnchorLines,
  buildInlineComments,
} from "../../src/services/reviewAnchorResolver.js";

const MULTI_HUNK_PATCH = [
  "diff --git a/src/app.js b/src/app.js",
  "index 1111111..2222222 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -10,4 +10,5 @@ function old() {",
  " context line ten",        // new line 10 (RIGHT)
  "-deleted line eleven",     // LEFT only — does not advance the new counter
  "+added after deletion",    // new line 11 (RIGHT)
  " context twelve",          // new line 12 (RIGHT)
  "@@ -80,3 +90,4 @@ function later() {",
  " context ninety",          // new line 90 (RIGHT)
  "+added ninety-one",        // new line 91 (RIGHT)
  "+added ninety-two",        // new line 92 (RIGHT)
  " context ninety-three",    // new line 93 (RIGHT)
].join("\n");

describe("resolvePatchAnchorLines", () => {
  it("anchors added AND context lines on the RIGHT side across multiple hunks", () => {
    const anchors = resolvePatchAnchorLines(MULTI_HUNK_PATCH);
    expect([...anchors].sort((a, b) => a - b)).toEqual([10, 11, 12, 90, 91, 92, 93]);
  });

  it("never anchors deleted-only lines", () => {
    const patch = "@@ -1,3 +1,1 @@\n-keep me left\n-gone too\n+only right line one\n";
    expect([...resolvePatchAnchorLines(patch)]).toEqual([1]);
  });

  it("returns an empty set for missing, empty, or header-only patches", () => {
    expect(resolvePatchAnchorLines("")).toEqual(new Set());
    expect(resolvePatchAnchorLines(null)).toEqual(new Set());
    expect(resolvePatchAnchorLines(undefined)).toEqual(new Set());
    expect(resolvePatchAnchorLines("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n")).toEqual(new Set());
  });

  it("stops trusting a malformed/truncated patch but keeps earlier anchors", () => {
    const truncated = "@@ -1,3 +1,3 @@\n+one\n+two\nGARBAGE WITHOUT A MARKER\n+should-not-count\n";
    expect([...resolvePatchAnchorLines(truncated)].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("skips the no-newline marker without consuming a line", () => {
    const patch = "@@ -1,2 +1,2 @@\n+first\n second\n\\ No newline at end of file\n";
    expect([...resolvePatchAnchorLines(patch)].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe("buildInlineComments", () => {
  const files = [{ filename: "src/app.js", patch: MULTI_HUNK_PATCH }];

  it("THE EXACT PRODUCTION DEFECT SHAPE: a large file line beyond the patch is NEVER anchored — and position is never emitted", () => {
    const findings = [
      { file: "src/app.js", line: 800, severity: "high", title: "big-line finding", description: "d", suggestion: "s" },
    ];
    const comments = buildInlineComments(findings, files);
    // Body-only degradation: no inline comment at all for line 800.
    expect(comments).toEqual([]);
  });

  it("anchors a finding whose line exists on the RIGHT side as {path, line, side: RIGHT}", () => {
    const findings = [
      { file: "src/app.js", line: 91, severity: "critical", title: "on added line", description: "d", suggestion: "do" },
    ];
    const comments = buildInlineComments(findings, files);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ path: "src/app.js", line: 91, side: "RIGHT" });
    expect(comments[0].body).toContain("on added line");
    expect(comments[0]).not.toHaveProperty("position");
  });

  it("degrades to body-only for out-of-diff lines, deleted-only content lines, unknown files, and missing patches", () => {
    const findings = [
      // Line 13 is inside the first hunk's claimed range but no RIGHT-side
      // line maps to it — deleted content occupies the old-file slot.
      { file: "src/app.js", line: 13, severity: "low", title: "gap line (deleted content side)" },
      { file: "src/app.js", line: 5000, severity: "low", title: "out of diff" },                   // beyond patch
      { file: "other/file.js", line: 1, severity: "low", title: "file not in this diff" },         // unknown file
      { file: "no-patch.js", line: 3, severity: "low", title: "patch missing" },                   // no patch entry
    ];
    const filesWithEmpty = [...files, { filename: "no-patch.js", patch: "" }];
    expect(buildInlineComments(findings, filesWithEmpty)).toEqual([]);
  });

  it("caps comments and ignores findings without file+line", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      file: "src/app.js", line: 90 + (i % 3), severity: "low", title: "f" + i,
    }));
    const withPartial = [{ title: "no location" }, { file: "src/app.js", title: "no line" }, ...many];
    const comments = buildInlineComments(withPartial, files);
    expect(comments).toHaveLength(10);
    expect(comments.every((c) => c.side === "RIGHT" && c.path === "src/app.js")).toBe(true);
  });
});
