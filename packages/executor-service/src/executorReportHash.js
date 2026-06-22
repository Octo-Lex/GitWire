// packages/executor-service/src/executorReportHash.js
// Content-addressed hash for executor reports (v0.23.0 Task 5, step 1-2).
//
// Mirrors GitWire's execution-receipt pattern: the hash is computed over the
// canonical JSON of the report object MINUS the hash/ref fields themselves
// (so the report can self-reference its own hash without changing it).
//
// PURE — no I/O, no side effects. Deterministic for a given report content.

import { createHash } from "node:crypto";

// Fields excluded from the hash input: they're either derived from the hash
// (executor_report_hash, executor_report_ref) or would create a circular
// dependency. Adding them back to the report after hashing must not change
// the hash.
const EXCLUDED_FROM_HASH = new Set(["executor_report_hash", "executor_report_ref"]);

/**
 * Compute the content-addressed hash for an executor report.
 *
 * The hash covers a canonical JSON serialization of the report object with
 * the executor_report_hash and executor_report_ref fields removed. This lets
 * the report self-reference its own hash (Task 6 will store the raw report
 * and the verifier will recompute the hash from it).
 *
 * @param {object} report - the executor report object
 * @returns {string} "sha256:<64 hex chars>"
 */
export function computeExecutorReportHash(report) {
  // Deep-clone isn't needed; we build a fresh object excluding the hash fields.
  // Object key insertion order in V8 follows creation order for string keys,
  // so the canonical JSON is stable for structurally-identical inputs.
  const input = {};
  for (const key of Object.keys(report)) {
    if (!EXCLUDED_FROM_HASH.has(key)) {
      input[key] = report[key];
    }
  }
  const canonical = JSON.stringify(input);
  return "sha256:" + createHash("sha256").update(canonical).digest("hex");
}

/**
 * Build the content-addressed ref from a hash.
 * @param {string} hash - "sha256:..."
 * @returns {string} "executor-report:sha256:..."
 */
export function buildExecutorReportRef(hash) {
  return `executor-report:${hash}`;
}
