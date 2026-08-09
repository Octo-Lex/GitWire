// tests/evaluation/review-integrity/fixtures/registry.js
// Regression corpus for Review Integrity (RI-01 through RI-04).
//
// Each case is reconstructed from the EXACT pre-correction reviewed head
// (the broken state that was falsely approved) and the EXACT correction
// that resolved the finding thread (the fixed state). No synthetic or
// illustrative scenarios.
//
// The corpus is a SEED CORPUS — every new material production review miss
// becomes a new case.

// ── RI-01: Stale Phase 0 status declarations (AlCode PR #2) ─────────────────
//
// Broken head: 0181b19f00 — phase-0-spec.md status changed to CLOSED,
// but README.md and constitution.md still say Phase 0.0 is REOPENED.
// Codex P2: "Synchronize all Phase 0 status declarations."
//
// Fixed head: 20219bd384 — README.md, constitution.md, and phase-0-spec.md
// all consistently say CLOSED.

const RI01_BROKEN = {
  caseId: "RI-01",
  variant: "broken",
  source: "AgentGears/AlCode PR #2 (commit 0181b19f00)",
  title: "docs: roadmap refresh — Host architecture orientation + stale status fix",

  prMetadata: {
    title: "docs: roadmap refresh — Host architecture orientation + stale status fix",
    body:
      "Post Phase 0.2 roadmap refresh.\n\n" +
      "Creates `docs/roadmap.md` as the architecture orientation document encoding the refreshed target: Host authority, replaceable Agent, mediated capabilities, durable scheduling, continuous input semantics, workspace abstraction. The phase sequence stays the same; what changes is what each phase builds toward.\n\n" +
      "Also fixes stale Phase 0.0 'REOPENED' status text and marks 0.1A/0.2 as CLOSED to match the actual executable state. `phase-0-spec.md` remains the authoritative executable specification; `roadmap.md` is the orientation document that cross-references it.\n\n" +
      "No code changes, no gate changes.",
    head: "0181b19f00",
    base: "main",
    author: "alajmah",
  },

  changedFiles: [
    {
      filename: "docs/phase-0-spec.md",
      status: "modified",
      additions: 8,
      deletions: 4,
      patch:
        "--- a/docs/phase-0-spec.md\n" +
        "+++ b/docs/phase-0-spec.md\n" +
        "@@ -1,4 +1,4 @@\n" +
        " # ALCODE — Phase 0 Specification (executable)\n" +
        "-Status: **active; Phase 0.0 reopened** (documentation complete, scaffold pending).\n" +
        "+Status: **active; Phases 0.0, 0.1A, 0.2 closed** — gate:0.2 green on `main` (`dd07fb2`). See `docs/roadmap.md` for architecture orientation.\n",
      headContent:
        "# ALCODE — Phase 0 Specification (executable)\n\n" +
        "Status: **active; Phases 0.0, 0.1A, 0.2 closed** — gate:0.2 green on `main` (`dd07fb2`). See `docs/roadmap.md` for architecture orientation.\n",
      baseContent:
        "# ALCODE — Phase 0 Specification (executable)\n\n" +
        "Status: **active; Phase 0.0 reopened** (documentation complete, scaffold pending).\n",
    },
  ],

  // Unchanged files in the repository at this commit — these contain the
  // stale declarations that contradict the changed file. A reviewer reading
  // only the diff would need to cross-reference these to find the contradiction.
  contextFiles: [
    {
      path: "README.md",
      sha: "readme_0181b19",
      // At the broken commit, README still says REOPENED
      content:
        "# ALCODE\n\n" +
        "One codebase, one reasoning loop. Reasoning, tools, model access,\n" +
        "persistence, and UI are governed by one codebase.\n\n" +
        "**Status:** Phase 0.0 (architecture foundation) — **reopened**. Documentation\n" +
        "is complete; the executable scaffold (workspace, `events` package, gate runner,\n" +
        "ADRs, threat model, recovery model, licensing, minimal CI) is pending.\n",
    },
    {
      path: "docs/constitution.md",
      sha: "constitution_0181b19",
      content:
        "## Status\n\n" +
        "Phase 0.0 is **reopened** — documentation was complete but the executable\n" +
        "scaffold (workspace, `events` package, gate runner, ADRs, threat model,\n" +
        "recovery model, licensing, minimal CI) was not. See `docs/phase-0-spec.md` §0.0\n" +
        "for the corrected, executable scope.\n",
    },
  ],

  // The exact Codex finding
  expectedFinding: {
    severity: "P2",
    title: "Synchronize all Phase 0 status declarations",
    description:
      "This new status says Phase 0.0 is closed, but the primary README.md:11-13, " +
      "the frozen constitution at docs/constitution.md:68-73, and this specification's " +
      "own summary at docs/phase-0-spec.md:737-742 still say it is reopened with the " +
      "scaffold pending. Readers therefore receive contradictory build state depending " +
      "on their entry point.",
    evidencePaths: ["README.md", "docs/constitution.md", "docs/phase-0-spec.md"],
  },
  expectedVerdict: "never APPROVE",
};

