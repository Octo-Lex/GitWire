// src/services/auth/decisionLog.js
//
// Observe-only decision log (Wave 2 / issue #94).
//
// Records every authorization decision computed by authorize() into the
// append-only gitwire_auth.auth_decision_log table. Used in observe-only
// mode to compare authoritative decisions against legacy behavior and to
// surface disagreements (a future enforcement gate consumes the evidence).
//
// Insertion is best-effort: a logging failure MUST NOT change the
// authorization decision (it is recorded but does not throw to the caller).
// The table's append-only triggers reject UPDATE/DELETE (Wave 1 / 041).

import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * Record a decision to auth_decision_log. Best-effort; never throws.
 * @param {object} decision - AuthorizationDecision
 * @param {object} [principal] - AuthContext
 * @param {object} [observeOpts] - { legacyExpected, disagreement }
 */
export async function logDecision(decision, principal, observeOpts = {}) {
  try {
    await db.query(
      `INSERT INTO gitwire_auth.auth_decision_log
         (principal_id, permission, resource_type,
          resource_installation_id, resource_repository_id,
          resource_organization, resource_repository,
          allowed, code, matched_assignment_id, matched_scope_type,
          policy_version, authentication_method,
          observe_mode, legacy_expected, disagreement, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        decision.principalId ?? null,
        decision.permission,
        decision.resource?.type ?? "unknown",
        decision.resource?.installationId ?? null,
        decision.resource?.repositoryId ?? null,
        decision.resource?.organization ?? null,
        decision.resource?.repository ?? null,
        decision.allowed,
        decision.code,
        decision.matchedAssignmentId ?? null,
        decision.matchedScopeType ?? null,
        decision.policyVersion ?? "level1",
        decision.authenticationMethod ?? null,
        true, // observe_mode — Wave 2 never enforces globally
        observeOpts.legacyExpected ?? null,
        observeOpts.disagreement ?? null,
        decision.detail ? JSON.stringify(decision.detail) : null,
      ]
    );
  } catch (err) {
    // Best-effort: a logging failure must not change the authorization outcome.
    logger.warn({ err, code: decision.code }, "decisionLog: insert failed (non-fatal)");
  }
}

/**
 * Count recent disagreements in observe-only mode (for health/metrics).
 * @returns {Promise<number>}
 */
export async function countRecentDisagreements() {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM gitwire_auth.auth_decision_log
        WHERE disagreement = true
          AND decided_at > now() - interval '24 hours'`
    );
    return rows[0]?.n ?? 0;
  } catch (err) {
    logger.warn({ err }, "decisionLog: disagreement count failed");
    return 0;
  }
}
