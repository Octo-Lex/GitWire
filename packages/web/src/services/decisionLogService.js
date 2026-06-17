// src/services/decisionLogService.js
// Records WHY each GitWire worker made its decision.
// Every worker should call logDecision() at the end of its processing,
// even when it decides to skip. This creates the audit trail that shows
// "GitWire evaluated this and chose not to act because…"
//
// Complements:
//   - action_feed (WHAT happened)
//   - audit_trail_entries (COMPLIANCE-grade immutable entries)
//   - decision_log (WHY the decision was made)

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

/**
 * Record a decision made by a GitWire worker.
 *
 * @param {object} params
 * @param {number} params.repoId       - repositories.github_id
 * @param {string} params.source       - worker name
 * @param {string} params.triggerEvent - what triggered this evaluation
 * @param {string} params.targetType   - 'pr' or 'issue'
 * @param {number} params.targetNumber - PR or issue number
 * @param {string} [params.pillar]     - pillar name
 * @param {string} params.decision     - 'acted', 'skipped', 'dry_run', 'blocked', 'error'
 * @param {string} [params.reason]     - human-readable explanation
 * @param {Array}  [params.conditions] - [{check: 'pillar_enabled(ci)', result: true}, ...]
 * @param {object} [params.configUsed] - relevant config snapshot
 * @param {string} [params.commitSha]  - head SHA
 * @param {string} [params.actor]      - default: 'gitwire[bot]'
 * @returns {Promise<object>} inserted row
 */
export async function logDecision({
  repoId, source, triggerEvent,
  targetType, targetNumber,
  pillar, decision, reason,
  conditions, configUsed, commitSha,
  actor,
}) {
  try {
    const { rows: [row] } = await db.query(
      "INSERT INTO decision_log " +
      "  (repo_id, source, trigger_event, target_type, target_number, " +
      "   pillar, decision, reason, conditions, config_used, commit_sha, actor) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) " +
      "RETURNING *",
      [
        repoId, source, triggerEvent,
        targetType, targetNumber,
        pillar ?? null, decision, reason ?? null,
        conditions ? JSON.stringify(conditions) : null,
        configUsed ? JSON.stringify(configUsed) : null,
        commitSha ?? null,
        actor || "gitwire[bot]",
      ]
    );

    logger.debug(
      { decisionId: row.id, source, decision, target: targetType + "#" + targetNumber },
      "Decision logged"
    );

    return row;
  } catch (err) {
    // Decision log failure must never break the calling flow
    logger.error({ err: err.message, source, decision }, "Decision log write failed (non-fatal)");
    return null;
  }
}

/**
 * Get recent decisions, with optional filters.
 *
 * @param {object} [filters]
 * @param {string} [filters.repo]     - filter by repo full_name
 * @param {string} [filters.source]   - filter by source worker
 * @param {string} [filters.targetType] - 'pr' or 'issue'
 * @param {number} [filters.targetNumber] - PR/issue number
 * @param {string} [filters.decision] - 'acted', 'skipped', etc.
 * @param {number} [filters.perPage=20]
 * @param {number} [filters.page=1]
 * @returns {Promise<{data: Array, meta: {total, page, perPage}}>}
 */
export async function getDecisions(filters = {}) {
  const {
    repo, source, targetType, targetNumber, decision,
    pillar, triggerEvent, q, from, to,
    perPage = 20, page = 1,
  } = filters;

  var pIdx = 0;
  var params = [];
  var conditions = [];
  var joins = "";

  // Filter by repo full_name
  if (repo) {
    joins += " JOIN repositories r ON r.github_id = d.repo_id ";
    pIdx++;
    params.push(repo);
    conditions.push("r.full_name = $" + pIdx);
  }

  if (source) {
    pIdx++;
    params.push(source);
    conditions.push("d.source = $" + pIdx);
  }
  if (targetType) {
    pIdx++;
    params.push(targetType);
    conditions.push("d.target_type = $" + pIdx);
  }
  if (targetNumber) {
    pIdx++;
    params.push(targetNumber);
    conditions.push("d.target_number = $" + pIdx);
  }
  if (decision) {
    pIdx++;
    params.push(decision);
    conditions.push("d.decision = $" + pIdx);
  }
  if (pillar) {
    pIdx++;
    params.push(pillar);
    conditions.push("d.pillar = $" + pIdx);
  }
  if (triggerEvent) {
    pIdx++;
    params.push(triggerEvent);
    conditions.push("d.trigger_event = $" + pIdx);
  }
  if (q) {
    pIdx++;
    params.push("%" + q + "%");
    conditions.push("d.reason ILIKE $" + pIdx);
  }
  if (from) {
    pIdx++;
    params.push(from);
    conditions.push("d.created_at >= $" + pIdx);
  }
  if (to) {
    pIdx++;
    params.push(to);
    conditions.push("d.created_at <= $" + pIdx);
  }

  var where = conditions.length > 0 ? " WHERE " + conditions.join(" AND ") : "";

  // Count
  const { rows: [{ count }] } = await db.query(
    "SELECT COUNT(*) AS count FROM decision_log d" + joins + where,
    params
  );
  var total = Number(count);

  // Fetch page
  pIdx++;
  var limitP = "$" + pIdx;
  pIdx++;
  var offsetP = "$" + pIdx;
  params.push(perPage, (page - 1) * perPage);

  const { rows } = await db.query(
    "SELECT d.*" + (repo ? ", r.full_name AS repo" : "") +
    " FROM decision_log d" + joins + where +
    " ORDER BY d.created_at DESC" +
    " LIMIT " + limitP + " OFFSET " + offsetP,
    params
  );

  return {
    data: rows,
    meta: { total, page, perPage, totalPages: Math.ceil(total / perPage) },
  };
}

/**
 * Get decision summary stats.
 *
 * @returns {Promise<Array>} [{source, decision, count}]
 */
export async function getDecisionSummary() {
  const { rows } = await db.query(
    "SELECT source, decision, COUNT(*) AS count, " +
    "  MAX(created_at) AS last_decision " +
    "FROM decision_log " +
    "GROUP BY source, decision " +
    "ORDER BY source, count DESC"
  );
  return rows;
}
