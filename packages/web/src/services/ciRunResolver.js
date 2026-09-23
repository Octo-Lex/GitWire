// src/services/ciRunResolver.js
// Canonical trusted resolver for stored CI-run identifiers.
//
// The public CI routes historically expose GitWire's ci_runs.id while GitHub
// operators naturally have a workflow-run id. D0-01 accepts either identifier,
// but the mapping to repository/installation authority must be identical at
// every caller (route handler, authorization observer, future operator tools).

import { db } from "../lib/db.js";

/**
 * Resolve a numeric identifier as either GitWire ci_runs.id or GitHub
 * ci_runs.github_run_id.
 *
 * The result is deliberately explicit rather than throwing for ordinary lookup
 * outcomes so callers can preserve their own HTTP/authorization semantics:
 *   - invalid: identifier is not a decimal representation
 *   - not_found: no stored CI run matches
 *   - ambiguous: internal id and GitHub run id match different stored rows
 *   - resolved: exactly one trusted stored run + repository binding
 */
export async function resolveStoredCIRunIdentifier(value) {
  const identifier = String(value ?? "");
  if (!/^\d+$/.test(identifier)) {
    return { status: "invalid" };
  }

  const { rows } = await db.query(
    `SELECT
       cr.id AS ci_run_id,
       cr.github_run_id,
       r.github_id AS repo_github_id,
       r.owner,
       r.name,
       r.full_name,
       r.installation_id
     FROM ci_runs cr
     JOIN repositories r ON r.github_id = cr.repo_id
     WHERE cr.id::text = $1 OR cr.github_run_id::text = $1
     ORDER BY CASE WHEN cr.id::text = $1 THEN 0 ELSE 1 END
     LIMIT 2`,
    [identifier]
  );

  if (rows.length === 0) {
    return { status: "not_found" };
  }

  // A single row can satisfy both predicates without appearing twice. Any two
  // returned rows therefore mean the external identifier is ambiguous across
  // distinct stored runs; never select one by precedence for authority.
  if (rows.length > 1) {
    return { status: "ambiguous" };
  }

  return { status: "resolved", run: rows[0] };
}
