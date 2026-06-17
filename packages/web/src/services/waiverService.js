// src/services/waiverService.js
// Policy waivers — time-limited exceptions to pillar enforcement.
//
// Waivers allow temporarily bypassing a specific pillar for a repo,
// branch, PR, or issue. They expire automatically or can be revoked manually.
//
// Usage:
//   /gitwire waive ci_healing for release/* until 2026-06-01 reason "release freeze"
//   /gitwire unwaive 42

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Check if a policy is waived for a given context.
 * Returns the active waiver or null.
 *
 * @param {object} params
 * @param {number} params.repoId - repository github_id
 * @param {string} params.pillar - pillar name
 * @param {string} [params.scope] - 'repo', 'branch', 'pr', 'issue'
 * @param {string} [params.scopeValue] - branch name, PR number, etc.
 * @returns {Promise<object|null>} active waiver or null
 */
export async function isWaived({ repoId, pillar, scope, scopeValue }) {
  try {
    // Expire any stale waivers first
    await expireWaivers();

    // Check repo-level waiver (broadest)
    const { rows } = await db.query(
      `SELECT * FROM policy_waivers
       WHERE repo_id = $1
         AND pillar = $2
         AND active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY
         CASE scope
           WHEN 'issue' THEN 1
           WHEN 'pr' THEN 2
           WHEN 'branch' THEN 3
           WHEN 'repo' THEN 4
         END
       LIMIT 1`,
      [repoId, pillar]
    );

    if (rows.length === 0) return null;

    const waiver = rows[0];

    // If waiver is repo-scoped, it matches everything
    if (waiver.scope === "repo") return waiver;

    // For scoped waivers, check that the scope matches
    if (scope && scopeValue) {
      if (waiver.scope === scope) {
        // For branch scope, use glob matching
        if (scope === "branch") {
          // Simple glob: * matches any chars
          const pattern = waiver.scope_value.replace(/\*/g, ".*");
          if (new RegExp("^" + pattern + "$").test(scopeValue)) {
            return waiver;
          }
        } else {
          // For pr/issue scope, exact match
          if (String(waiver.scope_value) === String(scopeValue)) {
            return waiver;
          }
        }
      }
    }

    // Also check if there's a repo-level waiver we missed in the ordering
    const { rows: repoRows } = await db.query(
      `SELECT * FROM policy_waivers
       WHERE repo_id = $1 AND pillar = $2 AND scope = 'repo'
         AND active = TRUE
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1`,
      [repoId, pillar]
    );
    return repoRows[0] || null;
  } catch (err) {
    logger.warn({ err: err.message, repoId, pillar }, "Waiver check failed");
    return null;
  }
}

/**
 * Grant a policy waiver.
 *
 * @param {object} params
 * @param {number} params.repoId
 * @param {string} params.pillar
 * @param {string} params.scope - 'repo', 'branch', 'pr', 'issue'
 * @param {string} [params.scopeValue]
 * @param {string} params.reason
 * @param {string} params.grantedBy - GitHub username
 * @param {string} [params.expiresAt] - ISO date string or null for indefinite
 * @returns {Promise<object>} created waiver
 */
