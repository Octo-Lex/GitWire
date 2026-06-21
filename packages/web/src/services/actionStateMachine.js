// src/services/actionStateMachine.js
// Action lifecycle state machine — tracks every GitWire action from proposal to reconciliation.
//
// States: proposed → approved → executing → succeeded/failed/cancelled/blocked
//         failed → retrying → executing (with backoff)
//         blocked → (re-propose required; deterministic guard prevented execution)
//         succeeded → reconciled (confirmed still in effect)
//
// Every state transition is logged with timestamps and evidence.
// Guards prevent invalid transitions (e.g. can't approve a cancelled action).

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

// ── Typed blocked reasons ───────────────────────────────────────────────────
// "blocked" means a deterministic guard deliberately prevented execution.
// "failed" means execution was attempted and crashed/errored.
// This distinction makes abstention a first-class, queryable outcome.
export const BLOCKED_REASONS = Object.freeze({
  TARGET_DRIFTED:        "target_drifted",
  MARKER_AMBIGUOUS:      "marker_ambiguous",
  PERMISSION_DENIED:     "permission_denied",
  POLICY_DENIED:         "policy_denied",
  EVIDENCE_INCOMPLETE:   "evidence_incomplete",
  VERIFICATION_FAILED:   "verification_failed",
  BACKEND_UNAVAILABLE:   "backend_unavailable",
  RATE_LIMITED:          "rate_limited",
  DUPLICATE_ACTION:      "duplicate_action",
  UNSAFE_SCOPE:          "unsafe_scope",
  UNKNOWN:               "unknown",
});

// ── Valid states and transitions ─────────────────────────────────────────────
const STATES = {
  proposed:   { next: ["approved", "cancelled", "blocked"], label: "Proposed" },
  approved:   { next: ["executing", "cancelled", "blocked"], label: "Approved" },
  executing:  { next: ["succeeded", "failed", "cancelled"], label: "Executing" },
  succeeded:  { next: ["reconciled"], label: "Succeeded" },
  failed:     { next: ["retrying", "cancelled"], label: "Failed" },
  retrying:   { next: ["executing", "cancelled", "blocked"], label: "Retrying" },
  blocked:    { next: ["cancelled"], label: "Blocked" },
  cancelled:  { next: [], label: "Cancelled" },
  reconciled: { next: [], label: "Reconciled" },
};

// Terminal states — no further transitions possible
const TERMINAL_STATES = new Set(["succeeded", "cancelled", "reconciled", "blocked"]);

/**
 * Propose a new action. Creates a record in 'proposed' state.
 *
 * @param {object} params
 * @param {string} params.repoFullName — "owner/repo"
 * @param {string} params.pillar — triage, ci_healing, issue_fix, custom_rules, quality_gates, etc.
 * @param {string} params.actionType — add-label, remove-label, approve, create-pr, add-comment, etc.
 * @param {string} params.source — what triggered this (ai_triage, custom_rule:auto-approve-docs, quality_gate, etc.)
 * @param {object} params.evidence — context for the decision
 * @param {number} [params.parentActionId] — parent action if this is a retry
 * @param {number} [params.repoId] — repository DB id
 * @param {string} [params.targetType] — issue, pr, branch, etc.
 * @param {number} [params.targetNumber] — issue/PR number
 * @param {string} [params.actionKey] — dedup key (e.g. 'label:bug'). If set, deactivates previous active actions with same key.
 * @returns {object} the created action record
 */
