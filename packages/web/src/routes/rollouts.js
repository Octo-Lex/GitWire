// src/routes/rollouts.js
// Governed policy rollout API.
//
// W2-03 keeps policy_rollout_plans as a compatibility/read model while routing
// authorship, evidence, and decisions through W2-01 immutable authority. Live
// policy mutation remains exclusively W2-02 promotion.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { observeAuthorize, legacyActorString } from "../services/auth/observeAdopt.js";
import {
  getRolloutPlan,
  listRolloutPlans,
  transitionRolloutPlan,
} from "../services/policyRolloutService.js";
import {
  approveGovernedRollout,
  attachGovernedEvidence,
  createGovernedRolloutPlan,
  PolicyRolloutGovernanceError,
  rejectGovernedRollout,
} from "../services/policyRolloutGovernanceService.js";
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

const AUTHORITY_FORBIDDEN_REASONS = new Set([
  "authoritative_principal_required",
  "authoritative_principal_not_found",
  "authoritative_principal_inactive",
  "authorization_denied",
  "self_approval_forbidden",
]);

const GOVERNANCE_CONFLICT_REASONS = new Set([
  "rollout_state_disallows_evidence",
  "rollout_state_disallows_approval",
  "rollout_state_disallows_rejection",
  "rollout_policy_changed_after_authority_snapshot",
  "rollout_authority_bound_to_different_principal",
  "rollout_authority_base_version_mismatch",
  "policy_evidence_frozen_after_decision",
  "approval_decision_already_recorded",
]);

// Retained for compatibility tests and non-authority lifecycle transitions.
// Governed create/evidence/decision handlers do not rely on this observe-only
// helper: W2-01 performs blocking enforced authorization itself.
export async function observeRolloutAuthorize(req, options, observe = observeAuthorize) {
  if (req._wave2Observed) return false;
  await observe(req, options);
  return true;
}

function governanceErrorStatus(err) {
  const reason = err?.reason || err?.message;
  if (AUTHORITY_FORBIDDEN_REASONS.has(reason)) return 403;
  if (GOVERNANCE_CONFLICT_REASONS.has(reason)) return 409;
  if (reason === "repository_not_found" || reason === "rollout_plan_not_found") return 404;
  return 400;
}

function sendGovernanceError(res, err) {
  if (err instanceof PolicyAuthorityError || err instanceof PolicyRolloutGovernanceError) {
    return res.status(governanceErrorStatus(err)).json({
      error: err.reason,
      detail: err.detail ?? undefined,
    });
  }
  return null;
}

/** Create a rollout and its immutable W2-01 author/change-request authority. */
rolloutRouter.post("/", async (req, res) => {
  try {
    const { repo, proposed_config, created_by } = req.body || {};
    if (!repo || typeof repo !== "string") {
      return res.status(400).json({ error: "repo is required (owner/repo)" });
    }
    if (!proposed_config || typeof proposed_config !== "object" || Array.isArray(proposed_config)) {
      return res.status(400).json({ error: "proposed_config is required (object)" });
    }
    if (created_by !== undefined && typeof created_by !== "string") {
      return res.status(400).json({ error: "created_by must be a string when provided" });
    }

    const compatibilityActor =
      typeof created_by === "string" && created_by.trim()
        ? created_by.trim()
        : legacyActorString(req, "created_by");

    const plan = await createGovernedRolloutPlan({
      repo,
      proposedConfig: proposed_config,
      compatibilityActor,
      principal: req.auth,
    });
    return res.status(201).json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to create governed rollout plan");
    const handled = sendGovernanceError(res, err);
    if (handled) return handled;
    return res.status(500).json({ error: "Failed to create rollout plan" });
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
    return res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list rollout plans");
    return res.status(500).json({ error: "Failed to list rollout plans" });
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
    return res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get rollout plan");
    return res.status(500).json({ error: "Failed to get rollout plan" });
  }
});