const RI01_FIXED = {
  caseId: "RI-01",
  variant: "fixed",
  source: "AgentGears/AlCode PR #2 (commit 20219bd384)",
  title: RI01_BROKEN.title,
  prMetadata: RI01_BROKEN.prMetadata,

  changedFiles: [
    {
      filename: "docs/phase-0-spec.md",
      status: "modified",
      additions: 8,
      deletions: 4,
      patch: RI01_BROKEN.changedFiles[0].patch,
      headContent: RI01_BROKEN.changedFiles[0].headContent,
      baseContent: RI01_BROKEN.changedFiles[0].baseContent,
    },
    {
      filename: "README.md",
      status: "modified",
      additions: 15,
      deletions: 16,
      patch:
        "--- a/README.md\n" +
        "+++ b/README.md\n" +
        "@@ -8,16 +8,17 @@\n" +
        "-**Status:** Phase 0.0 (architecture foundation) — **reopened**. Documentation\n" +
        "-is complete; the executable scaffold (workspace, `events` package, gate runner,\n" +
        "-ADRs, threat model, recovery model, licensing, minimal CI) is pending.\n" +
        "+**Status:** Phases 0.0, 0.1A, 0.2 — **closed**. The durable event/recovery\n" +
        "+spine is proven (gate:0.2 green on `main`). See\n" +
        "+[`docs/roadmap.md`](docs/roadmap.md) for architecture orientation.\n",
      headContent:
        "**Status:** Phases 0.0, 0.1A, 0.2 — **closed**. The durable event/recovery\n" +
        "spine is proven (gate:0.2 green on `main`). See\n" +
        "[`docs/roadmap.md`](docs/roadmap.md) for architecture orientation.\n",
      baseContent: RI01_BROKEN.contextFiles[0].content,
    },
    {
      filename: "docs/constitution.md",
      status: "modified",
      additions: 3,
      deletions: 4,
      patch:
        "--- a/docs/constitution.md\n" +
        "+++ b/docs/constitution.md\n" +
        "@@ -67,10 +67,9 @@\n" +
        "-Phase 0.0 is **reopened** — documentation was complete but the executable\n" +
        "-scaffold (workspace, `events` package, gate runner, ADRs, threat model,\n" +
        "-recovery model, licensing, minimal CI) was not. See `docs/phase-0-spec.md` §0.0\n" +
        "-for the corrected, executable scope.\n" +
        "+Phases 0.0, 0.1A, and 0.2 are **closed** — the durable event/recovery spine\n" +
        "+is proven (`gate:0.2` green on `main`). See `docs/roadmap.md` for architecture\n" +
        "+orientation and `docs/phase-0-spec.md` for the executable specification.\n",
      headContent:
        "Phases 0.0, 0.1A, and 0.2 are **closed** — the durable event/recovery spine\n" +
        "is proven (`gate:0.2` green on `main`). See `docs/roadmap.md` for architecture\n" +
        "orientation and `docs/phase-0-spec.md` for the executable specification.\n",
      baseContent: RI01_BROKEN.contextFiles[1].content,
    },
  ],

  contextFiles: [],

  expectedFinding: null,
  expectedVerdict: "eligible for APPROVE",
};

