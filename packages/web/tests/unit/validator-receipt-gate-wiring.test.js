// Secondary guardrail: confirms the verifier actually CALLS the helper.
// Behavioral coverage is in validator-receipt-gate.test.js; this just locks
// in the cross-file wiring (mirrors pass-capable-unlock.test.js pattern).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");

describe("Gap 1 verifier gate — helper wiring", () => {
  it("imports validateGap1ValidatorBindings", () => {
    expect(repairService).toMatch(/validateGap1ValidatorBindings/);
  });

  it("wraps failures in a Gap 1 error prefix", () => {
    expect(repairService).toMatch(/Gap 1 validator binding check failed/);
  });

  it("check 3f-3j documented in the verifier", () => {
    expect(repairService).toMatch(/3f-3j/);
  });
});
