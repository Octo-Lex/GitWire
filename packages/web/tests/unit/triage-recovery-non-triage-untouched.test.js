// tests/unit/triage-recovery-non-triage-untouched.test.js
// Regression test (case 12): non-triage checkAndMark() callers remain untouched
// by the triage failure-recovery changes.
//
// Confirms:
//   - ciHealWorker, phase4Worker, and issueFix/context.js still import and call
//     the legacy checkAndMark (not the new lifecycle primitives).
//   - The new lifecycle exports (beginOperation, completeOperation, abandonOperation)
//     are ONLY imported by triageWorker.js.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function readSource(relPath) {
  return fs.readFileSync(path.resolve(ROOT, relPath), "utf-8");
}

describe("Non-triage checkAndMark callers remain untouched (case 12)", () => {
  it("ciHealWorker still uses legacy checkAndMark", () => {
    const src = readSource("packages/web/src/workers/ciHealWorker.js");
    expect(src).toMatch(/checkAndMark/);
    expect(src).not.toMatch(/beginOperation|completeOperation|abandonOperation/);
  });

  it("phase4Worker still uses legacy checkAndMark", () => {
    const src = readSource("packages/web/src/workers/phase4Worker.js");
    expect(src).toMatch(/checkAndMark/);
    expect(src).not.toMatch(/beginOperation|completeOperation|abandonOperation/);
  });

  it("issueFix/context still uses legacy checkAndMark", () => {
    const src = readSource("packages/web/src/workers/issueFix/context.js");
    expect(src).toMatch(/checkAndMark/);
    expect(src).not.toMatch(/beginOperation|completeOperation|abandonOperation/);
  });

  it("only triageWorker imports the new lifecycle primitives", () => {
    const workers = [
      "packages/web/src/workers/ciHealWorker.js",
      "packages/web/src/workers/phase4Worker.js",
      "packages/web/src/workers/issueFix/context.js",
    ];
    for (const w of workers) {
      const src = readSource(w);
      expect(src).not.toMatch(/buildTriageOperationKey/);
      expect(src).not.toMatch(/from.*triageFailureService/);
    }
  });

  it("handleManualRun still clears legacy keys for non-triage pillars", () => {
    const src = readSource("packages/web/src/lib/webhookHandlers/commentCommands/handleManualRun.js");
    // ai_review and issue_fix still use legacy clearIdempotencyKey
    expect(src).toMatch(/clearIdempotencyKey.*ai_review/);
    expect(src).toMatch(/clearIdempotencyKey.*issue_fix/);
    // ci_heal is documented as unsupported (no enqueue, truthful message)
    expect(src).toMatch(/heal-unsupported/);
    // triage uses the new clearTriageOperation
    expect(src).toMatch(/clearTriageOperation/);
  });
});
