// Source-reading test for /health backend-level reachability wiring
// (v0.23.0 Task 4, step 3-4).
//
// deploymentInfo.js must call getBackendLevelSummary() (the async backend-
// level summary) so /health.executor surfaces selected_backend_id and
// selected_backend_reachable — the rev 3 amendment fields. The sync
// getReachabilitySummary() stays available for callers that don't need
// backend-level proof, but /health specifically must use the async version.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const deploymentInfo = readSource("packages/web/src/lib/deploymentInfo.js");

describe("/health backend-level reachability wiring (v0.23.0 Task 4)", () => {
  it("deploymentInfo calls getBackendLevelSummary (async backend-level)", () => {
    // /health must use the async backend-level summary, not just the sync one,
    // so selected_backend_id + selected_backend_reachable are surfaced.
    expect(deploymentInfo).toMatch(/getBackendLevelSummary/);
  });

  it("deploymentInfo still imports getValidatorReadiness (validator block preserved)", () => {
    // The validator block from Gap 1 must remain — Task 4 adds fields, doesn't
    // remove the validator readiness surface.
    expect(deploymentInfo).toMatch(/getValidatorReadiness/);
  });

  it("deploymentInfo awaits the backend-level summary (it's async)", () => {
    // Must be awaited, not called fire-and-forget — /health needs the result.
    expect(deploymentInfo).toMatch(/await\s+getBackendLevelSummary|=\s*await.*getBackendLevelSummary/);
  });
});
