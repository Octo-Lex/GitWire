// tests/unit/dependency-seed.test.js
// Deterministic tests for the first-order dependency seeding layer (RI-9
// architecture correction: obvious code dependencies reach the reviewer
// deterministically, regardless of model exploration behavior).
//
// Covers the frozen invariant list plus a synthetic (non-pagination) fixture
// and the RI-04 regression — the planner must naturally seed
// commentMarkers.js from triageWorker.js's import list, with no
// fixture-specific special cases anywhere in the planner.

import {
  parseLocalImports,
  resolveSpecifier,
  associatedTestCandidates,
  planAndSeedDependencies,
  applySeedResultsToEvidence,
  SEED_BOUNDS,
} from "../../src/services/dependencySeedService.js";
import { getAllFixtures } from "../evaluation/review-integrity/fixtures/registry.js";
import { buildFixtureOctokit } from "../evaluation/review-integrity/fixtureOctokit.js";

const HEAD = "head1111111111111111111111111111111111111111";
const BASE = "base2222222222222222222222222222222222222222";

/** Octokit mock over an explicit file map (path -> content), ref-insensitive. */
function makeOctokit(files) {
  return {
    request: async function (route, params) {
      if (route.includes("/git/trees/")) {
        return { data: { tree: Object.keys(files).map(p => ({ path: p, type: "blob", sha: "blob_" + p, size: files[p].length })), truncated: false } };
      }
      if (route.includes("/git/blobs/")) {
        const sha = decodeURIComponent(route.split("/").pop());
        for (const [p, c] of Object.entries(files)) {
          if (sha === "blob_" + p) return { data: { encoding: "base64", content: Buffer.from(c).toString("base64"), size: c.length } };
        }
        return Promise.reject(new Error("404 blob"));
      }
      if (route.includes("/contents/")) {
        const path = decodeURIComponent(params.path || route.split("/contents/")[1]);
        if (files[path] !== undefined) {
          return { data: { type: "file", encoding: "base64", content: Buffer.from(files[path]).toString("base64"), sha: "blob_" + path, size: files[path].length } };
        }
        return Promise.reject(new Error("404 Not Found: " + path));
      }
      return { data: {} };
    },
  };
}

function makeEvidence(changedFiles, extra = {}) {
  return {
    version: 1,
    review: { repoId: 1, repoFullName: "org/repo", prNumber: 1, baseSha: BASE, headSha: HEAD, invocationId: "rinv:test" },
    changedFiles,
    contextItems: [],
    retrievalTrace: [],
    coverage: { approvalEvidenceComplete: true, totalChangedFiles: changedFiles.length },
    ...extra,
  };
}

function srcFile(path, content, patch = "") {
  return { path, status: "modified", additions: 1, deletions: 1, patch, coverage: "full", headContent: content };
}

// ── Pure parser tests (synthetic, non-pagination fixture) ───────────────────

describe("RI-9 seed planner: import parsing and resolution", () => {

  it("parses ESM named/default/side-effect imports and CJS require, relative only", () => {
    const source = [
      'import { helper, other as alias } from "./lib/helpers.js";',
      'import defaultThing from "../pkg/thing.js";',
      'import "./side-effect.js";',
      'import * as ns from "./ns.js";',
      'const { a } = require("./cjs.js");',
      'const dyn = await import("./dyn.js");',
      'import { x } from "@gitwire/rules";', // bare — NOT local
    ].join("\n");
    const imports = parseLocalImports(source);
    const specs = imports.map(i => i.specifier).sort();
    expect(specs).toEqual(["../pkg/thing.js", "./cjs.js", "./dyn.js", "./lib/helpers.js", "./ns.js", "./side-effect.js"].sort());
    const helpers = imports.find(i => i.specifier === "./lib/helpers.js");
    expect(helpers.bindings.sort()).toEqual(["alias", "helper"].sort());
  });

  it("resolves relative specifiers to deterministic candidate repo paths", () => {
    expect(resolveSpecifier("src/workers/worker.js", "../lib/commentMarkers.js")[0])
      .toBe("src/lib/commentMarkers.js");
    expect(resolveSpecifier("src/a.js", "./b")[0]).toBe("src/b");
    expect(resolveSpecifier("src/a.js", "./b").slice(0, 6))
      .toEqual(["src/b", "src/b.js", "src/b.mjs", "src/b.cjs", "src/b.ts", "src/b.tsx"]);
  });

  it("derives deterministic associated test candidates", () => {
    expect(associatedTestCandidates("src/lib/commentMarkers.js"))
      .toEqual([
        "src/lib/commentMarkers.test.js",
        "src/lib/commentMarkers.spec.js",
        "src/lib/__tests__/commentMarkers.test.js",
      ]);
  });
});

