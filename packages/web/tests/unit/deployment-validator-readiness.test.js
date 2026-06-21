// Source-reading acceptance test: the /health response must surface
// selected_pass_capable and a validator block so CT 115's
// "healthy but not pass-capable" state is externally observable.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const deploymentInfo = readSource("packages/web/src/lib/deploymentInfo.js");
const reachability = readSource("packages/web/src/lib/executorReachability.js");

describe("/health validator readiness wiring", () => {
  it("deploymentInfo calls getValidatorReadiness", () => {
    expect(deploymentInfo).toMatch(/getValidatorReadiness/);
  });

  it("deploymentInfo returns a top-level validator field", () => {
    // Matches both `validator: foo,` (explicit) and `validator,` (shorthand).
    // The implementation uses shorthand to mirror the existing `executor,` field.
    expect(deploymentInfo).toMatch(/^\s+validator[,:]/m);
  });

  it("executorReachability exports getValidatorReadiness", () => {
    expect(reachability).toMatch(/export function getValidatorReadiness/);
  });

  it("executorReachability exports getReachabilitySummary", () => {
    expect(reachability).toMatch(/export function getReachabilitySummary/);
  });
});