export async function propose({
  repoFullName, pillar, actionType, source, evidence = {},
  parentActionId = null, repoId = null, targetType = null, targetNumber = null,
  actionKey = null,
}) {
  // Dedup: deactivate previous active actions with the same key
  if (actionKey && repoId) {
    await db.query(
      "UPDATE managed_actions SET active = FALSE, deactivated_at = NOW() " +
      "WHERE repo_id = $1 AND action_key = $2 AND active = TRUE " +
      "  AND (target_number = $3 OR (target_number IS NULL AND $3 IS NULL))",
      [repoId, actionKey, targetNumber ?? null]
    );
  }

  const result = await db.query(
    `INSERT INTO managed_actions
      (repo_full_name, pillar, action_type, action_key, source, status, proposed_at, evidence,
       parent_action_id, repo_id, target_type, target_number, retries, max_retries)
     VALUES ($1, $2, $3, $10, $4, 'proposed', NOW(), $5, $6, $7, $8, $9, 0, 3)
     RETURNING *`,
    [
      repoFullName, pillar, actionType, source,
      JSON.stringify(evidence), parentActionId, repoId, targetType, targetNumber,
      actionKey,
    ]
  );

  const action = result.rows[0];
  logger.info(
    { actionId: action.id, repo: repoFullName, pillar, actionType, source },
    "Action proposed"
  );
  return action;
}

/**
 * Approve a proposed action. Guards: must be in 'proposed' state.
 *
 * @param {number} actionId
 * @param {object} [approvalEvidence] — why it was approved (policy check, confidence, etc.)
 */
export async function approve(actionId, approvalEvidence = {}) {
  return transition(actionId, "approved", {
    approved_at: new Date().toISOString(),
    evidence: approvalEvidence,
  });
}

/**
 * Mark an action as executing. Guards: must be in 'approved' or 'retrying' state.
 */
export async function execute(actionId) {
  return transition(actionId, "executing", {
    executed_at: new Date().toISOString(),
  });
}

/**
 * Mark an action as succeeded.
 *
 * @param {number} actionId
 * @param {object} [result] — what happened (e.g. { pr_number: 99, pr_url: "..." })
 */
export async function succeed(actionId, result = {}) {
  return transition(actionId, "succeeded", {
    resolved_at: new Date().toISOString(),
    evidence: result,
  });
}

/**
 * Mark an action as failed.
 *
 * @param {number} actionId
 * @param {string} errorMessage — what went wrong
 */
export async function fail(actionId, errorMessage) {
  return transition(actionId, "failed", {
    error_message: errorMessage,
  });
}

/**
 * Mark an action as blocked. A deterministic guard prevented execution.
 * This is distinct from "failed" — the action was never attempted.
 *
 * @param {number} actionId
 * @param {string} blockedReason — one of BLOCKED_REASONS
 * @param {object} [detail] — expected vs actual state, marker info, etc.
 */