// ── RI-02: Gate/contract mismatch — Agent replacement (AlCode PR #2) ────────
//
// Broken head: 0181b19f00 — roadmap.md (new file) declares Agent replacement
// as part of Phase 0.5 architecture, but phase-0-spec.md gate 0.5 definition
// only checks kill/reopen — no Agent-replacement assertion.
// Codex P2: "Add agent-replacement assertions to gate 0.5."
//
// Fixed head: 20219bd384 — phase-0-spec.md gate 0.5 definition updated to
// include the Agent replacement/restart assertion.

const RI02_BROKEN = {
  caseId: "RI-02",
  variant: "broken",
  source: "AgentGears/AlCode PR #2 (commit 0181b19f00)",
  title: RI01_BROKEN.title,
  prMetadata: RI01_BROKEN.prMetadata,

  changedFiles: [
    {
      filename: "docs/roadmap.md",
      status: "added",
      additions: 385,
      deletions: 0,
      patch: "--- /dev/null\n+++ b/docs/roadmap.md\n",
      headContent:
        "# ALCODE Roadmap — Architecture Orientation\n\n" +
        "The key shift: build semantic engines on the proven durable spine while\n" +
        "progressively extracting a Host control plane, so that by Phase 0.5 the\n" +
        "Agent is replaceable, capabilities are mediated, and durable execution —\n" +
        "not the reasoning process — is the product authority.\n\n" +
        "## Replaceable Agent\n\n" +
        "The Agent is replaceable because the Host can reconstruct what the new\n" +
        "Agent needs after restart. Agent replacement/restart does not invalidate\n" +
        "Host-owned execution identity or durable state.\n",
      baseContent: null,
    },
  ],

  // The unchanged authoritative gate definition that lacks the assertion
  contextFiles: [
    {
      path: "docs/phase-0-spec.md",
      sha: "spec_0181b19",
      content:
        "**Exit gate:** `pnpm gate:0.5` emits `status: \"passed\"` — the Ouroboros 0.20\n" +
        "continuity proof reproduced in ALCODE: kill process mid-task, reopen,\n" +
        "`resume → orient → act` with state intact; all crash/concurrency tests pass.\n",
    },
  ],

  expectedFinding: {
    severity: "P2",
    title: "Add agent-replacement assertions to gate 0.5",
    description:
      "When gate 0.5 is implemented from the document declared authoritative above, " +
      "this new exit requirement will not be enforced: docs/phase-0-spec.md:542-544 " +
      "checks killing and reopening the whole process with intact state, but never " +
      "replaces or restarts an Agent independently or verifies preservation of " +
      "Host-owned execution identity. The gate can therefore pass without proving " +
      "the replaceable-Agent property that this roadmap explicitly makes part of " +
      "the 0.5 exit proof.",
    evidencePaths: ["docs/roadmap.md", "docs/phase-0-spec.md"],
  },
  expectedVerdict: "never APPROVE",
};

const RI02_FIXED = {
  caseId: "RI-02",
  variant: "fixed",
  source: "AgentGears/AlCode PR #2 (commit 20219bd384)",
  title: RI01_BROKEN.title,
  prMetadata: RI01_BROKEN.prMetadata,

  changedFiles: [
    {
      filename: "docs/phase-0-spec.md",
      status: "modified",
      additions: 8,
      deletions: 4,
      patch:
        "--- a/docs/phase-0-spec.md\n" +
        "+++ b/docs/phase-0-spec.md\n" +
        "@@ -541,7 +541,11 @@\n" +
        " **Exit gate:** `pnpm gate:0.5` emits `status: \"passed\"` — the Ouroboros 0.20\n" +
        " continuity proof reproduced in ALCODE: kill process mid-task, reopen,\n" +
        "-`resume → orient → act` with state intact; all crash/concurrency tests pass.\n" +
        "+`resume → orient → act` with state intact; **Agent replacement/restart does\n" +
        "+not invalidate Host-owned execution identity or durable state** — the Host\n" +
        "+supervises the Agent, so replacing or restarting the Agent process preserves\n" +
        "+operation identity, session state, and canonical events; all\n" +
        "+crash/concurrency tests pass.\n",
      headContent:
        "**Exit gate:** `pnpm gate:0.5` emits `status: \"passed\"` — the Ouroboros 0.20\n" +
        "continuity proof reproduced in ALCODE: kill process mid-task, reopen,\n" +
        "`resume → orient → act` with state intact; **Agent replacement/restart does\n" +
        "not invalidate Host-owned execution identity or durable state** — the Host\n" +
        "supervises the Agent, so replacing or restarting the Agent process preserves\n" +
        "operation identity, session state, and canonical events; all\n" +
        "crash/concurrency tests pass.\n",
      baseContent: RI02_BROKEN.contextFiles[0].content,
    },
  ],

  contextFiles: [],

  expectedFinding: null,
  expectedVerdict: "eligible for APPROVE",
};

