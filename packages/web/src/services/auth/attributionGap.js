// src/services/auth/attributionGap.js
//
// Runtime attribution gap evidence (Wave 2 / issue #94).
//
// Emits structured authority.attribution_gap events when a writer is called
// without a principalId. Non-recursive: the INSERT cannot trigger another
// gap because it uses its own table, not one of the five monitored writers.
//
// Returns a structured result — never silently swallows failures.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * Record an attribution gap event.
 *
 * Returns a structured result:
 *   { recorded: true, evidenceId, code: "recorded" }
 *   { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" }
 *
 * On failure:
 * - does NOT throw into the legacy execution path
 * - emits one secret-safe structured fallback log
 * - returns the failure result
 * - never recursively calls recordAttributionGap()
 *
 * @param {object} opts
 * @param {string} opts.reasonCode   - stable reason code (e.g. 'worker_not_adopted')
 * @param {string} opts.surfaceId    - the protected-surface id
 * @param {string} opts.writer       - the writer function name
 * @param {string} opts.tableName    - the target table
 * @param {string} opts.operation    - the operation (e.g. 'insert', 'update')
 * @param {string|null} opts.legacyActor - the legacy actor metadata
 * @returns {Promise<{recorded: boolean, evidenceId: string|null, code: string}>}
 */
export async function recordAttributionGap({ reasonCode, surfaceId, writer, tableName, operation, legacyActor = null }) {
  if (!surfaceId) {
    logger.warn({ reasonCode, writer }, "recordAttributionGap: missing surfaceId — cannot record gap evidence");
    return { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" };
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO gitwire_auth.attribution_gap_evidence
         (reason_code, surface_id, writer, table_name, operation, principal_id, legacy_actor)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)
       RETURNING id`,
      [reasonCode, surfaceId, writer, tableName, operation, legacyActor]
    );
    return { recorded: true, evidenceId: rows[0]?.id ?? null, code: "recorded" };
  } catch (err) {
    // Secret-safe fallback log — no request bodies, payloads, credentials, secrets.
    logger.warn(
      { reasonCode, surfaceId, writer, tableName, err: err.message },
      "recordAttributionGap: evidence insert failed — returning failure result"
    );
    return { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" };
  }
}
