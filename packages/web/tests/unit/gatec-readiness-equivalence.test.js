// tests/unit/gatec-readiness-equivalence.test.js
// Gate C readiness equivalence proof: the offline replica
// (tests/evaluation/review-quality-baseline/gatec-readiness/bundle-replica.mjs)
// must produce BYTE-IDENTICAL bundles and identical coverageAdjustments to the
// REAL production buildReviewBundle on all 25 frozen-cohort reviews, in both
// context scenarios, at the production 4k cap. This test doubles as the
// deterministic regression that existing 4k production behavior is unchanged.

import { jest } from "@jest/globals";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INPUTS_PATH = fileURLToPath(new URL("../../../../tests/evaluation/review-quality-baseline/gatec-readiness/pr-files-v1.json", import.meta.url));
const REPLICA_PATH = fileURLToPath(new URL("../../../../tests/evaluation/review-quality-baseline/gatec-readiness/bundle-replica.mjs", import.meta.url));

// Scenario-controlled db mock: every context query returns the scenario rows.
let scenarioRows = { issues: [], ci: [], priorReviews: [] };
const mockQuery = jest.fn(async (sql) => {
  if (sql.includes("FROM issues")) return { rows: scenarioRows.issues };
  if (sql.includes("FROM ci_runs")) return { rows: scenarioRows.ci };
  if (sql.includes("FROM ai_reviews")) return { rows: scenarioRows.priorReviews };
  return { rows: [] };
});

await jest.unstable_mockModule("../../src/lib/db.js", () => ({ db: { query: mockQuery } }));
await jest.unstable_mockModule("../../src/lib/logger.js", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
await jest.unstable_mockModule("../../src/services/configService.js", () => ({
  getConfigForRepo: jest.fn().mockResolvedValue({}),
}));

const { buildReviewBundle } = await import("../../src/services/reviewBundleService.js");
const replicaModule = await import(urlToPathImport(REPLICA_PATH));
const { buildBundleReplica, CONTEXT_LO, contextHI, prWithBody, configLO, configHI } = replicaModule;

function urlToPathImport(u) { return "file://" + u.replace(/\\/g, "/"); }

const inputs = JSON.parse(readFileSync(INPUTS_PATH, "utf-8"));
const reviews = Object.values(inputs);
expect(reviews.length).toBe(25);

// Admitted files are the builder's input in production (admission happens in
// reviewCoverageService). For the equivalence proof we feed ALL changed files
// (admission is cap-independent and exercised separately in the harness); a
// few largest reviews exceed 180k only after admission, which is what the
// rebuild path needs to be exercised. To force the rebuild path in at least
// some cases we also run a variant admitting only the first N files — no:
// keep it honest, use the real admission from the harness results? Simpler
// and still exact: run the builder on the FULL file list; where the bundle
// stays under 180k the rebuild path is simply not triggered, and the harness
// covers admission separately.

function toBuilderFiles(files) {
  return files.map((f) => ({ filename: f.filename, status: f.status, added: f.additions, removed: f.deletions, patch: f.patch, sha: f.sha }));
}

const scenarios = [
  { name: "context_lo", ctx: () => CONTEXT_LO, cfg: () => configLO(), body: "" },
  { name: "context_hi", ctx: () => contextHI(), cfg: () => configHI(), body: "d".repeat(2000) },
];

describe("gate C readiness: replica ≡ production builder (4k cap, 25 frozen reviews)", () => {
  for (const sc of scenarios) {
    it(`byte-exact bundles + identical adjustments under ${sc.name}`, async () => {
      scenarioRows = sc.ctx();
      for (const rev of reviews) {
        const pr = prWithBody(rev.pr_stub, sc.body);
        const repository = { full_name: rev.repo, id: 1 };
        const files = toBuilderFiles(rev.files);
        const real = await buildReviewBundle({ files, pr, repository, config: sc.cfg() });
        const rep = buildBundleReplica({ files, pr, repository, config: sc.cfg(), context: sc.ctx(), cap: 4000 });
        expect(rep.bundle).toBe(real.bundle);
        expect(rep.totalChars).toBe(real.totalChars);
        expect(rep.coverageAdjustments).toEqual(real.coverageAdjustments);
      }
    });
  }

  it("production default behavior regression: >4k patches still truncated at 4k", async () => {
    scenarioRows = CONTEXT_LO;
    const big = { filename: "big.ts", status: "modified", added: 1, removed: 0, patch: "+".repeat(5000), sha: "s" };
    const out = await buildReviewBundle({
      files: [big, { filename: "small.ts", status: "modified", added: 1, removed: 0, patch: "+ok", sha: "s2" }],
      pr: reviews[0].pr_stub, repository: { full_name: "o/r", id: 1 }, config: {},
    });
    expect(out.coverageAdjustments).toEqual([{ path: "big.ts", coverage: "partial", reason: "patch_truncated" }]);
    expect(out.bundle).toContain("+".repeat(4000) + "\n... (truncated)");
  });
});
