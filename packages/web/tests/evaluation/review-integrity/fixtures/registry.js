// tests/evaluation/review-integrity/fixtures/registry.js
// Regression corpus for Review Integrity (RI-01 through RI-04).
//
// Each regression case has a broken and fixed variant. The broken variant
// contains a material defect that GitWire's review must detect (P0/P1/P2)
// or must not APPROVE. The fixed variant is the same PR with the defect
// corrected, which should be eligible for APPROVE under the v2 policy.
//
// The corpus is a SEED CORPUS — every new material production review miss
// becomes a new case. These four are the known historical failures.

export const REGISTRY = Object.freeze([
  {
    id: "RI-01",
    title: "Stale Phase 0 status contradiction (AlCode PR #2)",
    source: "AgentGears/AlCode PR #2",

    broken: {
      description:
        "A PR claims Phase 0 is complete, but the repository's own " +
        "status document (a non-changed file) still declares Phase 0 " +
        "as 'not started'. The diff only modifies implementation files, " +
        "not the status document. A reviewer reading only the diff sees " +
        "a clean feature implementation and misses the contradiction.",
      defectCategory: "cross_file_contradiction",
      expectedMinimumSeverity: "P2",
      expectedVerdict: "REQUEST_CHANGES or COMMENT — never APPROVE",
      changedFiles: [
        {
          filename: "src/phase0/initialization.js",
          status: "modified",
          additions: 15,
          removed: 3,
          patch: `--- a/src/phase0/initialization.js
+++ b/src/phase0/initialization.js
@@ -1,8 +1,20 @@
+// Phase 0 initialization — now complete
 export function initPhase0(config) {
-  return { status: "pending", config };
+  if (!config.endpoint) {
+    throw new Error("Endpoint required for Phase 0");
+  }
+  return {
+    status: "complete",
+    config,
+    initializedAt: Date.now(),
+    endpoint: config.endpoint,
+  };
 }`,
        },
        {
          filename: "src/phase0/router.js",
          status: "modified",
          additions: 8,
          removed: 2,
          patch: `--- a/src/phase0/router.js
+++ b/src/phase0/router.js
@@ -1,5 +1,11 @@
 export function createRouter(phase0Result) {
-  return { routes: [] };
+  if (phase0Result.status !== "complete") {
+    throw new Error("Phase 0 must be complete before routing");
+  }
+  return {
+    routes: [{ path: "/", handler: phase0Result.endpoint }],
+  };
 }`,
        },
      ],
      // The repository context that the reviewer needs to discover
      // (this file is NOT in the diff — it's a supporting file)
      contextFiles: [
        {
          path: "docs/status.md",
          sha: "abc123",
          content: `# Project Status

## Phase 0: Not Started

Phase 0 initialization has not been started yet.
The endpoint configuration is still pending.

_Do not deploy until Phase 0 is complete._`,
        },
      ],
    },

    fixed: {
      description:
        "Same PR but the status document is also updated to reflect " +
        "Phase 0 completion. No contradiction remains.",
      defectCategory: "none",
      expectedVerdict: "eligible for APPROVE (if coverage is complete)",
      changedFiles: [
        {
          filename: "src/phase0/initialization.js",
          status: "modified",
          additions: 15,
          removed: 3,
          patch: `--- a/src/phase0/initialization.js
+++ b/src/phase0/initialization.js
@@ -1,8 +1,20 @@
+// Phase 0 initialization — now complete
 export function initPhase0(config) {
-  return { status: "pending", config };
+  if (!config.endpoint) {
+    throw new Error("Endpoint required for Phase 0");
+  }
+  return {
+    status: "complete",
+    config,
+    initializedAt: Date.now(),
+    endpoint: config.endpoint,
+  };
 }`,
        },
        {
          filename: "docs/status.md",
          status: "modified",
          additions: 3,
          removed: 3,
          patch: `--- a/docs/status.md
+++ b/docs/status.md
@@ -1,6 +1,6 @@
 # Project Status

-## Phase 0: Not Started
+## Phase 0: Complete

-Phase 0 initialization has not been started yet.
+Phase 0 initialization is complete and the endpoint is configured.

 _Do not deploy until Phase 0 is complete._`,
        },
      ],
      contextFiles: [],
    },
  },

  {
    id: "RI-02",
    title: "Roadmap claim not proven by code (AlCode PR #2)",
    source: "AgentGears/AlCode PR #2",

    broken: {
      description:
        "The PR description claims 'Agent replacement is fully proven' " +
        "but the code only adds a basic mock-based test, not a replacement " +
        "proof. The diff looks clean — it adds tests and a mock — but " +
        "the claim overstates what the code actually proves.",
      defectCategory: "overstated_claim",
      expectedMinimumSeverity: "P2",
      expectedVerdict: "COMMENT — the claim is not substantiated by the code",
      changedFiles: [
        {
          filename: "tests/agent-replacement.test.js",
          status: "added",
          additions: 20,
          removed: 0,
          patch: `--- /dev/null
+++ b/tests/agent-replacement.test.js
@@ -0,0 +1,20 @@
+import { mockAgent } from "../src/mock-agent.js";
+
+describe("Agent replacement", () => {
+  it("mock agent returns expected response", () => {
+    const agent = mockAgent({ model: "test" });
+    const result = agent.run("hello");
+    expect(result).toBe("mocked: hello");
+  });
+
+  it("mock agent handles empty input", () => {
+    const agent = mockAgent({ model: "test" });
+    const result = agent.run("");
+    expect(result).toBe("mocked: ");
+  });
+});`,
        },
        {
          filename: "src/mock-agent.js",
          status: "added",
          additions: 10,
          removed: 0,
          patch: `--- /dev/null
+++ b/src/mock-agent.js
@@ -0,0 +1,10 @@
+export function mockAgent(config) {
+  return {
+    run(input) {
+      return "mocked: " + input;
+    },
+    config,
+  };
+}`,
        },
      ],
      contextFiles: [],
    },

    fixed: {
      description:
        "Same code but the PR description is corrected to accurately " +
        "describe what the tests prove (mock interaction, not agent replacement).",
      defectCategory: "none",
      expectedVerdict: "eligible for APPROVE",
      changedFiles: [
        {
          filename: "tests/agent-replacement.test.js",
          status: "added",
          additions: 20,
          removed: 0,
          patch: `--- /dev/null
+++ b/tests/agent-replacement.test.js
@@ -0,0 +1,20 @@
+import { mockAgent } from "../src/mock-agent.js";
+
+describe("Mock agent interaction", () => {
+  it("mock agent returns expected response", () => {
+    const agent = mockAgent({ model: "test" });
+    const result = agent.run("hello");
+    expect(result).toBe("mocked: hello");
+  });
+
+  it("mock agent handles empty input", () => {
+    const agent = mockAgent({ model: "test" });
+    const result = agent.run("");
+    expect(result).toBe("mocked: ");
+  });
+});`,
        },
        {
          filename: "src/mock-agent.js",
          status: "added",
          additions: 10,
          removed: 0,
          patch: `--- /dev/null
+++ b/src/mock-agent.js
@@ -0,0 +1,10 @@
+export function mockAgent(config) {
+  return {
+    run(input) {
+      return "mocked: " + input;
+    },
+    config,
+  };
+}`,
        },
      ],
      contextFiles: [],
    },
  },

  {
    id: "RI-03",
    title: "Dashboard basePath omitted from activation URL (GitWire PR #123)",
    source: "Octo-Lex/GitWire PR #123",

    broken: {
      description:
        "The activation URL is constructed as baseUrl + '/intelligence' " +
        "but the Next.js dashboard uses basePath: '/dashboard'. The correct " +
        "URL should be baseUrl + '/dashboard/intelligence'. A reviewer " +
        "reading the diff needs to cross-reference the next.config.ts file " +
        "to catch this.",
      defectCategory: "cross_file_config_contradiction",
      expectedMinimumSeverity: "P1",
      expectedVerdict: "REQUEST_CHANGES — the URL is wrong in production",
      changedFiles: [
        {
          filename: "packages/web/src/services/aiReviewService.js",
          status: "modified",
          additions: 5,
          removed: 1,
          patch: `--- a/packages/web/src/services/aiReviewService.js
+++ b/packages/web/src/services/aiReviewService.js
@@ -82,3 +82,7 @@ const cfg = await loadReviewConfig(repoId);
   if (!cfg?.enabled) {
-    return null;
+    return {
+      skipped: true,
+      reason: "not_activated",
+      activationUrl: config.server.baseUrl + "/intelligence"
+    };
   }`,
        },
      ],
      contextFiles: [
        {
          path: "packages/web-dashboard/next.config.ts",
          sha: "def456",
          content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/dashboard',
};

export default nextConfig;`,
        },
      ],
    },

    fixed: {
      description:
        "Same change but the URL correctly includes '/dashboard/intelligence'.",
      defectCategory: "none",
      expectedVerdict: "eligible for APPROVE",
      changedFiles: [
        {
          filename: "packages/web/src/services/aiReviewService.js",
          status: "modified",
          additions: 5,
          removed: 1,
          patch: `--- a/packages/web/src/services/aiReviewService.js
+++ b/packages/web/src/services/aiReviewService.js
@@ -82,3 +82,7 @@ const cfg = await loadReviewConfig(repoId);
   if (!cfg?.enabled) {
-    return null;
+    return {
+      skipped: true,
+      reason: "not_activated",
+      activationUrl: config.server.baseUrl + "/dashboard/intelligence"
+    };
   }`,
        },
      ],
      contextFiles: [
        {
          path: "packages/web-dashboard/next.config.ts",
          sha: "def456",
          content: `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  basePath: '/dashboard',
};

export default nextConfig;`,
        },
      ],
    },
  },

  {
    id: "RI-04",
    title: "Unpaginated marker lookup exposed by broadened comment path (GitWire PR #124)",
    source: "Octo-Lex/GitWire PR #124",

    broken: {
      description:
        "findCommentByMarker() fetches only one page of 100 comments. " +
        "If the marker comment is on page 2+, it returns null and a " +
        "duplicate comment is created. The diff broadens the comment " +
        "path (from exception-only to every issue) without adding pagination.",
      defectCategory: "missing_pagination",
      expectedMinimumSeverity: "P2",
      expectedVerdict: "REQUEST_CHANGES — duplicate comments possible",
      changedFiles: [
        {
          filename: "packages/web/src/workers/triageWorker.js",
          status: "modified",
          additions: 2,
          removed: 2,
          patch: `--- a/packages/web/src/workers/triageWorker.js
+++ b/packages/web/src/workers/triageWorker.js
@@ -354,2 +354,2 @@
-    if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {
+    if (triageOpts.auto_comment !== false) {`,
        },
        {
          filename: "packages/web/src/lib/commentMarkers.js",
          status: "modified",
          additions: 1,
          removed: 1,
          patch: `--- a/packages/web/src/lib/commentMarkers.js
+++ b/packages/web/src/lib/commentMarkers.js
@@ -57,1 +57,1 @@
-      per_page: 100,
+      per_page: 100,  // still single page — no pagination loop`,
        },
      ],
      contextFiles: [],
    },

    fixed: {
      description:
        "Same broadened comment path but findCommentByMarker now " +
        "paginates all pages.",
      defectCategory: "none",
      expectedVerdict: "eligible for APPROVE",
      changedFiles: [
        {
          filename: "packages/web/src/workers/triageWorker.js",
          status: "modified",
          additions: 2,
          removed: 2,
          patch: `--- a/packages/web/src/workers/triageWorker.js
+++ b/packages/web/src/workers/triageWorker.js
@@ -354,2 +354,2 @@
-    if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {
+    if (triageOpts.auto_comment !== false) {`,
        },
        {
          filename: "packages/web/src/lib/commentMarkers.js",
          status: "modified",
          additions: 25,
          removed: 1,
          patch: `--- a/packages/web/src/lib/commentMarkers.js
+++ b/packages/web/src/lib/commentMarkers.js
@@ -49,1 +49,25 @@
-export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {
+export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {
+  const matches = [];
+  let page = 1;
+  const PER_PAGE = 100;
+  while (true) {
+    const { data: comments } = await octokit.request(
+      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
+      { owner, repo, issue_number: issueNumber, per_page: PER_PAGE, page }
+    );
+    for (const c of comments) {
+      if (c.body && c.body.includes(marker)) matches.push(c);
+    }
+    if (matches.length >= 2) return { ambiguous: true, comments: matches };
+    if (comments.length < PER_PAGE) break;
+    page++;
+  }`,
        },
      ],
      contextFiles: [],
    },
  },
]);

/**
 * Get all fixtures in flat array form for the baseline runner.
 * Each entry: { caseId, variant ("broken"|"fixed"), fixture, expected }
 */
export function getAllFixtures() {
  const result = [];
  for (const c of REGISTRY) {
    result.push({
      caseId: c.id,
      variant: "broken",
      title: c.title,
      fixture: c.broken,
      expectedVerdict: c.broken.expectedVerdict,
      expectedMinSeverity: c.broken.expectedMinimumSeverity,
    });
    result.push({
      caseId: c.id,
      variant: "fixed",
      title: c.title,
      fixture: c.fixed,
      expectedVerdict: c.fixed.expectedVerdict,
      expectedMinSeverity: null,
    });
  }
  return result;
}