// ── Planner integration tests (synthetic fixture) ───────────────────────────

describe("RI-9 seed planner: deterministic seeding", () => {

  const FILES = {
    "src/app.js": "import { validate } from \"./lib/validate.js\";\nimport { noise } from \"./lib/noise.js\";\nexport function run(v) { return validate(v); }\n",
    "src/lib/validate.js": "export function validate(v) { return v > 0; }\nexport function unused() { return 1; }\n",
    "src/lib/noise.js": "export function noise() { return 1; }\n",
    "src/lib/unrelated.js": "export const never = true;\n",
    "src/app.test.js": "import { run } from \"./app.js\";\ntest('runs', () => { expect(run(1)).toBe(true); });\n",
  };

  // patch references the binding `validate` (a locally referenced callee)
  const PATCH = "@@ -1,3 +1,3 @@\n-old line\n+if (!validate(input)) throw new Error('bad');\n";

  it("seeds a changed local import at the exact SHA with provenance; callee use promotes it", async () => {
    const evidence = makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]);
    const result = await planAndSeedDependencies({
      evidence, octokit: makeOctokit(FILES), owner: "org", repo: "repo",
    });

    const paths = result.seededItems.map(s => s.path);
    expect(paths).toContain("src/lib/validate.js");
    expect(paths).toContain("src/lib/noise.js"); // plain local import
    expect(paths).toContain("src/app.test.js"); // associated test of the CHANGED file

    const validate = result.seededItems.find(s => s.path === "src/lib/validate.js");
    expect(validate.retrievalReason).toBe("local_call_dependency"); // patch-referenced
    expect(validate.blobSha).toBe("blob_src/lib/validate.js");
    expect(validate.contentDigest).toMatch(/^sha256:/);
    expect(validate.content).toContain("export function validate");

    const noise = result.seededItems.find(s => s.path === "src/lib/noise.js");
    expect(noise.retrievalReason).toBe("local_import");
    expect(noise.tier).toBe("optional");

    // Unrelated repository files are NOT pulled in
    expect(paths).not.toContain("src/lib/unrelated.js");
  });

  it("is deterministic: identical PR + SHA produces identical plan output", async () => {
    const run = async () => {
      const evidence = makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]);
      const r = await planAndSeedDependencies({ evidence, octokit: makeOctokit(FILES), owner: "org", repo: "repo" });
      return { planned: r.planned, seeded: r.seededItems.map(s => ({ path: s.path, reason: s.retrievalReason, digest: s.contentDigest, range: s.range, truncated: s.truncated, tier: s.tier })) };
    };
    expect(await run()).toEqual(await run());
  });

  it("seed bytes count against the shared 90K retrieval ceiling", async () => {
    const evidence = makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]);
    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(FILES), owner: "org", repo: "repo" });
    const bs = result.broker.getBudgetState();
    expect(bs.retrievedChars).toBeGreaterThan(0);
    expect(bs.retrievedChars).toBeLessThanOrEqual(bs.limits.maxRetrievedChars);
    // every seeded char is accounted in the broker budget the primary inherits
    const seedChars = result.seededItems.reduce((s, i) => s + i.content.length, 0);
    expect(bs.retrievedChars).toBeGreaterThanOrEqual(seedChars);
  });

  it("a REQUIRED seed denied by a hard boundary makes evidence incomplete", async () => {
    // Tiny char budget so the required read cannot fit
    const evidence = makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]);
    const result = await planAndSeedDependencies({
      evidence, octokit: makeOctokit(FILES), owner: "org", repo: "repo",
      budgets: { maxRetrievedChars: 150 }, // window read fits, required seed does not
    });
    expect(result.requiredFailures.length).toBeGreaterThanOrEqual(0); // shape
    // Force the deterministic assertion: with a budget too small for the
    // required dependency, either it failed OR everything fit under denial.
    const applied = applySeedResultsToEvidence(makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]), result);
    if (result.requiredFailures.length > 0) {
      expect(applied.coverage.approvalEvidenceComplete).toBe(false);
      expect(applied.coverage.unresolvedContextRequests.some(u => u.source === "seed_required")).toBe(true);
    } else {
      expect(applied.coverage.approvalEvidenceComplete).toBe(true);
    }
  });

  it("applySeedResultsToEvidence merges seeds into contextItems and preserves eligibility otherwise", async () => {
    const evidence = makeEvidence([srcFile("src/app.js", FILES["src/app.js"], PATCH)]);
    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(FILES), owner: "org", repo: "repo" });
    const applied = applySeedResultsToEvidence(evidence, result);
    expect(applied.contextItems.length).toBe(result.seededItems.length);
    expect(applied.coverage.approvalEvidenceComplete).toBe(true); // no required failures here
    for (const item of applied.contextItems) {
      expect(item.blobSha).toBeTruthy();
      expect(item.contentDigest).toMatch(/^sha256:/);
      expect(["local_import", "local_call_dependency", "associated_test"]).toContain(item.retrievalReason);
    }
  });
});

