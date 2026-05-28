// src/services/managedActionService.js
// Tracks every GitHub mutation GitWire makes (labels, comments, reviewers, etc.)
// so they can be reconciled when conditions change or the PR is closed.
//
// Lifecycle:
//   1. Worker performs a GitHub action (add label, post comment, etc.)
//   2. Worker calls recordAction() to persist the mutation
//   3. On PR synchronize/close, reconciliation removes stale actions
//
// Action key convention:
//   - Labels:     label:{label_name}
//   - Comments:   comment:{source}:{purpose}
//   - Reviewers:  reviewer:{login}
//   - Approvals:  approval:{source}
//   - Branches:   branch:{branch_name}

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";

// ════════════════════════════════════════════════════════════════════════════
// Record a managed action
// ════════════════════════════════════════════════════════════════════════════

/**
 * Record that GitWire performed a GitHub mutation.
 * Call this AFTER the GitHub API call succeeds.
 *
 * @param {object} params
 * @param {number} params.repoId        - repositories.github_id
 * @param {string} params.source        - worker name: 'ci_heal', 'triage', etc.
 * @param {number} [params.sourceId]    - FK to source table (heal_prs.id, etc.)
 * @param {number} [params.prNumber]    - PR number (null for issue-level)
 * @param {number} [params.issueNumber] - Issue number
 * @param {string} params.actionType    - 'label', 'comment', 'reviewer', 'approval', 'branch_ref'
 * @param {string} params.actionKey     - unique key for reconciliation (e.g. 'label:gitwire-healed')
 * @param {string} [params.actionValue] - the label name, comment body hash, reviewer login
 * @param {number} [params.githubId]    - GitHub's resource ID
 * @param {object} [params.context]     - triggering context object (will be hashed)
 * @returns {Promise<object>} inserted row
 */
export async function recordAction({
  repoId, source, sourceId,
  prNumber, issueNumber,
  actionType, actionKey, actionValue,
  githubId, context,
}) {
  logger.warn(
    { source, actionType, actionKey, repoId, prNumber },
    "DEPRECATED: recordAction() called — migrate to actionStateMachine.propose()"
  );
  const contextHash = context ? hashContext(context) : null;

  // Deactivate any previous active action with the same key for dedup
  await db.query(
    "UPDATE managed_actions SET active = FALSE, deactivated_at = NOW() " +
    "WHERE repo_id = $1 AND action_key = $2 AND active = TRUE " +
    "  AND (pr_number = $3 OR (pr_number IS NULL AND $3 IS NULL))",
    [repoId, actionKey, prNumber ?? null]
  );

  const { rows: [row] } = await db.query(
    "INSERT INTO managed_actions " +
    "  (repo_id, source, source_id, pr_number, issue_number, " +
    "   action_type, action_key, action_value, github_id, context_hash) " +
    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
    "RETURNING *",
    [
      repoId, source, sourceId ?? null,
      prNumber ?? null, issueNumber ?? null,
      actionType, actionKey, actionValue ?? null,
      githubId ?? null, contextHash,
    ]
  );

  logger.debug(
    { actionId: row.id, source, actionType, actionKey, repoId, prNumber },
    "Managed action recorded"
  );

  return row;
}

// ════════════════════════════════════════════════════════════════════════════
// Deactivate a single action (and optionally remove from GitHub)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Mark a managed action as inactive.
 * Does NOT remove from GitHub — caller is responsible for that.
 *
 * @param {number} actionId - managed_actions.id
 */
