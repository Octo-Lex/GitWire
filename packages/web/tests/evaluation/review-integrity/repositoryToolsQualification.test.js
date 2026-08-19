// Repository-instrument qualification — historical oracle suite
// (RI-9 amendment, Phase 5).
//
// Before ANY model evaluation resumes, the repository instrument must
// mechanically prove, for every frozen historical fixture (RI-01 through
// RI-04, broken AND fixed), that the defect-supporting repository facts are
// retrievable and that their absence/presence is authoritative. Expected
// values below are hardcoded oracle facts extracted independently from the
// frozen snapshots — the suite never re-derives them from the same store it
// is testing.
//
// If ANY probe here fails, no model runs.

import { createRepositoryTools } from "../../../src/lib/repositoryTools/index.js";
import { isAuthoritativeAbsence } from "../../../src/lib/repositoryTools/contract.js";
import { sessionForFixture, loadFixture, closeAllFixtureSessions } from "./fixtures/fixtureGitMaterializer.js";

const COMMENT_MARKERS = "packages/web/src/lib/commentMarkers.js";
const AI_REVIEW = "packages/web/src/services/aiReviewService.js";
const NEXT_CONFIG = "packages/web-dashboard/next.config.ts";

// The eight gitwire blobs whose bytes are not recoverable from the UTF-8
// snapshot store (all binaries) — the explicit divergence ledger.
const GITWIRE_DIVERGENT = [
  ".github/banner.png",
  "GitWire platform architecture diagram.png",
  "GitWire platform architecture diagram2.png",
  "TelegramBot.png",
  "banner.png",
  "docs/public/mediapackage.png",
  "landing/banner.png",
  "packages/web-dashboard/src/app/favicon.ico",
];

async function qualifiedTools(caseId, variant) {
  const fixture = loadFixture(caseId, variant);
  const session = await sessionForFixture(fixture);
  return { session, tools: createRepositoryTools(session), fixture };
}

afterAll(() => {
  closeAllFixtureSessions();
});

describe("checkout identity — every frozen fixture materializes at its exact BASE/HEAD", () => {
  const CASES = [
    ["ri01", "broken"], ["ri01", "fixed"],
    ["ri02", "broken"], ["ri02", "fixed"],
    ["ri03", "broken"], ["ri03", "fixed"],
    ["ri04", "broken"], ["ri04", "fixed"],
  ];

  it.each(CASES)("%s/%s: identity report is exact and the worktree is clean", async (caseId, variant) => {
    const { session } = await qualifiedTools(caseId, variant);
    const { identityReport } = session;
    expect(identityReport.checked).toBeGreaterThan(0);
    expect(identityReport.unexpected).toEqual([]);
    expect(identityReport.divergent.map((d) => d.kind)).not.toContain("missing");
    const total = identityReport.faithful.length + identityReport.divergent.length;
    expect(total).toBe(identityReport.checked);

    if (session.repository.includes("AlCode")) {
      expect(identityReport.divergent).toEqual([]);
    } else {
      expect(identityReport.divergent.map((d) => d.path).sort()).toEqual([...GITWIRE_DIVERGENT].sort());
      expect(identityReport.divergent.every((d) => d.kind === "binary")).toBe(true);
    }
    await expect(session.assertCleanWorktree()).resolves.toBeUndefined();
  }, 240000);

  it("materialization is deterministic for a fixture pair (same snapshot → same HEAD)", async () => {
    const a = await qualifiedTools("ri01", "broken");
    const b = await qualifiedTools("ri02", "broken"); // same alcode base/head pair
    expect(a.session.headSha).toBe(b.session.headSha);
  });
});

