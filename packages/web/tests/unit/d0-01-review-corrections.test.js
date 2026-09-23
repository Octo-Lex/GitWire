// D0-01 — pin the two maintainer/Codex review corrections that guard the
// manual-heal admission boundary and the repository-owned CI-heal proof.

import { readFileSync } from "node:fs";
import { describe, it, expect } from "@jest/globals";

const ciRunsSource = readFileSync(
  new URL("../../src/routes/ciRuns.js", import.meta.url),
  "utf8",
);
const regressionProofSource = readFileSync(
  new URL("../../db/proof/run_ciheal_regression_proof.mjs", import.meta.url),
  "utf8",
);

describe("D0-01 review corrections", () => {
  it("bypasses the shared GitHub GET cache for manual-heal eligibility refresh", () => {
    const healRouteStart = ciRunsSource.indexOf('ciRouter.post("/:runId/heal"');
    expect(healRouteStart).toBeGreaterThan(-1);

    const healRouteSource = ciRunsSource.slice(healRouteStart);
    expect(healRouteSource).toMatch(
      /wrapOctokit\(\s*await getInstallationClient\(stored\.installation_id\),\s*\{\s*skipCache:\s*true\s*\},?\s*\)/s,
    );
  });

  it("keeps the CI-heal regression proof on the canonical job producer contract", () => {
    expect(regressionProofSource).toContain("buildCIHealJobFromWebhook");
    expect(regressionProofSource).toContain("enqueueCIHealJob(ciHealQueue, healJob)");
    expect(regressionProofSource).toContain('action: "completed"');
    expect(regressionProofSource).toContain('status: "completed"');
    expect(regressionProofSource).not.toContain('ciHealQueue.add("heal-run", { payload })');
  });
});
