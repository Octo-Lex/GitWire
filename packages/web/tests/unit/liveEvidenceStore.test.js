// tests/unit/liveEvidenceStore.test.js
// Deterministic proofs for the Phase B runner-evidence lifecycle (client
// correction, 2026-08-18): per-invocation immutable persistence, uniqueness
// with no overwrite, required telemetry capture, and fail-closed behavior.
// No provider call is involved — the store is pure filesystem logic.

import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  RECORD_KIND,
  RECORD_SCHEMA_VERSION,
  assertEvidenceWritable,
  attemptDir,
  invocationFileName,
  writeInvocationRecord,
  persistenceAbortReason,
  resetForTests,
} = await import("../evaluation/review-integrity/liveEvidenceStore.js");

function tmpRunsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "live-evidence-"));
}

function sampleManifest() {
  return {
    schemaVersion: 1,
    coverage: { totalChangedFiles: 3, fullyCoveredFiles: 3, approvalEvidenceComplete: true },
    budgetState: {
      limits: { maxFileReads: 20, maxSearches: 6, maxSearchResults: 10, maxRetrievedChars: 90000, maxContextRounds: 4, maxBlobsScanned: 50, maxSearchBytes: 200000 },
      fileReads: 4, searches: 1, retrievedChars: 21000, contextRounds: 2,
    },
    executionProfiles: {
      primary:   { requestedModel: "glm-5.2", observedModel: "glm-5.2-served", usage: { inputTokens: 9000, outputTokens: 1500, totalTokens: 10500 } },
      verifier:  { requestedModel: "glm-5.2", observedModel: null, usage: null },
      adversarial: { requestedModel: "claude-haiku-4-20250414", observedModel: "glm-4.5-air", usage: { inputTokens: 500, outputTokens: 200, totalTokens: 700 } },
      defense: null,
    },
  };
}

function sampleRecord(run) {
  return {
    fixture: "RI-01", variant: "broken", run,
    v2Mode: "live", timestamp: "2026-08-18T00:00:00.000Z",
    verdict: "needs_discussion", blocked: false, checkState: "action_required",
    findingCount: 1, tokensUsed: 11200, latencyMs: 42000,
    v2VerifierStatus: "not_run", expectedDefectDetected: true,
    falseApprove: false, falsePositive: null,
    requestedModel: "glm-5.2", actualModel: "glm-5.2-served", modelMatch: true,
    invalid: null,
  };
}

function baseParams(runsDir, run, attemptId = "attempt-2026-08-18T00-00-00-000Z") {
  return {
    runsDir,
    attemptId,
    candidateSha: "63f70aa7a2723b0b78956dfb03319b4dbe1c9f89",
    candidateTree: "ed96ae95e0b79684f26fea6232a54d532bf2272c2",
    fixture: "RI-01",
    variant: "broken",
    run,
    record: sampleRecord(run),
    manifest: sampleManifest(),
    verifierReceipt: { status: "not_run", findings: [] },
    decisionReason: "material primary finding",
  };
}

beforeEach(() => {
  resetForTests();
});

describe("live evidence store — per-invocation persistence", () => {
  it("writes one immutable record per completed invocation with required telemetry", () => {
    const runsDir = tmpRunsDir();
    const file = writeInvocationRecord(baseParams(runsDir, 1));

    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));

    expect(onDisk.kind).toBe(RECORD_KIND);
    expect(onDisk.schemaVersion).toBe(RECORD_SCHEMA_VERSION);
    expect(onDisk.attemptId).toBe("attempt-2026-08-18T00-00-00-000Z");
    expect(onDisk.candidate).toEqual({
      sha: "63f70aa7a2723b0b78956dfb03319b4dbe1c9f89",
      tree: "ed96ae95e0b79684f26fea6232a54d532bf2272c2",
    });
    expect(onDisk.fixture).toBe("RI-01");
    expect(onDisk.variant).toBe("broken");
    expect(onDisk.run).toBe(1);
    expect(onDisk.record.verdict).toBe("needs_discussion");
    expect(onDisk.record.expectedDefectDetected).toBe(true);
    expect(onDisk.record.tokensUsed).toBe(11200);
    expect(typeof onDisk.writtenAt).toBe("string");
  });

  it("captures the sanitized execution profiles and retrieval/budget evidence verbatim", () => {
    const runsDir = tmpRunsDir();
    const manifest = sampleManifest();
    const file = writeInvocationRecord({ ...baseParams(runsDir, 2), manifest });

    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(onDisk.manifest).toEqual(manifest);
    expect(onDisk.manifest.executionProfiles.adversarial.observedModel).toBe("glm-4.5-air");
    expect(onDisk.manifest.budgetState.limits.maxRetrievedChars).toBe(90000);
    expect(onDisk.manifest.coverage.approvalEvidenceComplete).toBe(true);
    expect(onDisk.verifierReceipt).toEqual({ status: "not_run", findings: [] });
    expect(onDisk.decisionReason).toBe("material primary finding");
  });

  it("places records under runs/phase-b/<attempt>/ with the scorecard-safe layout", () => {
    const runsDir = tmpRunsDir();
    const file = writeInvocationRecord(baseParams(runsDir, 1));

    const expectedDir = attemptDir(runsDir, "attempt-2026-08-18T00-00-00-000Z");
    expect(path.dirname(file)).toBe(expectedDir);
    expect(path.basename(file)).toBe(
      invocationFileName({ candidateSha: "63f70aa7a2723b0b78956dfb03319b4dbe1c9f89", fixture: "RI-01", variant: "broken", run: 1 })
    );
    // Two levels below runs/ and a distinct kind: the runtime scorecard's
    // scan (phase9-* records, one level deep only) never consumes these.
    expect(path.relative(runsDir, file).split(path.sep).length).toBe(3);
  });
});

