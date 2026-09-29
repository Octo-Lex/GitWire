// src/routes/rollouts.js
// Policy rollout plan API routes.
//
// W2-03 keeps the compatibility rollout surface but routes every authoring,
// evidence, and decision write through W2-01 immutable authority. W2-02 remains
// the only live-policy promotion implementation.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { observeAuthorize } from "../services/auth/observeAdopt.js";
import {
  getRolloutPlan,
  listRolloutPlans,
} from "../services/policyRolloutService.js";
import {
  createGovernedRolloutPlan,
  attachGovernedRolloutEvidence,
  transitionGovernedRolloutPlan,
  approveGovernedRolloutPlan,
  rejectGovernedRolloutPlan,
  GovernedPolicyWriterError,
} from "../services/governedPolicyWriterService.js";
import { PolicyAuthorityError } from "../services/policyAuthorityService.js";
import {
  promotePolicyRollout,
  PolicyPromotionError,
} from "../services/policyPromotionService.js";

export const rolloutRouter = Router();

const POLICY_PROMOTION_CONFLICT_REASONS = new Set([
  "rollout_state_disallows_promotion",
  "rollout_state_changed_during_promotion",
  "stale_policy_base",
  "first_governed_promotion_requires_null_base",
  "active_policy_materialization_drift",
  "repository_binding_changed",
]);
const POLICY_PROMOTION_AUTHORIZATION_REASONS = new Set([
  "promoter_principal_required",
  "promoter_authorization_denied",
  "promoter_authorization_not_persisted",
  "approver_authorization_denied",
  "approver_authorization_not_persisted",
]);
const POLICY_PROMOTION_REASON_MAX_LENGTH = 2000;

const GOVERNED_WRITER_AUTHORIZATION_REASONS = new Set([
  "authoritative_principal_required",
  "authoritative_principal_not_found",
  "authoritative_principal_inactive",
  "authorization_denied",
  "self_approval_forbidden",
]);
const GOVERNED_WRITER_NOT_FOUND_REASONS = new Set([
  "repository_not_found",
  "rollout_plan_not_found",
  "rollout_repository_unknown",
  "policy_authority_not_found",
]);
const GOVERNED_WRITER_CONFLICT_REASONS = new Set([
  "rollout_state_disallows_evidence",
  "rollout_state_disallows_decision",
  "rollout_state_disallows_approval",
  "rollout_state_disallows_rejection",
  "rollout_terminal_state",
  "invalid_rollout_transition",
  "dedicated_governed_endpoint_required",
  "policy_evidence_frozen_after_decision",
  "approval_decision_already_recorded",
  "rollout_authority_bound_to_different_principal",
  "rollout_authority_base_version_mismatch",
  "rollout_policy_changed_after_authority_snapshot",
]);

// routeAuthObserver runs before route handlers. When it successfully records
// the declaration-derived decision, do not emit a second route-local decision
// with a less complete resource. If the app observer failed, retain the
// route-local observe-only fallback. W2-03 enforcement happens inside the
// governed writer service; this helper remains compatibility telemetry only.
export async function observeRolloutAuthorize(req, options, observe = observeAuthorize) {
  if (req._wave2Observed) return false;
  await observe(req, options);
  return true;
}

function isGovernedWriterError(err) {
  return err instanceof GovernedPolicyWriterError || err instanceof PolicyAuthorityError;
}

function governedWriterStatus(err) {
  if (GOVERNED_WRITER_AUTHORIZATION_REASONS.has(err.reason)) return 403;
  if (GOVERNED_WRITER_NOT_FOUND_REASONS.has(err.reason)) return 404;
  if (GOVERNED_WRITER_CONFLICT_REASONS.has(err.reason)) return 409;
  return 400;
}

function sendGovernedWriterError(res, err) {
  return res.status(governedWriterStatus(err)).json({
    error: err.reason,
    detail: err.detail ?? undefined,
  });
}

rolloutRouter.post("/", async (req, res) => {
  try {
    const { repo, proposed_config, created_by } = req.body || {};

    if (!repo || typeof repo !== "string") {
      return res.status(400).json({ error: "repo is required (owner/repo)" });
    }
    if (!proposed_config || typeof proposed_config !== "object" || Array.isArray(proposed_config)) {
      return res.status(400).json({ error: "proposed_config is required (object)" });
    }
    if (created_by !== undefined && created_by !== null && typeof created_by !== "string") {
      return res.status(400).json({ error: "created_by must be a string when provided" });
    }

    await observeRolloutAuthorize(req, {
      permission: "policy_definition:create",
      resource: { type: "policy_definition" },
      legacyActor: created_by,
    });

    const plan = await createGovernedRolloutPlan({
      repo,
      proposed_config,
      created_by,
      principal: req.auth,
    });
    res.status(201).json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to create governed rollout plan");
    if (isGovernedWriterError(err)) return sendGovernedWriterError(res, err);
    res.status(500).json({ error: "Failed to create rollout plan" });
  }
});

rolloutRouter.get("/", async (req, res) => {
  try {
    const { repo, status, created_by, limit, offset } = req.query;
    const result = await listRolloutPlans({
      repo,
      status,
      created_by,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list rollout plans");
    res.status(500).json({ error: "Failed to list rollout plans" });
  }
});

rolloutRouter.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const plan = await getRolloutPlan(id);
    if (!plan) return res.status(404).json({ error: "Rollout plan not found" });
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get rollout plan");
    res.status(500).json({ error: "Failed to get rollout plan" });
  }
});