export async function block(actionId, blockedReason, detail = {}) {
  const action = await getAction(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  if (TERMINAL_STATES.has(action.status)) {
    throw new Error(`Cannot block action in terminal state: ${action.status}`);
  }

  // Move to blocked state with the typed reason
  await transition(actionId, "blocked", {
    resolved_at: new Date().toISOString(),
    error_message: `Blocked: ${blockedReason}`,
    evidence: { blocked_reason: blockedReason, ...detail },
  });

  // Store blocked_reason as a separate column for queryability
  await db.query(
    "UPDATE managed_actions SET blocked_reason = $1 WHERE id = $2",
    [blockedReason, actionId]
  );

  logger.info(
    { actionId, blockedReason, detail },
    "Action blocked by deterministic guard"
  );

  return { id: actionId, status: "blocked", blocked_reason: blockedReason };
}

/**
 * Check whether the live GitHub target still matches the proposal snapshot.
 * If drift is detected, blocks the action and returns true.
 *
 * Callers should call this BEFORE invoking execute() + performing the mutation.
 *
 * @param {number} actionId
 * @param {object} liveState — the freshly-fetched target state from GitHub
 * @param {string} liveState.updated_at — ISO timestamp of the target's current state
 * @param {string} [liveState.head_sha] — for PRs, the current head SHA
 * @param {string} [liveState.state] — for issues/PRs, open/closed
 * @returns {object} { drifted: boolean, reason: string|null, detail: object }
 */
export async function checkDrift(actionId, liveState = {}) {
  const action = await getAction(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);

  const expected = action.evidence?.target_snapshot || {};
  const detail = { expected, actual: liveState };

  // Check updated_at drift (the primary signal — covers comments, labels, state changes)
  if (expected.updated_at && liveState.updated_at &&
      expected.updated_at !== liveState.updated_at) {
    return { drifted: true, reason: BLOCKED_REASONS.TARGET_DRIFTED, detail };
  }

  // Check head_sha drift (for PRs — covers force-pushes, new commits)
  if (expected.head_sha && liveState.head_sha &&
      expected.head_sha !== liveState.head_sha) {
    return { drifted: true, reason: BLOCKED_REASONS.TARGET_DRIFTED, detail };
  }

  // Check state drift (issue/PR was closed/reopened since proposal)
  if (expected.state && liveState.state &&
      expected.state !== liveState.state) {
    return { drifted: true, reason: BLOCKED_REASONS.TARGET_DRIFTED, detail };
  }

  return { drifted: false, reason: null, detail };
}

/**
 * Cancel an action. Can be called from any non-terminal state.
 */
export async function cancel(actionId, reason = "") {
  const action = await getAction(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  if (TERMINAL_STATES.has(action.status)) {
    throw new Error(`Cannot cancel action in terminal state: ${action.status}`);
  }

  return transition(actionId, "cancelled", {
    resolved_at: new Date().toISOString(),
    error_message: reason || "Cancelled",
  });
}

/**
 * Retry a failed action. Increments retry count and transitions to 'retrying'.
 * Returns null if max retries exceeded.
 */
export async function retry(actionId) {
  const action = await getAction(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  if (action.status !== "failed") {
    throw new Error(`Can only retry failed actions, got: ${action.status}`);
  }
  if (action.retries >= action.max_retries) {
    logger.warn({ actionId, retries: action.retries }, "Max retries exceeded");
    return null;
  }

  // Create a new action as a child of the original
  const child = await propose({
    repoFullName: action.repo_full_name,
    pillar: action.pillar,
    actionType: action.action_type,
    source: action.source,
    evidence: { ...action.evidence, retry_of: actionId, retry_number: action.retries + 1 },
    parentActionId: action.id,
    repoId: action.repo_id,
    targetType: action.target_type,
    targetNumber: action.target_number,
  });

  // Update retry count on parent
  await db.query(
    "UPDATE managed_actions SET retries = retries + 1 WHERE id = $1",
    [actionId]
  );

  // Transition the child to retrying (skips proposed → approved)
  await db.query(
    `UPDATE managed_actions SET status = 'retrying', proposed_at = NOW(), approved_at = NOW() WHERE id = $1`,
    [child.id]
  );

  logger.info({ actionId: child.id, parentActionId: actionId, retry: action.retries + 1 }, "Action retrying");
  return { ...child, status: "retrying", retries: action.retries + 1 };
}

/**
 * Mark a succeeded action as reconciled (confirmed still in effect on GitHub).
 */
export async function reconcile(actionId, reconciliationStatus = "confirmed") {
  return transition(actionId, "reconciled", {
    reconciled_at: new Date().toISOString(),
    reconciliation_status: reconciliationStatus,
  });
}

/**
 * Record a reconciliation check result (whether drifted or not).
 */
export async function logReconciliationCheck(actionId, checkType, expected, actual, drifted) {
  await db.query(
    `INSERT INTO action_reconciliation_log (action_id, check_type, expected, actual, drifted)
     VALUES ($1, $2, $3, $4, $5)`,
    [actionId, checkType, expected, actual, drifted]
  );
}

// ── Query helpers ────────────────────────────────────────────────────────────

/**
 * Get a single action by ID.
 */
export async function getAction(actionId) {
  const { rows: [row] } = await db.query("SELECT * FROM managed_actions WHERE id = $1", [actionId]);
  return row || null;
}

/**
 * List actions with optional filters.
 */
export async function listActions({ repo, status, pillar, actionType, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const params = [];
  let idx = 1;

  if (repo) { conditions.push(`repo_full_name = $${idx++}`); params.push(repo); }
  if (status) { conditions.push(`status = $${idx++}`); params.push(status); }
  if (pillar) { conditions.push(`pillar = $${idx++}`); params.push(pillar); }
  if (actionType) { conditions.push(`action_type = $${idx++}`); params.push(actionType); }

  const where = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const { rows } = await db.query(
    `SELECT * FROM managed_actions ${where} ORDER BY COALESCE(proposed_at, created_at) DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset]
  );

  const { rows: [{ count }] } = await db.query(
    `SELECT COUNT(*)::int AS count FROM managed_actions ${where}`,
    params
  );

  return { data: rows, meta: { total: count, limit, offset } };
}

/**
 * Get action summary counts by status.
 */
export async function getActionSummary() {
  const { rows } = await db.query(
    `SELECT status, COUNT(*)::int AS count FROM managed_actions GROUP BY status ORDER BY count DESC`
  );
  return rows;
}

/**
 * Get actions needing reconciliation (succeeded but not yet reconciled).
 */
export async function getActionsNeedingReconciliation(maxAge = "6 hours") {
  const { rows } = await db.query(
    `SELECT * FROM managed_actions
     WHERE status = 'succeeded'
       AND resolved_at < NOW() - ($1)::interval
       AND (reconciled_at IS NULL OR reconciled_at < NOW() - ($1)::interval)
     ORDER BY resolved_at ASC
     LIMIT 100`,
    [maxAge]
  );
  return rows;
}

/**
 * Find actions stuck in transient states beyond reasonable timeouts.
 * - executing >6h: worker died mid-task
 * - approved >12h: never picked up for execution
 * - proposed >24h: never approved (requires manual approval)
 */
export async function getStaleActions() {
  const { rows } = await db.query(`
    SELECT *, 'executing_timeout' AS stale_reason FROM managed_actions
      WHERE status = 'executing' AND executed_at < NOW() - INTERVAL '6 hours'
    UNION ALL
    SELECT *, 'approved_timeout' AS stale_reason FROM managed_actions
      WHERE status = 'approved' AND approved_at < NOW() - INTERVAL '12 hours'
    UNION ALL
    SELECT *, 'proposed_timeout' AS stale_reason FROM managed_actions
      WHERE status = 'proposed' AND proposed_at < NOW() - INTERVAL '24 hours'
    ORDER BY proposed_at ASC
    LIMIT 100
  `);
  return rows;
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * Execute a state transition with guard validation.
 */
async function transition(actionId, newState, updates = {}) {
  const action = await getAction(actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);

  const allowed = STATES[action.status]?.next || [];
  if (!allowed.includes(newState)) {
    throw new Error(`Invalid transition: ${action.status} → ${newState}. Allowed: ${allowed.join(", ")}`);
  }

  const setClauses = ["status = $1"];
  const params = [newState];
  let idx = 2;

  if (updates.proposed_at) { setClauses.push(`proposed_at = $${idx++}`); params.push(updates.proposed_at); }
  if (updates.approved_at) { setClauses.push(`approved_at = $${idx++}`); params.push(updates.approved_at); }
  if (updates.executed_at) { setClauses.push(`executed_at = $${idx++}`); params.push(updates.executed_at); }
  if (updates.resolved_at) { setClauses.push(`resolved_at = $${idx++}`); params.push(updates.resolved_at); }
  if (updates.reconciled_at) { setClauses.push(`reconciled_at = $${idx++}`); params.push(updates.reconciled_at); }
  if (updates.reconciliation_status) { setClauses.push(`reconciliation_status = $${idx++}`); params.push(updates.reconciliation_status); }
  if (updates.error_message) { setClauses.push(`error_message = $${idx++}`); params.push(updates.error_message); }
  if (updates.evidence) {
    setClauses.push(`evidence = COALESCE(evidence, '{}')::jsonb || $${idx++}::jsonb`);
    params.push(JSON.stringify(updates.evidence));
  }

  params.push(actionId);
  const result = await db.query(
    `UPDATE managed_actions SET ${setClauses.join(", ")} WHERE id = $${idx} RETURNING *`,
    params
  );

  const updated = result.rows[0];
  logger.info(
    { actionId, from: action.status, to: newState, pillar: action.pillar, actionType: action.action_type },
    "Action transitioned"
  );
  return updated;
}