export async function deactivateAction(actionId) {
  const { rowCount } = await db.query(
    "UPDATE managed_actions SET active = FALSE, deactivated_at = NOW() " +
    "WHERE id = $1 AND active = TRUE",
    [actionId]
  );

  if (rowCount > 0) {
    logger.debug({ actionId }, "Managed action deactivated");
  }

  return rowCount > 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Get active actions for reconciliation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all active managed actions for a PR.
 *
 * @param {number} repoId    - repositories.github_id
 * @param {number} prNumber  - PR number
 * @param {string} [source]  - filter by source worker
 * @returns {Promise<Array>}
 */
export async function getActiveActions(repoId, prNumber, source) {
  const { rows } = await db.query(
    "SELECT * FROM managed_actions " +
    "WHERE repo_id = $1 AND pr_number = $2 AND active = TRUE " +
    (source ? " AND source = $3" : "") +
    " ORDER BY created_at ASC",
    source ? [repoId, prNumber, source] : [repoId, prNumber]
  );

  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// Reconcile a PR — deactivate actions whose context has changed
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reconcile managed actions for a PR against current context.
 * Returns list of actions that were deactivated (caller should remove from GitHub).
 *
 * @param {object} params
 * @param {number} params.repoId
 * @param {number} params.prNumber
 * @param {string} [params.source] - only reconcile actions from this source
 * @param {string} params.currentContextHash - hash of current triggering context
 * @param {Function} [params.removeFn] - async function to remove action from GitHub
 *   Signature: (action) => Promise<void>
 * @returns {Promise<{ deactivated: Array, kept: Array }>}
 */
export async function reconcilePR({ repoId, prNumber, source, currentContextHash, removeFn }) {
  const activeActions = await getActiveActions(repoId, prNumber, source);

  const deactivated = [];
  const kept = [];

  for (const action of activeActions) {
    // If context hash matches, keep the action
    if (action.context_hash && action.context_hash === currentContextHash) {
      kept.push(action);
      continue;
    }

    // Context changed or no context to compare — deactivate
    await deactivateAction(action.id);
    deactivated.push(action);

    // Remove from GitHub if removeFn provided
    if (removeFn) {
      try {
        await removeFn(action);
      } catch (err) {
        logger.warn(
          { actionId: action.id, actionKey: action.action_key, err: err.message },
          "Failed to remove stale action from GitHub (non-fatal)"
        );
      }
    }
  }

  if (deactivated.length > 0) {
    logger.info(
      { repoId, prNumber, deactivated: deactivated.length, kept: kept.length, source },
      "Reconciled managed actions"
    );
  }

  return { deactivated, kept };
}

// ════════════════════════════════════════════════════════════════════════════
// Cleanup: deactivate all managed actions for a closed/merged PR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Deactivate all active managed actions for a PR (called on close/merge).
 * Returns deactivated actions so caller can optionally remove from GitHub.
 *
 * @param {number} repoId
 * @param {number} prNumber
 * @returns {Promise<Array>} deactivated actions
 */
export async function cleanupPR(repoId, prNumber) {
  const activeActions = await getActiveActions(repoId, prNumber);

  if (activeActions.length === 0) return [];

  const ids = activeActions.map((a) => a.id);
  await db.query(
    "UPDATE managed_actions SET active = FALSE, deactivated_at = NOW() " +
    "WHERE id = ANY($1)",
    [ids]
  );

  logger.info(
    { repoId, prNumber, deactivated: ids.length },
    "Cleaned up managed actions for closed/merged PR"
  );

  return activeActions;
}

// ════════════════════════════════════════════════════════════════════════════
// Bulk: record multiple actions in a batch
// ════════════════════════════════════════════════════════════════════════════

/**
 * Record multiple managed actions at once.
 * Used by workers that perform several mutations in one pass.
 *
 * @param {Array<object>} actions - array of recordAction() params
 * @returns {Promise<Array<object>>} inserted rows
 */
export async function recordActions(actions) {
  const results = [];
  for (const action of actions) {
    try {
      const row = await recordAction(action);
      results.push(row);
    } catch (err) {
      logger.error(
        { actionKey: action.actionKey, err: err.message },
        "Failed to record managed action (non-fatal)"
      );
    }
  }
  return results;
}

// ════════════════════════════════════════════════════════════════════════════
// Stats: count active managed actions by source
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get count of active managed actions grouped by source.
 */
export async function getActionStats() {
  const { rows } = await db.query(
    "SELECT source, action_type, COUNT(*) AS count " +
    "FROM managed_actions " +
    "WHERE active = TRUE " +
    "GROUP BY source, action_type " +
    "ORDER BY count DESC"
  );
  return rows;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function hashContext(context) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(context))
    .digest("hex")
    .slice(0, 16); // 16 chars is enough for context comparison
}