rolloutRouter.patch("/:id/evidence", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const {
      validation_result,
      simulation_summary,
      diff_impact_summary,
      recommendations_summary,
    } = req.body || {};

    await observeRolloutAuthorize(req, {
      permission: "policy_rollout_plan:update",
      resource: { type: "policy_rollout_plan", resourceId: String(id) },
      legacyActor: req.body?.actor,
    });

    const plan = await attachGovernedRolloutEvidence(
      id,
      { validation_result, simulation_summary, diff_impact_summary, recommendations_summary },
      { principal: req.auth },
    );
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to attach governed evidence");
    if (isGovernedWriterError(err)) return sendGovernedWriterError(res, err);
    res.status(500).json({ error: "Failed to attach evidence" });
  }
});

rolloutRouter.post("/:id/transition", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const { status, actor, review_notes } = req.body || {};
    if (!status || typeof status !== "string") {
      return res.status(400).json({ error: "status is required" });
    }

    await observeRolloutAuthorize(req, {
      permission: "policy_rollout_plan:update",
      resource: { type: "policy_rollout_plan", resourceId: String(id) },
      legacyActor: actor,
    });

    const plan = await transitionGovernedRolloutPlan(id, {
      status,
      principal: req.auth,
      review_notes,
    });
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to transition governed rollout plan");
    if (isGovernedWriterError(err)) return sendGovernedWriterError(res, err);
    res.status(500).json({ error: "Failed to transition rollout plan" });
  }
});

rolloutRouter.post("/:id/approve", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const { actor, reason, acknowledged_recommendations, expires_at } = req.body || {};

    await observeRolloutAuthorize(req, {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: String(id) },
      legacyActor: actor,
    });

    const plan = await approveGovernedRolloutPlan(id, {
      principal: req.auth,
      reason: reason ?? null,
      acknowledged_recommendations: acknowledged_recommendations || [],
      expires_at: expires_at ?? null,
    });
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to approve governed rollout plan");
    if (isGovernedWriterError(err)) return sendGovernedWriterError(res, err);
    res.status(500).json({ error: "Failed to approve rollout plan" });
  }
});

rolloutRouter.post("/:id/reject", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const { actor, reason } = req.body || {};

    await observeRolloutAuthorize(req, {
      permission: "policy_rollout_plan:approve",
      resource: { type: "policy_rollout_plan", resourceId: String(id) },
      legacyActor: actor,
    });

    const plan = await rejectGovernedRolloutPlan(id, {
      principal: req.auth,
      reason: reason ?? null,
    });
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to reject governed rollout plan");
    if (isGovernedWriterError(err)) return sendGovernedWriterError(res, err);
    res.status(500).json({ error: "Failed to reject rollout plan" });
  }
});

/**
 * POST /api/rollouts/:id/promote
 *
 * W2-02 canonical governed promotion. Authority comes only from req.auth and
 * W2-01 immutable records. A legacy body.actor may still be sent by old clients
 * but is not consulted for authorization or attribution.
 */
rolloutRouter.post("/:id/promote", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }

    const { reason } = req.body || {};
    let normalizedReason = null;
    if (reason !== undefined && reason !== null) {
      if (typeof reason !== "string") {
        return res.status(400).json({ error: "reason must be a string when provided" });
      }
      normalizedReason = reason.trim();
      if (!normalizedReason) {
        return res.status(400).json({ error: "reason must be non-empty when provided" });
      }
      if (normalizedReason.length > POLICY_PROMOTION_REASON_MAX_LENGTH) {
        return res.status(400).json({
          error: `reason must be at most ${POLICY_PROMOTION_REASON_MAX_LENGTH} characters`,
        });
      }
    }

    const committed = await promotePolicyRollout({
      rolloutPlanId: id,
      principal: req.auth,
      reason: normalizedReason,
    });

    try {
      const plan = await getRolloutPlan(id);
      if (!plan) throw new Error("promoted rollout missing after commit");
      return res.json(plan);
    } catch (readErr) {
      logger.warn(
        {
          err: readErr.message,
          rolloutPlanId: id,
          promotionId: committed.promotion?.id,
        },
        "Governed promotion committed but rollout response refresh failed",
      );
      return res.json(committed.rollout);
    }
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to promote rollout plan");
    if (err instanceof PolicyPromotionError) {
      const authorizationFailure = POLICY_PROMOTION_AUTHORIZATION_REASONS.has(err.reason) ||
        (err.reason === "no_currently_authorized_separated_approval" && Boolean(err.detail?.code));
      const stateConflict = POLICY_PROMOTION_CONFLICT_REASONS.has(err.reason);
      const status = authorizationFailure ? 403 : stateConflict ? 409 : 400;
      return res.status(status).json({ error: err.reason, detail: err.detail ?? undefined });
    }
    res.status(500).json({ error: "Failed to promote rollout plan" });
  }
});

rolloutRouter.post("/:id/rollback", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Valid plan ID is required" });
  }
  return res.status(409).json({
    error: "legacy_policy_rollback_disabled",
    message: "Rollback must be performed through a governed immutable policy transition.",
  });
});