// ── RI-03: basePath omitted from activation URL (GitWire PR #123) ───────────
//
// Broken head: ef071ff — activation URL uses config.server.baseUrl + "/intelligence"
// but the Next.js dashboard uses basePath: '/dashboard'. The correct URL should be
// baseUrl + "/dashboard/intelligence".
//
// Fixed head: 67908f7 — extracted reviewActivationUrl() helper that includes /dashboard.

const RI03_BROKEN = {
  caseId: "RI-03",
  variant: "broken",
  source: "Octo-Lex/GitWire PR #123 (commit ef071ff)",
  title: "fix(product): AI review dual-gate activation — actionable skip, truthful ack",

  prMetadata: {
    title: "fix(product): AI review dual-gate activation — actionable skip, truthful ack (PF-B1-01)",
    body:
      "When .gitwire.yml has ai_review.enabled: true but the ai_review_config DB\n" +
      "row is missing or disabled, reviewPR() silently returned null. The check\n" +
      "finalized neutral with a message that contradicted the committed config.\n\n" +
      "Fix preserves the DB cost-control gate while making the skip explicit.",
    head: "ef071ff",
    base: "5f48600",
    author: "alajmah",
  },

  changedFiles: [
    {
      filename: "packages/web/src/services/aiReviewService.js",
      status: "modified",
      additions: 5,
      deletions: 1,
      patch:
        "--- a/packages/web/src/services/aiReviewService.js\n" +
        "+++ b/packages/web/src/services/aiReviewService.js\n" +
        "@@ -82,3 +82,7 @@\n" +
        "   if (!cfg?.enabled) {\n" +
        "-    return null;\n" +
        "+    return {\n" +
        "+      skipped: true,\n" +
        "+      reason: \"not_activated\",\n" +
        "+      activationUrl: config.server.baseUrl + \"/intelligence\"\n" +
        "+    };\n" +
        "   }\n",
      headContent:
        '  if (!cfg?.enabled) {\n' +
        '    return {\n' +
        '      skipped: true,\n' +
        '      reason: "not_activated",\n' +
        '      activationUrl: config.server.baseUrl + "/intelligence"\n' +
        '    };\n' +
        '  }\n',
      baseContent: "  if (!cfg?.enabled) {\n    return null;\n  }\n",
    },
  ],

  // The unchanged next.config.ts that declares basePath: '/dashboard'
  contextFiles: [
    {
      path: "packages/web-dashboard/next.config.ts",
      sha: "nextconfig_ts",
      content:
        'import type { NextConfig } from "next";\n\n' +
        "const nextConfig: NextConfig = {\n" +
        "  basePath: '/dashboard',\n" +
        "};\n\n" +
        "export default nextConfig;\n",
    },
  ],

  expectedFinding: {
    severity: "P1",
    title: "Activation URL missing /dashboard basePath",
    description:
      "The URL is constructed as baseUrl + '/intelligence' but next.config.ts sets " +
      "basePath: '/dashboard'. The correct URL is baseUrl + '/dashboard/intelligence'. " +
      "The current URL will produce a 404 in production.",
    evidencePaths: ["packages/web/src/services/aiReviewService.js", "packages/web-dashboard/next.config.ts"],
  },
  expectedVerdict: "never APPROVE",
};