describe("RI-04 oracle — findCommentByMarker pagination defect", () => {
  it("broken head: the unpaginated implementation is exactly retrievable", async () => {
    const { tools } = await qualifiedTools("ri04", "broken");

    const grepDef = await tools.grep({ pattern: "findCommentByMarker", path: COMMENT_MARKERS });
    expect(grepDef.status).toBe("success");
    expect(grepDef.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: COMMENT_MARKERS, line: 49 })])
    );

    const grepPerPage = await tools.grep({ pattern: "per_page", path: COMMENT_MARKERS });
    expect(grepPerPage.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: 57, text: expect.stringContaining("per_page: 100") })])
    );

    const readDef = await tools.read({ path: COMMENT_MARKERS, offset: 49, limit: 12 });
    expect(readDef.status).toBe("partial");
    expect(readDef.partialReasons).toEqual(["output_lines"]);
    expect(readDef.data.content).toContain("export async function findCommentByMarker(octokit, owner, repo, issueNumber, marker)");
    expect(readDef.data.content).toContain("per_page: 100");
  });

  it("broken head: the pagination loop is AUTHORITATIVELY ABSENT — the discriminator", async () => {
    const { tools } = await qualifiedTools("ri04", "broken");
    // literal: the parentheses are text, not an ERE group — a regex here
    // would make the absence probe vacuously true.
    const result = await tools.grep({ pattern: "while (true)", literal: true, path: COMMENT_MARKERS });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.matches).toEqual([]);
    expect(isAuthoritativeAbsence(result)).toBe(true);
  });

  it("broken head: relevant tests and directory contents are discoverable", async () => {
    const { tools } = await qualifiedTools("ri04", "broken");

    const tests = await tools.find({ glob: "*triage*.test.js" });
    expect(tests.status).toBe("success");
    expect(tests.data.paths).toContain("packages/web/tests/unit/triage-auto-comment.test.js");

    const lib = await tools.ls({ path: "packages/web/src/lib" });
    expect(lib.status).toBe("success");
    const names = lib.data.entries.map((e) => e.name);
    expect(names).toContain("commentMarkers.js");
    expect(names).toContain("webhookHandlers");
  });

  it("fixed head: the pagination loop exists and is exactly retrievable", async () => {
    const { tools } = await qualifiedTools("ri04", "fixed");

    const grepDef = await tools.grep({ pattern: "findCommentByMarker", path: COMMENT_MARKERS });
    expect(grepDef.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: 56 })])
    );

    const grepLoop = await tools.grep({ pattern: "while (true)", literal: true, path: COMMENT_MARKERS });
    expect(grepLoop.status).toBe("success");
    expect(grepLoop.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: 62, text: expect.stringContaining("while (true)") })])
    );

    const readLoop = await tools.read({ path: COMMENT_MARKERS, offset: 56, limit: 36 });
    expect(readLoop.data.content).toContain("let page = 1;");
    expect(readLoop.data.content).toContain("page++;");
  });
});

describe("RI-03 oracle — activation URL missing /dashboard basePath", () => {
  it("broken head: the wrong URL and the basePath constraint are both retrievable", async () => {
    const { tools } = await qualifiedTools("ri03", "broken");

    const grepUrl = await tools.grep({ pattern: 'baseUrl + "/intelligence"', literal: true, path: AI_REVIEW });
    expect(grepUrl.status).toBe("success");
    expect(grepUrl.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: AI_REVIEW, line: 826 })])
    );

    const readConfig = await tools.read({ path: NEXT_CONFIG, offset: 5, limit: 1 });
    expect(readConfig.data.content).toBe("  basePath: '/dashboard',");
  });

  it("broken head: the CORRECT URL is AUTHORITATIVELY ABSENT — the discriminator", async () => {
    const { tools } = await qualifiedTools("ri03", "broken");
    const result = await tools.grep({ pattern: "dashboard/intelligence", literal: true });
    expect(result.status).toBe("success");
    expect(result.complete).toBe(true);
    expect(result.data.matches).toEqual([]);
    expect(isAuthoritativeAbsence(result)).toBe(true);
  });

  it("fixed head: the corrected URL is retrievable", async () => {
    const { tools } = await qualifiedTools("ri03", "fixed");
    const result = await tools.grep({ pattern: "dashboard/intelligence", literal: true, path: AI_REVIEW });
    expect(result.status).toBe("success");
    expect(result.data.matches.length).toBeGreaterThanOrEqual(2);
    expect(result.data.matches.every((m) => m.text.includes("/dashboard/intelligence"))).toBe(true);
  });
});