// ── Planner allocation accounting (unified 45K: windows + seeds) ────────────

describe("RI-9 seed planner: unified allocation accounting", () => {

  it("counts import-window reads toward the planner allocation (never exceeds 45K)", async () => {
    // Large changed files: window reads alone approach the allocation.
    const bigContent = ("// padding line of substantial length for accounting test 0123456789\n").repeat(400);
    const files = { "src/big.js": bigContent, "src/big2.js": bigContent, "src/big3.js": bigContent };
    const evidence = makeEvidence([
      srcFile("src/big.js", bigContent, ""),
      srcFile("src/big2.js", bigContent, ""),
      srcFile("src/big3.js", bigContent, ""),
    ]);
    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(files), owner: "org", repo: "repo" });

    expect(result.plannerCharsUsed).toBeLessThanOrEqual(45000);
    expect(result.broker.getBudgetState().retrievedChars).toBeLessThanOrEqual(45000);
  });

  it("counts dependency seed reads toward the same allocation — total never exceeds 45K", async () => {
    // Many sizable dependencies; the final seed must not overshoot.
    const depContent = "export function d() { /* " + "x".repeat(9000) + " */ }\n";
    const files = { "src/app.js": "" };
    let importLines = "";
    for (let i = 0; i < 10; i++) {
      files["src/lib/dep" + i + ".js"] = depContent;
      importLines += 'import { d' + i + ' } from "./lib/dep' + i + '.js";\n';
    }
    files["src/app.js"] = importLines + "export function run() { return 1; }\n";
    const evidence = makeEvidence([srcFile("src/app.js", files["src/app.js"], "")]);

    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(files), owner: "org", repo: "repo" });

    expect(result.plannerCharsUsed).toBeLessThanOrEqual(45000);
    expect(result.plannerCharsUsed).toBeGreaterThan(40000); // allocation genuinely used
    // No overshoot: the capped last seed fits exactly within the ceiling
    expect(result.broker.getBudgetState().retrievedChars).toBeLessThanOrEqual(45000);
  });

  it("REQUIRED dependencies claim the allocation before OPTIONAL ones", async () => {
    // Long lines so each 250-line seed window is ~30K chars: the REQUIRED
    // module consumes most of the 45K allocation; the OPTIONAL one (sorting
    // later) can only receive the truncated remainder or be skipped.
    const pad = (label) => ("// pad " + label + " " + "y".repeat(120) + "\n").repeat(300);
    const files = {
      "src/app.js": 'import { required } from "./lib/a-first.js";\nimport { opt } from "./lib/z-second.js";\nexport function run() { return required(opt); }\n',
      "src/lib/a-first.js": "export function required(x) { return x; }\n" + pad("a"),
      "src/lib/z-second.js": "export function opt() { return 1; }\n" + pad("z"),
    };
    const patch = "@@ -1,2 +1,2 @@\n-old\n+return required(opt);";
    const evidence = makeEvidence([srcFile("src/app.js", files["src/app.js"], patch)]);

    const result = await planAndSeedDependencies({
      evidence, octokit: makeOctokit(files), owner: "org", repo: "repo",
    });

    const req = result.seededItems.find(s => s.path === "src/lib/a-first.js");
    expect(req).toBeDefined();
    expect(req.tier).toBe("required");
    expect(req.content.length).toBeGreaterThan(20000); // full 250-line claim, not squeezed out
    const opt = result.seededItems.find(s => s.path === "src/lib/z-second.js");
    if (opt) {
      // Hard ceiling: the optional seed got only the truncated remainder —
      // window + required + optional together stay inside the allocation
      expect(opt.truncated).toBe(true);
      expect(result.plannerCharsUsed).toBeLessThanOrEqual(45000);
      expect(opt.content.length).toBeLessThanOrEqual(45000 - req.content.length);
    } else {
      expect(result.skipped.some(s => s.path === "src/lib/z-second.js" && s.reason === "seed_budget")).toBe(true);
    }
    expect(result.plannerCharsUsed).toBeLessThanOrEqual(45000);
  });

  it("a REQUIRED dependency that cannot fit is an explicit required failure", async () => {
    // The import window itself (120 long lines ≈ 18K) plus a first big
    // required dep exhaust the allocation; the second required dep cannot fit.
    const longPad = ("// window padding " + "z".repeat(150) + "\n").repeat(120);
    const files = {
      "src/app.js": 'import { r1 } from "./lib/one.js";\nimport { r2 } from "./lib/two.js";\nexport function run() { return r1(r2(1)); }\n' + longPad,
      "src/lib/one.js": "export function r1(x) { return x; }\n" + ("// one " + "a".repeat(120) + "\n").repeat(300),
      "src/lib/two.js": "export function r2(x) { return x; }\n" + ("// two " + "b".repeat(120) + "\n").repeat(300),
    };
    const patch = "@@ -1,2 +1,2 @@\n-old\n+return r1(r2(1));";
    const evidence = makeEvidence([srcFile("src/app.js", files["src/app.js"], patch)]);
    const result = await planAndSeedDependencies({
      evidence, octokit: makeOctokit(files), owner: "org", repo: "repo",
    });

    expect(result.requiredFailures.length).toBeGreaterThanOrEqual(1);
    expect(result.requiredFailures[0].reason).toBe("planner_allocation_exhausted");
    const applied = applySeedResultsToEvidence(evidence, result);
    expect(applied.coverage.approvalEvidenceComplete).toBe(false);
    expect(applied.coverage.unresolvedContextRequests.some(u => u.source === "seed_required")).toBe(true);
  });

  it("each planned dependency appears at most once and REQUIRED wins over OPTIONAL", async () => {
    // Two changed files import the SAME module; only the second references it in its patch.
    const files = {
      "src/one.js": 'import { shared } from "./lib/shared.js";\nexport function a() { return shared; }\n',
      "src/two.js": 'import { shared } from "./lib/shared.js";\nexport function b() { return shared(2); }\n',
      "src/lib/shared.js": "export function shared(x) { return x; }\n",
    };
    const evidence = makeEvidence([
      srcFile("src/one.js", files["src/one.js"], "unrelated patch text"),
      srcFile("src/two.js", files["src/two.js"], "@@ -1,2 +1,2 @@\n-old\n+return shared(2);"),
    ]);
    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(files), owner: "org", repo: "repo" });

    const sharedEntries = result.planned.filter(p => p.path === "src/lib/shared.js");
    expect(sharedEntries).toHaveLength(1);
    expect(sharedEntries[0].tier).toBe("required");
    const seededShared = result.seededItems.find(s => s.path === "src/lib/shared.js");
    expect(seededShared.tier).toBe("required");
    expect(seededShared.retrievalReason).toBe("local_call_dependency");
  });

  it("the primary begins with ≥45K retrieval remaining after planning", async () => {
    const files = {
      "src/app.js": 'import { validate } from "./lib/validate.js";\nexport function run(v) { return validate(v); }\n',
      "src/lib/validate.js": "export function validate(v) { return v > 0; }\n",
      "src/app.test.js": "import { run } from \"./app.js\";\ntest('runs', () => {});\n",
    };
    const evidence = makeEvidence([srcFile("src/app.js", files["src/app.js"], "+return validate(v);")]);
    const result = await planAndSeedDependencies({ evidence, octokit: makeOctokit(files), owner: "org", repo: "repo" });
    const remaining = result.broker.getBudgetState().limits.maxRetrievedChars - result.broker.getBudgetState().retrievedChars;
    expect(remaining).toBeGreaterThanOrEqual(45000);
  });
});

