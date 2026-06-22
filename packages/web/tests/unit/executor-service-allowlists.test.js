// Source-reading tests for the executor-service allowlist additions
// (v0.23.0 Task 3, step 8).
//
// The verifier gate's three allowlists must include executor-service so
// receipts produced via the executor-service backend can pass the gate once
// Task 5+6 land. Task 3 only ADDS the entries; the gate is not yet exercised
// end-to-end (the run() placeholder returns inconclusive, so no pass receipt
// reaches the gate yet). But the allowlist entries must exist now so the
// backend is at least recognized as a legitimate execution backend.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");

describe("executor-service allowlist wiring (v0.23.0 Task 3)", () => {
  it("ALLOWED_EXECUTION_BACKENDS includes executor-service", () => {
    // executor-service must be a recognized execution backend so receipts
    // from it aren't rejected at check 3 ("execution_backend_id must be
    // allowlisted") before any other check runs.
    expect(repairService).toMatch(/ALLOWED_EXECUTION_BACKENDS[\s\S]*"executor-service"/);
  });

  it("ALLOWED_PASS_EXECUTION_BACKENDS includes executor-service", () => {
    // Pass-capable backend by design (rev 3 design doc). Without this entry,
    // a pass receipt from executor-service would be rejected at check 3a
    // ("not authorized to produce passing results").
    expect(repairService).toMatch(/ALLOWED_PASS_EXECUTION_BACKENDS[\s\S]*"executor-service"/);
  });

  it("ALLOWED_EXECUTOR_VERSIONS includes 1.0.0 (the backend's version)", () => {
    // executorServiceBackend.version === "1.0.0". The version allowlist must
    // accept it or receipts are rejected at check 4 ("executor_version not
    // allowlisted").
    expect(repairService).toMatch(/ALLOWED_EXECUTOR_VERSIONS[\s\S]*"1\.0\.0"/);
  });
});
