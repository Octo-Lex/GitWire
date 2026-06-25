// Source-reading test confirming the recorder uses compileValidationPlan
// instead of raw envelope.required_validation for command-set validation.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readSource(relPath) {
  return readFileSync(join(__dirname, "../../../..", relPath), "utf-8");
}

const repairService = readSource("packages/web/src/services/repairProposalService.js");

describe("Task 9 recorder wiring", () => {
  it("recordVerificationResult uses compileValidationPlan for command-set validation", () => {
    // The old code was:
    //   const requiredCommands = [...envelope.required_validation].sort();
    // The new code must use:
    //   const compiledPlan = compileValidationPlan(envelope.required_validation);
    //   const requiredCommands = compiledPlan.executable_commands;
    expect(repairService).toMatch(/compiledPlan.*executable_commands/);
  });

  it("does NOT use envelope.required_validation directly as requiredCommands", () => {
    // The line that compares raw semantic IDs against executed commands
    // must be gone.
    expect(repairService).not.toMatch(/requiredCommands.*envelope\.required_validation.*sort/);
  });
});