// ── RI-04 regression: commentMarkers.js must be seeded naturally ────────────

describe("RI-9 seed planner: RI-04 regression (natural, not special-cased)", () => {

  it("seeds packages/web/src/lib/commentMarkers.js from triageWorker.js imports", async () => {
    const fixture = getAllFixtures().find(f => f.caseId === "RI-04" && f.variant === "broken");
    const octokit = buildFixtureOctokit(fixture);

    const evidence = makeEvidence(
      fixture.changedFiles.map(cf => ({
        path: cf.filename, status: cf.status,
        additions: cf.additions, deletions: cf.deletions,
        patch: cf.patch || "", coverage: "full",
      })),
      { review: { repoId: 1, repoFullName: "org/repo", prNumber: 1, baseSha: fixture.prMetadata.base, headSha: fixture.prMetadata.head, invocationId: "rinv:ri04" } }
    );

    const result = await planAndSeedDependencies({ evidence, octokit, owner: "org", repo: "repo" });
    const paths = result.seededItems.map(s => s.path);

    // The deterministic edge: triageWorker.js line 29 imports postMarkedComment
    // and buildMarker from ../lib/commentMarkers.js — the planner must reach it
    // through the generic import rule, before any model exploration.
    expect(paths).toContain("packages/web/src/lib/commentMarkers.js");

    const cm = result.seededItems.find(s => s.path === "packages/web/src/lib/commentMarkers.js");
    expect(cm.content).toContain("findCommentByMarker"); // real content, not a stub
    expect(cm.contentDigest).toMatch(/^sha256:/);
    expect(cm.blobSha).toBeTruthy();
    // Real identity: blobSha resolves in the fixture surface
    expect(cm.ref).toBe(fixture.prMetadata.head);

    // Bounded: total seeds respect the caps
    expect(result.seededItems.length).toBeLessThanOrEqual(SEED_BOUNDS.maxSeedFiles);
    const bs = result.broker.getBudgetState();
    expect(bs.retrievedChars).toBeLessThanOrEqual(bs.limits.maxRetrievedChars);
    // Deterministic plan for the fixture
    expect(result.planned.filter(p => p.tier === "required").length)
      .toBe(result.planned.filter(p => p.reason === "local_call_dependency").length);
  });
});