/** Mirror evidence and append exact immutable W2-01 evidence atomically. */
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

    const plan = await attachGovernedEvidence({
      rolloutPlanId: id,
      principal: req.auth,
      evidence: {
        validation_result,
        simulation_summary,
        diff_impact_summary,
        recommendations_summary,
      },
    });
    return res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to attach governed evidence");
    const handled = sendGovernanceError(res, err);
    if (handled) return handled;
    return res.status(500).json({ error: "Failed to attach evidence" });
  }
});

/** Non-authority compatibility lifecycle transitions remain available. */
rolloutRouter.post("/:id/transition", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, actor, review_notes } = req.body || {};
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    if (!status || typeof status !== "string") {
      return res.status(400).json({ error: "status is required" });
    }

    await observeRolloutAuthorize(req, {
      permission: "policy_rollout_plan:update",
      resource: { type: "policy_rollout_plan", resourceId: String(id) },
      legacyActor: actor,
    });

    const plan = await transitionRolloutPlan(id, { status, actor, review_notes });
    return res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to transition rollout plan");
    if (
      err.message.includes("Invalid transition") ||
      err.message.includes("not found") ||
      err.message.includes("terminal") ||
      err.message.includes("missing required") ||
      err.message.includes("required") ||
      err.message.includes("must go through")
    ) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: "Failed to transition rollout plan" });
  }
});

/** Record immutable W2-01 approval and mirror compatibility state atomically. */
rolloutRouter.post("/:id/approve", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const { actor, reason, acknowledged_recommendations } = req.body || {};
    if (actor !== undefined && typeof actor !== "string") {
      return res.status(400).json({ error: "actor must be a string when provided" });
    }
    if (
      acknowledged_recommendations !== undefined &&
      !Array.isArray(acknowledged_recommendations)
    ) {
      return res.status(400).json({ error: "acknowledged_recommendations must be an array" });
    }

    const compatibilityActor =
      typeof actor === "string" && actor.trim()
        ? actor.trim()
        : legacyActorString(req);

    const plan = await approveGovernedRollout({
      rolloutPlanId: id,
      principal: req.auth,
      compatibilityActor,
      reason: reason ?? null,
      acknowledgedRecommendations: acknowledged_recommendations || [],
    });
    return res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to approve governed rollout plan");
    const handled = sendGovernanceError(res, err);
    if (handled) return handled;
    return res.status(500).json({ error: "Failed to approve rollout plan" });
  }
});

/** Record immutable W2-01 rejection and mirror compatibility state atomically. */
rolloutRouter.post("/:id/reject", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }
    const { actor, reason } = req.body || {};
    if (actor !== undefined && typeof actor !== "string") {
      return res.status(400).json({ error: "actor must be a string when provided" });
    }

    const compatibilityActor =
      typeof actor === "string" && actor.trim()
        ? actor.trim()
        : legacyActorString(req);

    const plan = await rejectGovernedRollout({
      rolloutPlanId: id,
      principal: req.auth,
      compatibilityActor,
      reason: reason ?? null,
    });
    return res.json(plan);
  } catch (err) {
    logger.error({ err: err.message, reason: err.reason }, "Failed to reject governed rollout plan");
    const handled = sendGovernanceError(res, err);
    if (handled) return handled;
    return res.status(500).json({ error: "Failed to reject rollout plan" });
  }
});

/** W2-02 remains the sole live-policy mutation path. */
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
    return res.status(500).json({ error: "Failed to promote rollout plan" });
  }
});

/**
 * Historical JSON restore is not an authority object. Until rollback is modeled
 * as a new immutable policy version/change request, fail closed rather than
 * writing previous_config underneath the active governed binding.
 */
rolloutRouter.post("/:id/rollback", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Valid plan ID is required" });
  }
  return res.status(409).json({
    error: "governed_rollback_requires_new_policy_version",
    detail: "Create and approve a new rollout for the prior policy content, then promote it through W2-02.",
  });
});
