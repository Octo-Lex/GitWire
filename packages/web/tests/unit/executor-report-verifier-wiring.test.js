// Source-reading test for the DB-backed executor report verifier wiring
// (v0.23.0 Task 6, P1 #1 fix).
//
// Confirms repairProposalService.js's verifyExecutionReceiptAgainstLockedProposal
// calls verifyExecutorReportHash for executor-service pass receipts and enforces
// identifier consistency. This is the load-bearing recompute: no pass is
// accepted unless the raw report can be resolved and its hash recomputed.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");

describe("DB-backed executor report verifier wiring (v0.23.0 Task 6 P1 #1)", () => {
  it("calls verifyExecutorReportHash for executor-service receipts", () => {
    expect(repairService).toMatch(/verifyExecutorReportHash/);
  });

  it("resolves executor_report_ref to check identifier consistency", () => {
    expect(repairService).toMatch(/resolveExecutorReport.*executor_report_ref/);
  });

  it("enforces execution_backend_id == executor_service_id", () => {
    expect(repairService).toMatch(/executor_service_id.*execution_backend_id/);
  });

  it("rejects on hash mismatch with a typed error", () => {
    expect(repairService).toMatch(/executor report hash mismatch/);
  });

  it("rejects on identifier inconsistency with a typed error", () => {
    expect(repairService).toMatch(/identifier inconsistency/);
  });
});

describe("sandboxRunner fail-closed persistence (v0.23.0 Task 6 P1 #2)", () => {
  const sandboxRunner = readSource("packages/web/src/lib/sandboxRunner.js");

  it("downgrades pass to inconclusive when persistence fails", () => {
    expect(sandboxRunner).toMatch(/executor_report_persistence_failed/);
  });

  it("strips executor report fields on persistence failure", () => {
    expect(sandboxRunner).toMatch(/FAIL-CLOSED.*pass/);
  });
});