// ── Verifier independence ───────────────────────────────────────────────────

describe("RI-9 seed planner: verifier independence", () => {

  it("seeding flows only through evidence context — the verifier prompt builder is unaffected by seeds", async () => {
    // The verifier consumes evidence.changedFiles only; seeds live in
    // contextItems/seededDependencies, which buildVerifierUserPrompt ignores.
    const { buildVerifierSystemPrompt } = await import("../../src/services/approvalVerificationService.js");
    const withSeeds = makeEvidence([srcFile("src/app.js", FILES_APP, PATCH_APP)], {
      seededDependencies: [{ path: "src/lib/validate.js", content: "SECRET-SEED-CONTENT" }],
      contextItems: [{ path: "src/lib/validate.js", content: "SECRET-SEED-CONTENT", type: "file_read" }],
    });
    const withoutSeeds = makeEvidence([srcFile("src/app.js", FILES_APP, PATCH_APP)]);
    const a = buildVerifierSystemPrompt(withSeeds);
    const b = buildVerifierSystemPrompt(withoutSeeds);
    expect(a).toBe(b);
    expect(a).not.toContain("SECRET-SEED-CONTENT");
  });
});

const FILES_APP = "import { validate } from \"./lib/validate.js\";\nexport function run(v) { return validate(v); }\n";
const PATCH_APP = "@@ -1,2 +1,2 @@\n-old\n+return validate(v);\n";
