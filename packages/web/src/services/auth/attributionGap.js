// src/services/auth/attributionGap.js
//
// Runtime attribution gap evidence (Wave 2 / issue #94).
//
// Emits structured authority.attribution_gap events when a writer is called
// without a principalId. Non-recursive: the INSERT cannot trigger another
// gap because it uses its own table, not one of the five monitored writers.
//
// Transaction-safe: when an executor (transaction client) is supplied, the
// gap-evidence INSERT runs inside a SAVEPOINT so a failure does not abort
// the enclosing transaction. Returns a structured result — never silently
// swallows failures.

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

let _savepointCounter = 0;

/**
 * Generate a collision-safe savepoint name.
 */
function nextSavepointName() {
  _savepointCounter += 1;
  return `sp_attribution_gap_${_savepointCounter}`;
}

/**
 * Record an attribution gap event.
 *
 * Returns a structured result:
 *   { recorded: true, evidenceId, code: "recorded" }
 *   { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" }
 *
 * Transaction safety:
 *   When `executor` is provided (a transaction client), the gap-evidence
 *   INSERT runs inside a SAVEPOINT. On failure, the savepoint is rolled
 *   back and released, the transaction remains usable, and the failure
 *   result is returned. The caller can continue with the compatibility write.
 *
 * @param {object} opts
 * @param {string} opts.reasonCode
 * @param {string} opts.surfaceId
 * @param {string} opts.writer
 * @param {string} opts.tableName
 * @param {string} opts.operation
 * @param {string|null} [opts.legacyActor]
 * @param {object} [opts.executor] - pg PoolClient for transaction-safe execution
 * @returns {Promise<{recorded: boolean, evidenceId: string|null, code: string}>}
 */
export async function recordAttributionGap({ reasonCode, surfaceId, writer, tableName, operation, legacyActor = null, executor = null }) {
  if (!surfaceId) {
    logger.warn({ reasonCode, writer }, "recordAttributionGap: missing surfaceId — cannot record gap evidence");
    return { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" };
  }

  const client = executor || db;
  const useSavepoint = !!executor; // only use savepoint inside a transaction

  if (useSavepoint) {
    const sp = nextSavepointName();
    try {
      await client.query(`SAVEPOINT ${sp}`);
      const { rows } = await client.query(
        `INSERT INTO gitwire_auth.attribution_gap_evidence
           (reason_code, surface_id, writer, table_name, operation, principal_id, legacy_actor)
         VALUES ($1, $2, $3, $4, $5, NULL, $6)
         RETURNING id`,
        [reasonCode, surfaceId, writer, tableName, operation, legacyActor]
      );
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return { recorded: true, evidenceId: rows[0]?.id ?? null, code: "recorded" };
    } catch (err) {
      // Rollback to savepoint, release it, return failure.
      // The transaction remains usable for the compatibility write.
      try { await client.query(`ROLLBACK TO SAVEPOINT ${sp}`); } catch {}
      try { await client.query(`RELEASE SAVEPOINT ${sp}`); } catch {}
      logger.warn(
        { reasonCode, surfaceId, writer, tableName, err: err.message },
        "recordAttributionGap: evidence insert failed (savepoint recovered) — returning failure result"
      );
      return { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" };
    }
  }

  // Non-transactional path (pool singleton)
  try {
    const { rows } = await client.query(
      `INSERT INTO gitwire_auth.attribution_gap_evidence
         (reason_code, surface_id, writer, table_name, operation, principal_id, legacy_actor)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)
       RETURNING id`,
      [reasonCode, surfaceId, writer, tableName, operation, legacyActor]
    );
    return { recorded: true, evidenceId: rows[0]?.id ?? null, code: "recorded" };
  } catch (err) {
    logger.warn(
      { reasonCode, surfaceId, writer, tableName, err: err.message },
      "recordAttributionGap: evidence insert failed — returning failure result"
    );
    return { recorded: false, evidenceId: null, code: "attribution_gap_evidence_error" };
  }
}