describe("live evidence store — uniqueness and no-overwrite", () => {
  it("refuses to overwrite an existing record for the same invocation identity", () => {
    const runsDir = tmpRunsDir();
    writeInvocationRecord(baseParams(runsDir, 1));
    const before = fs.readdirSync(attemptDir(runsDir, "attempt-2026-08-18T00-00-00-000Z"));

    expect(() => writeInvocationRecord(baseParams(runsDir, 1))).toThrow(/fail-closed/);

    const after = fs.readdirSync(attemptDir(runsDir, "attempt-2026-08-18T00-00-00-000Z"));
    expect(after).toEqual(before); // no second file, no rewrite
  });

  it("writes distinct records for distinct run indexes within one attempt", () => {
    const runsDir = tmpRunsDir();
    writeInvocationRecord(baseParams(runsDir, 1));
    writeInvocationRecord(baseParams(runsDir, 2));
    writeInvocationRecord(baseParams(runsDir, 3));

    const files = fs.readdirSync(attemptDir(runsDir, "attempt-2026-08-18T00-00-00-000Z")).sort();
    expect(files).toEqual([
      "63f70aa7a272-RI-01-broken-run1.json",
      "63f70aa7a272-RI-01-broken-run2.json",
      "63f70aa7a272-RI-01-broken-run3.json",
    ]);
  });

  it("keeps attempts separate — a matrix re-run gets its own directory, not a collision", () => {
    const runsDir = tmpRunsDir();
    writeInvocationRecord(baseParams(runsDir, 1, "attempt-first"));
    const file2 = writeInvocationRecord(baseParams(runsDir, 1, "attempt-second"));

    expect(path.dirname(file2)).toBe(attemptDir(runsDir, "attempt-second"));
    expect(persistenceAbortReason()).toBeNull();
  });
});

describe("live evidence store — fail-closed persistence", () => {
  it("poisons the store on write failure and refuses every further invocation", () => {
    const badDir = tmpRunsDir();
    const blocker = path.join(badDir, "not-a-directory");
    fs.writeFileSync(blocker, "file blocks the mkdir path", "utf8");

    // runs/<blocker>/phase-b/<attempt> cannot be created → write fails.
    expect(() =>
      writeInvocationRecord(baseParams(path.join(blocker), 1))
    ).toThrow(/fail-closed/);
    expect(persistenceAbortReason()).toMatch(/not-a-directory/);

    // Further paid invocations are refused before they start…
    expect(() => assertEvidenceWritable()).toThrow(/refusing further paid invocations/);
    // …and even a VALID write is refused while poisoned.
    const goodDir = tmpRunsDir();
    expect(() => writeInvocationRecord(baseParams(goodDir, 1))).toThrow(/refusing further paid invocations/);
    expect(fs.existsSync(attemptDir(goodDir, "attempt-2026-08-18T00-00-00-000Z"))).toBe(false);
  });

  it("resetForTests clears the poison (test isolation only)", () => {
    const blocker = path.join(tmpRunsDir(), "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    expect(() => writeInvocationRecord(baseParams(path.join(blocker), 1))).toThrow(/fail-closed/);

    resetForTests();
    expect(persistenceAbortReason()).toBeNull();
    expect(() => assertEvidenceWritable()).not.toThrow();
  });
});
