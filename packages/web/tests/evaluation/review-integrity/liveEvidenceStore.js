// tests/evaluation/review-integrity/liveEvidenceStore.js
// Per-invocation immutable evidence records for the Phase B live matrix.
//
// Contract (frozen by the client's 2026-08-18 runner-evidence correction):
//   1. Every COMPLETED invocation immediately writes its own immutable JSON
//      record under runs/phase-b/<attemptId>/ — one file per invocation,
//      created with the "wx" flag so an existing record can never be
//      overwritten or silently reused.
//   2. A persistence failure poisons the store: every subsequent invocation
//      refuses to START (fail-closed) until the process is restarted, so a
//      broken evidence path can never precede another paid provider call.
//   3. Records live two directory levels below runs/, and carry a distinct
//      `kind`, so the runtime scorecard's scan (which reads only phase9-*
//      records directly inside runs/ subdirectories) never consumes them.
//
// No provider, model, prompt, corpus, or criteria logic lives here.

import fs from "node:fs";
import path from "node:path";

export const RECORD_KIND = "phase-b-invocation";
export const RECORD_SCHEMA_VERSION = 1;

let abortReason = null;

/** The first persistence failure's reason, or null while writable. */
export function persistenceAbortReason() {
  return abortReason;
}

/**
 * Throws (refusing a further paid invocation) once any earlier persistence
 * failure has poisoned the store. Call BEFORE every provider invocation.
 */
export function assertEvidenceWritable() {
  if (abortReason !== null) {
    throw new Error(
      "live-evidence persistence previously failed — refusing further paid invocations: "
      + abortReason
    );
  }
}

/** Directory for one matrix attempt: <runsDir>/phase-b/<attemptId>. */
export function attemptDir(runsDir, attemptId) {
  return path.join(runsDir, "phase-b", attemptId);
}

/** Deterministic unique file name per invocation identity. */
export function invocationFileName({ candidateSha, fixture, variant, run }) {
  const sha12 = String(candidateSha || "").replace(/[^0-9a-f]/gi, "").slice(0, 12) || "unknown-sha";
  return `${sha12}-${fixture}-${variant}-run${run}.json`;
}

/**
 * Write one invocation's immutable record. Throws (and poisons the store)
 * on ANY failure, including a collision with an existing record — a
 * collision means the identity is not unique and must be investigated,
 * not overwritten.
 *
 * @param {object} params
 * @param {string} params.runsDir - the evaluation runs directory
 * @param {string} params.attemptId - matrix-attempt identity (distinct per run of the suite)
 * @param {string} params.candidateSha - exact candidate commit SHA
 * @param {string} params.candidateTree - exact candidate tree OID
 * @param {string} params.fixture - fixture case id (e.g. "RI-01")
 * @param {string} params.variant - "broken" | "fixed"
 * @param {number} params.run - 1-based run index within the fixture
 * @param {object} params.record - the live-suite run record (verdict/quality fields)
 * @param {object|null} params.manifest - v2Capture.manifest (execution profiles, coverage, budgets)
 * @param {object|null} params.verifierReceipt - v2Capture.verifierReceipt
 * @param {string|null} params.decisionReason - v2Capture.decisionReason
 * @returns {string} the absolute record path
 */
export function writeInvocationRecord({
  runsDir, attemptId, candidateSha, candidateTree,
  fixture, variant, run, record,
  manifest = null, verifierReceipt = null, decisionReason = null,
}) {
  assertEvidenceWritable();
  const dir = attemptDir(runsDir, attemptId);
  const file = path.join(dir, invocationFileName({ candidateSha, fixture, variant, run }));
  const payload = {
    kind: RECORD_KIND,
    schemaVersion: RECORD_SCHEMA_VERSION,
    attemptId,
    candidate: { sha: candidateSha, tree: candidateTree },
    fixture, variant, run,
    record,
    manifest,
    verifierReceipt,
    decisionReason,
    writtenAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    abortReason = `${file}: ${err.message}`;
    throw new Error(`live-evidence persistence failed (fail-closed): ${abortReason}`);
  }
  return file;
}

/** Test-only: clear the poison so unit tests can exercise both states. */
export function resetForTests() {
  abortReason = null;
}