const RI03_FIXED = {
  caseId: "RI-03",
  variant: "fixed",
  source: "Octo-Lex/GitWire PR #123 (commit 67908f7)",
  title: RI03_BROKEN.title,
  prMetadata: RI03_BROKEN.prMetadata,

  changedFiles: [
    {
      filename: "packages/web/src/services/aiReviewService.js",
      status: "modified",
      additions: 8,
      deletions: 2,
      patch:
        "--- a/packages/web/src/services/aiReviewService.js\n" +
        "+++ b/packages/web/src/services/aiReviewService.js\n" +
        "@@ -82,3 +82,7 @@\n" +
        "   if (!cfg?.enabled) {\n" +
        "-    return null;\n" +
        "+    return {\n" +
        "+      skipped: true,\n" +
        '+      reason: "not_activated",\n' +
        "+      activationUrl: reviewActivationUrl()\n" +
        "+    };\n" +
        "   }\n" +
        "@@ -805,0 +809,3 @@\n" +
        "+function reviewActivationUrl() {\n" +
        '+  return (config.server.baseUrl || "").replace(/\\/$/, "") + "/dashboard/intelligence";\n' +
        "+}\n",
      headContent:
        '  if (!cfg?.enabled) {\n' +
        '    return {\n' +
        '      skipped: true,\n' +
        '      reason: "not_activated",\n' +
        '      activationUrl: reviewActivationUrl()\n' +
        '    };\n' +
        '  }\n',
      baseContent: RI03_BROKEN.changedFiles[0].baseContent,
    },
  ],

  contextFiles: RI03_BROKEN.contextFiles,

  expectedFinding: null,
  expectedVerdict: "eligible for APPROVE",
};

// ── RI-04: Unpaginated marker lookup (GitWire PR #124) ──────────────────────
//
// Broken head: 624732c — triage comment gate broadened from exception-only to
// every issue, but findCommentByMarker() still fetches only one page of 100
// comments. The commentMarkers.js file is UNCHANGED in the broken diff —
// it's repository context that a reviewer would need to cross-reference.
//
// Fixed head: a32a07e — findCommentByMarker() paginates all comment pages.

const RI04_BROKEN = {
  caseId: "RI-04",
  variant: "broken",
  source: "Octo-Lex/GitWire PR #124 (commit 624732c)",
  title: "fix(product): triage auto_comment posts summary for every issue (PF-A1-01)",

  prMetadata: {
    title: "fix(product): triage auto_comment posts summary for every issue (PF-A1-01)",
    body:
      "Remove the needs_more_info/duplicate_hint trigger from the comment gate.\n" +
      "When auto_comment is enabled, every triaged issue receives one comment.\n",
    head: "624732c",
    base: "b8ccfb8",
    author: "alajmah",
  },

  // The broken diff changes ONLY triageWorker.js — NOT commentMarkers.js
  changedFiles: [
    {
      filename: "packages/web/src/workers/triageWorker.js",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch:
        "--- a/packages/web/src/workers/triageWorker.js\n" +
        "+++ b/packages/web/src/workers/triageWorker.js\n" +
        "@@ -354,2 +354,2 @@\n" +
        "-    if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {\n" +
        "+    if (triageOpts.auto_comment !== false) {\n",
      headContent:
        "    // PF-A1-01: comment gate is now just auto_comment\n" +
        "    if (triageOpts.auto_comment !== false) {\n",
      baseContent:
        "    if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {\n",
    },
  ],

  // commentMarkers.js is UNCHANGED — it's the repository context file that
  // contains the unpaginated findCommentByMarker. This is the exact retrieval
  // challenge: the reviewer must discover that the broadened comment path
  // now calls a function with a pagination defect.
  contextFiles: [
    {
      path: "packages/web/src/lib/commentMarkers.js",
      sha: "commentmarkers_624732c",
      content:
        "export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {\n" +
        "  // List comments — we'll search for the marker in the body\n" +
        "  const { data: comments } = await octokit.request(\n" +
        '    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",\n' +
        "    {\n" +
        "      owner,\n" +
        "      repo,\n" +
        "      issue_number: issueNumber,\n" +
        "      per_page: 100,\n" +
        "    }\n" +
        "  );\n\n" +
        "  // Filter to comments that contain our exact marker\n" +
        "  const matches = comments.filter((c) => c.body && c.body.includes(marker));\n\n" +
        "  if (matches.length === 0) {\n" +
        "    return null; // No existing comment — create new\n" +
        "  }\n" +
        "  if (matches.length === 1) {\n" +
        "    return matches[0]; // Exactly one — update it\n" +
        "  }\n" +
        "  // Multiple matches — ambiguous state, should be blocked\n" +
        "  return { ambiguous: true, comments: matches };\n" +
        "}\n",
    },
  ],

  expectedFinding: {
    severity: "P2",
    title: "Unpaginated findCommentByMarker will duplicate comments on high-volume issues",
    description:
      "The broadened comment path now calls findCommentByMarker() for every triaged " +
      "issue, but that function fetches only one page of 100 comments with no pagination. " +
      "If the marker comment is beyond page 1, it returns null and postMarkedComment " +
      "creates a duplicate comment.",
    evidencePaths: ["packages/web/src/workers/triageWorker.js", "packages/web/src/lib/commentMarkers.js"],
  },
  expectedVerdict: "never APPROVE",
};

