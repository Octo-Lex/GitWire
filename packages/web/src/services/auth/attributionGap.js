// src/services/auth/attributionGap.js
//
// Runtime attribution gap evidence (Wave 2 / issue #94).
//
// Emits structured authority.attribution_gap events when a writer is called
// without a principalId. Non-recursive: the INSERT cannot trigger another
// gap because it uses its own table, not one of the five monitored writers.
//
// Transitional safeguard — the final Wave 2 target is 42/42 adopted writers.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * Record an attribution gap event. Best-effort; never throws to the caller.
 *
 * @param {object} opts
 * @param {string} opts.reasonCode   - stable reason code (e.g. 'worker_not_adopted')
 * @param {string} opts.surfaceId    - the protected-surface id
 * @param {string} opts.writer       - the writer function name
 * @param {string} opts.tableName    - the target table
 * @param {string} opts.operation    - the operation (e.g. 'insert', 'update')
 * @param {string|null} opts.legacyActor - the legacy actor metadata
 */
export async function recordAttributionGap({ reasonCode, surfaceId, writer, tableName, operation, legacyActor = null }) {
  try {
    await db.query(
      `INSERT INTO gitwire_auth.attribution_gap_evidence
         (reason_code, surface_id, writer, table_name, operation, principal_id, legacy_actor)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
      [reasonCode, surfaceId, writer, tableName, operation, legacyActor]
    );
  } catch (err) {
    // Best-effort: a gap-evidence failure must NOT crash the caller or
    // recursively trigger another attribution gap.
    logger.warn({ err, reasonCode, surfaceId }, "recordAttributionGap: insert failed (non-fatal)");
  }
}
