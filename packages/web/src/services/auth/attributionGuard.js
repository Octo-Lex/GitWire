// src/services/auth/attributionGuard.js
//
// Centralized attribution guard for the five Wave 2 writer APIs (issue #94).
//
// Each writer invocation must carry an attribution envelope:
//   { principalId, surfaceId, reasonCode, legacyActor }
//
// When principalId is present: the write proceeds with authoritative attribution.
// When principalId is absent: exactly one attribution-gap event is recorded,
//   and the write proceeds only where observe-only behavior permits.
//
// This guard is the canonical boundary — callers do NOT need to manually call
// recordAttributionGap(). The guard catches gaps automatically.

import { recordAttributionGap } from "./attributionGap.js";

/**
 * Validate attribution metadata before a writer call. If principalId is null,
 * record exactly one attribution-gap event and return the result.
 *
 * @param {object} envelope
 * @param {string|null} envelope.principalId - the resolved principal UUID
 * @param {string} envelope.surfaceId - the protected-surface id
 * @param {string} envelope.writer - the writer function name
 * @param {string} envelope.tableName - the target table
 * @param {string} envelope.operation - 'insert' | 'update' | 'delete'
 * @param {string|null} [envelope.legacyActor] - the legacy actor metadata
 * @param {string} [envelope.reasonCode] - stable gap reason (null when attributed)
 * @returns {Promise<{attributed: boolean, gapResult?: object}>}
 */
export async function validateAttribution(envelope) {
  const { principalId, surfaceId, writer, tableName, operation, legacyActor, reasonCode, executor } = envelope;

  if (principalId) {
    // Authoritative attribution — no gap event.
    return { attributed: true };
  }

  // Missing principalId — record exactly one attribution-gap event.
  // If executor is provided (transaction client), the gap INSERT runs inside
  // a SAVEPOINT so a failure doesn't abort the enclosing transaction.
  const gapResult = await recordAttributionGap({
    reasonCode: reasonCode || "missing_principal_context",
    surfaceId: surfaceId || "unknown_surface",
    writer,
    tableName,
    operation,
    legacyActor: legacyActor ?? null,
    executor: executor || null,
  });

  return { attributed: false, gapResult };
}

/**
 * Build an attribution envelope from an HTTP request context.
 * @param {object} req - Express request with req.auth
 * @param {string} surfaceId
 * @param {string} writer
 * @param {string} tableName
 * @param {string} operation
 * @param {string|null} legacyActor
 * @returns {object} attribution envelope
 */
export function httpAttribution(req, surfaceId, writer, tableName, operation, legacyActor = null) {
  return {
    principalId: req?.auth?.principalId ?? null,
    surfaceId,
    writer,
    tableName,
    operation,
    legacyActor,
    reasonCode: req?.auth?.principalId ? null : "http_context_missing_principal",
  };
}

/**
 * Build an attribution envelope from a worker auth context.
 * @param {object|null} context - worker auth context from adoptWorker
 * @param {string} surfaceId
 * @param {string} writer
 * @param {string} tableName
 * @param {string} operation
 * @param {string|null} legacyActor
 * @returns {object} attribution envelope
 */
export function workerAttribution(context, surfaceId, writer, tableName, operation, legacyActor = null) {
  return {
    principalId: context?.principalId ?? null,
    surfaceId,
    writer,
    tableName,
    operation,
    legacyActor,
    reasonCode: context?.principalId ? null : "worker_context_missing_principal",
  };
}

/**
 * Build an attribution envelope from a system/bootstrap context.
 * @param {string|null} principalId
 * @param {string} surfaceId
 * @param {string} writer
 * @param {string} tableName
 * @param {string} operation
 * @param {string|null} legacyActor
 * @returns {object} attribution envelope
 */
export function systemAttribution(principalId, surfaceId, writer, tableName, operation, legacyActor = null) {
  return {
    principalId: principalId ?? null,
    surfaceId,
    writer,
    tableName,
    operation,
    legacyActor,
    reasonCode: principalId ? null : "system_context_missing_principal",
  };
}