describe("RI-01 oracle — contradictory Phase 0 status declarations", () => {
  it("broken head: the reopened/closed contradiction is exactly retrievable", async () => {
    const { tools } = await qualifiedTools("ri01", "broken");

    const grepReopened = await tools.grep({ pattern: "reopened", glob: "*.md" });
    expect(grepReopened.status).toBe("success");
    expect(grepReopened.data.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "README.md", line: 11 }),
        expect.objectContaining({ path: "docs/constitution.md", line: 70 }),
      ])
    );

    const readReadme = await tools.read({ path: "README.md", offset: 11, limit: 1 });
    expect(readReadme.data.content).toContain("Phase 0.0");
    expect(readReadme.data.content).toContain("reopened");

    const readSpec = await tools.read({ path: "docs/phase-0-spec.md", offset: 120, limit: 1 });
    expect(readSpec.data.content).toContain("Phase 0.0 — Architecture foundation (CLOSED)");
  });

  it("fixed head: the reopened claims are AUTHORITATIVELY ABSENT in README and constitution", async () => {
    const { tools } = await qualifiedTools("ri01", "fixed");
    for (const docPath of ["README.md", "docs/constitution.md"]) {
      const result = await tools.grep({ pattern: "reopened", path: docPath });
      expect(result.status).toBe("success");
      expect(result.complete).toBe(true);
      expect(result.data.matches).toEqual([]);
      expect(isAuthoritativeAbsence(result)).toBe(true);
    }
    const heading = await tools.grep({ pattern: "Phase 0.0 — Architecture foundation", literal: true, path: "docs/phase-0-spec.md" });
    expect(heading.data.matches.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RI-02 oracle — gate 0.5 missing agent-replacement assertions", () => {
  it("broken head: the continuity-only exit proof is retrievable AND agent replacement is AUTHORITATIVELY ABSENT", async () => {
    const { tools } = await qualifiedTools("ri02", "broken");

    const exitProof = await tools.grep({ pattern: "0.5 exit proof", literal: true, path: "docs/roadmap.md" });
    expect(exitProof.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: 234, text: expect.stringContaining("kill") })])
    );

    const replacement = await tools.grep({ pattern: "Agent replacement", literal: true, path: "docs/phase-0-spec.md" });
    expect(replacement.status).toBe("success");
    expect(replacement.complete).toBe(true);
    expect(replacement.data.matches).toEqual([]);
    expect(isAuthoritativeAbsence(replacement)).toBe(true);
  });

  it("fixed head: the agent-replacement requirement is exactly retrievable", async () => {
    const { tools } = await qualifiedTools("ri02", "fixed");

    const replacement = await tools.grep({ pattern: "Agent replacement", literal: true, path: "docs/phase-0-spec.md" });
    expect(replacement.status).toBe("success");
    expect(replacement.data.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ line: 544 })])
    );

    const readIt = await tools.read({ path: "docs/phase-0-spec.md", offset: 544, limit: 3 });
    expect(readIt.data.content).toContain("Agent replacement/restart");
    expect(readIt.data.content).toContain("replacing or restarting the Agent process preserves");
  });
});

describe("divergent binary blobs fail closed for reads, never poison search", () => {
  it("gitwire: reading a snapshot-divergent binary errors; grepping near it stays truthful", async () => {
    const { tools } = await qualifiedTools("ri04", "broken");

    const readBanner = await tools.read({ path: "banner.png" });
    expect(readBanner.status).toBe("error");
    expect(readBanner.error.code).toBe("E_UNFAITHFUL_BLOB");

    const findBanner = await tools.find({ glob: "banner.png" });
    expect(findBanner.status).toBe("success");
    expect(findBanner.data.paths).toContain("banner.png");
  });

  it("alcode: no divergent blobs exist, so absence claims are never scope-limited", async () => {
    const { tools, session } = await qualifiedTools("ri01", "broken");
    expect(session.unfaithfulPaths()).toEqual([]);
    const result = await tools.grep({ pattern: "zzz_no_such_symbol_anywhere" });
    expect(isAuthoritativeAbsence(result)).toBe(true);
    expect(result.partialReasons).not.toContain("unfaithful_scope");
  });

  it("gitwire: repo-wide search over divergent binaries reports the skip, never fakes absence", async () => {
    const { tools } = await qualifiedTools("ri04", "broken");
    const result = await tools.grep({ pattern: "zzz_no_such_symbol_anywhere" });
    // Binary divergence is a skip-as-binary class (text search over binary
    // content is vacuous), so absence stays authoritative — but the skip is
    // always reported.
    expect(result.status).toBe("success");
    expect(isAuthoritativeAbsence(result)).toBe(true);
    expect(result.data.skippedUnfaithful).toEqual(
      expect.arrayContaining(["banner.png", ".github/banner.png"])
    );
  });
});