const RI04_FIXED = {
  caseId: "RI-04",
  variant: "fixed",
  source: "Octo-Lex/GitWire PR #124 (commit a32a07e)",
  title: RI04_BROKEN.title,
  prMetadata: RI04_BROKEN.prMetadata,

  changedFiles: [
    {
      filename: "packages/web/src/workers/triageWorker.js",
      status: "modified",
      additions: 2,
      deletions: 2,
      patch: RI04_BROKEN.changedFiles[0].patch,
      headContent: RI04_BROKEN.changedFiles[0].headContent,
      baseContent: RI04_BROKEN.changedFiles[0].baseContent,
    },
    {
      filename: "packages/web/src/lib/commentMarkers.js",
      status: "modified",
      additions: 25,
      deletions: 1,
      patch:
        "--- a/packages/web/src/lib/commentMarkers.js\n" +
        "+++ b/packages/web/src/lib/commentMarkers.js\n" +
        "@@ -49,1 +49,25 @@\n" +
        "-export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {\n" +
        "-  const { data: comments } = await octokit.request(\n" +
        '-    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",\n' +
        "-    { owner, repo, issue_number: issueNumber, per_page: 100 }\n" +
        "-  );\n" +
        "+export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {\n" +
        "+  const matches = [];\n" +
        "+  let page = 1;\n" +
        "+  const PER_PAGE = 100;\n" +
        "+  while (true) {\n" +
        "+    const { data: comments } = await octokit.request(...);\n" +
        "+    for (const c of comments) { if (c.body && c.body.includes(marker)) matches.push(c); }\n" +
        "+    if (matches.length >= 2) return { ambiguous: true, comments: matches };\n" +
        "+    if (comments.length < PER_PAGE) break;\n" +
        "+    page++;\n" +
        "+  }\n",
      headContent:
        "export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker) {\n" +
        "  const matches = [];\n" +
        "  let page = 1;\n" +
        "  const PER_PAGE = 100;\n" +
        "  while (true) {\n" +
        '    const { data: comments } = await octokit.request("GET /repos/...", { ... per_page: PER_PAGE, page });\n' +
        "    for (const c of comments) { if (c.body && c.body.includes(marker)) matches.push(c); }\n" +
        "    if (matches.length >= 2) return { ambiguous: true, comments: matches };\n" +
        "    if (comments.length < PER_PAGE) break;\n" +
        "    page++;\n" +
        "  }\n",
      baseContent: RI04_BROKEN.contextFiles[0].content,
    },
  ],

  contextFiles: [],

  expectedFinding: null,
  expectedVerdict: "eligible for APPROVE",
};

// ── Exports ─────────────────────────────────────────────────────────────────

export const REGISTRY = Object.freeze([
  RI01_BROKEN, RI01_FIXED,
  RI02_BROKEN, RI02_FIXED,
  RI03_BROKEN, RI03_FIXED,
  RI04_BROKEN, RI04_FIXED,
]);

export function getAllFixtures() {
  return REGISTRY;
}

export function getBrokenFixtures() {
  return REGISTRY.filter((f) => f.variant === "broken");
}

export function getFixedFixtures() {
  return REGISTRY.filter((f) => f.variant === "fixed");
}