export async function grantWaiver({ repoId, pillar, scope, scopeValue, reason, grantedBy, expiresAt }) {
  const { rows } = await db.query(
    `INSERT INTO policy_waivers (repo_id, pillar, scope, scope_value, reason, granted_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [repoId, pillar, scope, scopeValue || null, reason, grantedBy, expiresAt || null]
  );

  logger.info({
    waiverId: rows[0].id, repoId, pillar, scope, scopeValue,
    grantedBy, expiresAt, reason,
  }, "Policy waiver granted");

  return rows[0];
}

/**
 * Revoke a policy waiver.
 *
 * @param {number} waiverId
 * @param {string} revokedBy - GitHub username
 * @returns {Promise<object|null>}
 */
export async function revokeWaiver(waiverId, revokedBy) {
  const { rows } = await db.query(
    `UPDATE policy_waivers
     SET active = FALSE, revoked_at = NOW()
     WHERE id = $1 AND active = TRUE
     RETURNING *`,
    [waiverId]
  );

  if (rows[0]) {
    logger.info({ waiverId, revokedBy }, "Policy waiver revoked");
  }

  return rows[0] || null;
}

/**
 * Expire waivers past their expires_at timestamp.
 * Called automatically by isWaived() and periodically.
 *
 * @returns {Promise<number>} number of expired waivers
 */
export async function expireWaivers() {
  const { rowCount } = await db.query(
    `UPDATE policy_waivers
     SET active = FALSE, revoked_at = NOW()
     WHERE active = TRUE
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`
  );

  if (rowCount > 0) {
    logger.info({ count: rowCount }, "Policy waivers expired");
  }

  return rowCount;
}

/**
 * List waivers for a repo.
 *
 * @param {object} params
 * @param {number} params.repoId
 * @param {string} [params.pillar]
 * @param {boolean} [params.activeOnly]
 * @returns {Promise<object[]>}
 */
export async function listWaivers({ repoId, pillar, activeOnly = true }) {
  let query = `SELECT * FROM policy_waivers WHERE repo_id = $1`;
  const params = [repoId];

  if (pillar) {
    params.push(pillar);
    query += " AND pillar = $" + params.length;
  }

  if (activeOnly) {
    query += " AND active = TRUE AND (expires_at IS NULL OR expires_at > NOW())";
  }

  query += " ORDER BY created_at DESC";

  const { rows } = await db.query(query, params);
  return rows;
}

/**
 * List ALL waivers across all repos, with global filters.
 * Used by the dashboard's global waiver visibility view.
 *
 * @param {object} [filters]
 * @param {string} [filters.repo]       - filter by repo full_name
 * @param {string} [filters.pillar]     - filter by pillar
 * @param {string} [filters.scope]      - 'repo', 'branch', 'pr', 'issue'
 * @param {string} [filters.status]     - 'active', 'expired', 'expiring'
 * @param {string} [filters.grantedBy]  - filter by grantor username
 * @param {string} [filters.q]          - free-text ILIKE search on reason
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @returns {Promise<{data: Array, meta: {total, limit, offset}}>} includes repo full_name
 */
export async function listAllWaivers(filters = {}) {
  const {
    repo, pillar, scope, status, grantedBy, q,
    limit = 50, offset = 0,
  } = filters;

  var pIdx = 0;
  var params = [];
  var conditions = [];

  // Join with repositories to get full_name
  var joins = " JOIN repositories r ON r.github_id = w.repo_id ";

  if (repo) {
    pIdx++;
    params.push(repo);
    conditions.push("r.full_name = $" + pIdx);
  }
  if (pillar) {
    pIdx++;
    params.push(pillar);
    conditions.push("w.pillar = $" + pIdx);
  }
  if (scope) {
    pIdx++;
    params.push(scope);
    conditions.push("w.scope = $" + pIdx);
  }
  if (grantedBy) {
    pIdx++;
    params.push(grantedBy);
    conditions.push("w.granted_by = $" + pIdx);
  }
  if (q) {
    pIdx++;
    params.push("%" + q + "%");
    conditions.push("w.reason ILIKE $" + pIdx);
  }

  // Status filter
  if (status === "active") {
    conditions.push("w.active = TRUE AND (w.expires_at IS NULL OR w.expires_at > NOW())");
  } else if (status === "expired") {
    conditions.push("(w.active = FALSE OR w.expires_at <= NOW())");
  } else if (status === "expiring") {
    conditions.push(
      "w.active = TRUE AND w.expires_at > NOW() AND w.expires_at <= NOW() + INTERVAL '7 days'"
    );
  }

  var where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

  // Count
  const { rows: [{ count }] } = await db.query(
    "SELECT COUNT(*) AS count FROM policy_waivers w" + joins + where,
    params
  );
  var total = Number(count);

  // Fetch page
  pIdx++;
  params.push(limit);
  pIdx++;
  params.push(offset);

  const { rows } = await db.query(
    "SELECT w.*, r.full_name AS repo_full_name" +
    " FROM policy_waivers w" + joins + where +
    " ORDER BY w.created_at DESC" +
    " LIMIT $" + (pIdx - 1) + " OFFSET $" + pIdx,
    params
  );

  return {
    data: rows,
    meta: { total, limit, offset },
  };
}
