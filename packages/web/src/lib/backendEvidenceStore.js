// src/lib/backendEvidenceStore.js
// Durable backend evidence store for executor isolation verification.
//
// Persists isolation probe evidence keyed by backend identity. This record
// is the prerequisite for pass authorization — a backend can become
// pass-capable only when valid evidence exists AND all required probes pass.
//
// Evidence is content-addressed by probe_suite_hash and bound to:
//   execution_backend_id, executor_version, image_ref, image_digest,
//   container_runtime, runtime_version, probe_suite_hash
//
// Write-once: INSERT ON CONFLICT DO NOTHING. Never deleted.
//
// The governance gate checks this store before accepting any pass receipt
// from a backend — even if the backend is in ALLOWED_PASS_EXECUTION_BACKENDS,
// the evidence record must exist and all probes must have passed.

import crypto from "crypto";
import { db } from "./db.js";
import { logger } from "./logger.js";
import {
  validateProbeCompleteness,
  validateProbeResults,
  computeProbeSuiteHash,
} from "./isolationProbes.js";
import { validateDigestPinned, extractDigest } from "./imageReference.js";

/**
 * Store backend isolation evidence durably.
 *
 * Validates that all required probes are present and passed before storing.
 * Uses INSERT ON CONFLICT DO NOTHING for idempotency.
 *
 * @param {object} params
 * @param {string} params.execution_backend_id - e.g., "docker-executor"
 * @param {string} params.executor_version - e.g., "1.0.0"
 * @param {string} params.image_ref - full immutable reference "repo@sha256:..."
 * @param {string} params.image_digest - "sha256:<hex64>"
 * @param {string} params.container_runtime - "docker" or "podman"
 * @param {string} params.runtime_version - runtime version string
 * @param {Array<object>} params.probe_results - array of probe result objects
 * @param {object} params.inspection_result - runtime image inspection evidence
 * @returns {Promise<{ probe_suite_hash: string, evidence_id: string }>}
 * @throws {Error} if probes incomplete, any probe failed, image ref not digest-pinned,
 *                image_ref/image_digest mismatch, or inspection fails
 */
export async function storeBackendEvidence(params) {
  const {
    execution_backend_id,
    executor_version,
    image_ref,
    image_digest,
    container_runtime,
    runtime_version,
    probe_results,
    inspection_result,
  } = params;

  // Validate image reference is digest-pinned
  validateDigestPinned(image_ref);
  validateDigestPinned(image_digest);

  // P1 fix: image_ref digest must match image_digest
  const refDigest = extractDigest(image_ref);
  if (refDigest !== image_digest) {
    throw new Error(
      `Backend evidence image_ref digest '${refDigest}' does not match image_digest '${image_digest}'`
    );
  }

  // P0 fix: runtime image inspection must be present and verify identity.
  // Do not trust only the configured string — the runtime must confirm
  // it resolved the exact pinned image.
  if (!inspection_result) {
    throw new Error(
      "Backend evidence requires runtime image inspection_result — cannot trust configuration string alone"
    );
  }
  const { verifyImageIdentity } = await import("./imageInspector.js");
  verifyImageIdentity(inspection_result, image_digest);

  // Validate probe completeness — all required probes present
  const completeness = validateProbeCompleteness(probe_results);
  if (!completeness.valid) {
    throw new Error(
      `Backend evidence incomplete: missing probes: ${completeness.missing.join(", ")}`
    );
  }

  // Validate all probes passed
  const results = validateProbeResults(probe_results);
  if (!results.valid) {
    throw new Error(
      `Backend evidence has failing probes: ${results.failures.join("; ")}`
    );
  }

  // Compute content-addressed probe suite hash
  const probeSuiteHash = computeProbeSuiteHash(probe_results);

  // Compute a composite evidence ID
  const evidenceId = "sha256:" + crypto.createHash("sha256")
    .update(`${execution_backend_id}:${executor_version}:${image_digest}:${probeSuiteHash}`)
    .digest("hex");

  await db.query(
    `INSERT INTO backend_isolation_evidence
       (evidence_id, execution_backend_id, executor_version, image_ref,
        image_digest, container_runtime, runtime_version,
        probe_suite_hash, probe_results, all_probes_passed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (evidence_id) DO NOTHING`,
    [
      evidenceId,
      execution_backend_id,
      executor_version,
      image_ref,
      image_digest,
      container_runtime,
      runtime_version,
      probeSuiteHash,
      JSON.stringify(probe_results),
      true,
    ]
  );

  logger.info(
    { execution_backend_id, image_digest, probe_suite_hash: probeSuiteHash, evidence_id: evidenceId },
    "Backend isolation evidence stored"
  );

  return { probe_suite_hash: probeSuiteHash, evidence_id: evidenceId };
}

/**
 * Resolve backend isolation evidence by backend identity.
 *
 * @param {string} execution_backend_id
 * @param {string} image_digest
 * @returns {Promise<object|null>}
 */
export async function resolveBackendEvidence(execution_backend_id, image_digest) {
  const { rows } = await db.query(
    `SELECT evidence_id, execution_backend_id, executor_version, image_ref,
            image_digest, container_runtime, runtime_version,
            probe_suite_hash, probe_results, all_probes_passed, created_at
     FROM backend_isolation_evidence
     WHERE execution_backend_id = $1 AND image_digest = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [execution_backend_id, image_digest]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  return {
    ...row,
    probe_results: typeof row.probe_results === "string"
      ? JSON.parse(row.probe_results)
      : row.probe_results,
  };
}

/**
 * Verify that valid backend isolation evidence exists for a given
 * backend ID and image digest, AND that all probes passed.
 *
 * Used by the governance gate as a precondition for accepting pass receipts.
 *
 * @param {string} execution_backend_id
 * @param {string} image_digest
 * @returns {Promise<object>} the evidence record
 * @throws {Error} if no evidence exists or probes failed
 */
export async function verifyBackendEvidence(execution_backend_id, image_digest) {
  const evidence = await resolveBackendEvidence(execution_backend_id, image_digest);

  if (!evidence) {
    throw new Error(
      `No isolation evidence for backend '${execution_backend_id}' with image digest '${image_digest}'`
    );
  }

  if (!evidence.all_probes_passed) {
    throw new Error(
      `Isolation evidence for '${execution_backend_id}' has failing probes — cannot authorize pass`
    );
  }

  // Re-validate probe completeness from stored data
  const completeness = validateProbeCompleteness(evidence.probe_results);
  if (!completeness.valid) {
    throw new Error(
      `Stored isolation evidence is incomplete: missing ${completeness.missing.join(", ")}`
    );
  }

  // Re-validate all probes passed
  const results = validateProbeResults(evidence.probe_results);
  if (!results.valid) {
    throw new Error(
      `Stored isolation evidence has failing probes: ${results.failures.join("; ")}`
    );
  }

  // P1 fix: verify stored image_ref digest matches stored image_digest
  const refDigest = extractDigest(evidence.image_ref);
  if (refDigest !== evidence.image_digest) {
    throw new Error(
      `Stored isolation evidence image_ref digest '${refDigest}' does not match stored image_digest '${evidence.image_digest}'`
    );
  }

  return evidence;
}

/**
 * Check if backend isolation evidence exists (without throwing).
 *
 * @param {string} execution_backend_id
 * @param {string} image_digest
 * @returns {Promise<boolean>}
 */
export async function hasBackendEvidence(execution_backend_id, image_digest) {
  try {
    await verifyBackendEvidence(execution_backend_id, image_digest);
    return true;
  } catch (_e) {
    return false;
  }
}
