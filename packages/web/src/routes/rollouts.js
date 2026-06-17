// src/routes/rollouts.js
// Policy rollout plan API routes.
//
// Non-mutating to GitHub: rollout plans are GitWire-internal records.
// Policy mutation (promotion) is a separate, explicitly-controlled step.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import {
  createRolloutPlan,
  getRolloutPlan,
  listRolloutPlans,
  attachEvidence,
  transitionRolloutPlan,
  approveRolloutPlan,
  rejectRolloutPlan,
} from "../services/policyRolloutService.js";

export const rolloutRouter = Router();

/**
 * POST /api/rollouts
 *
 * Create a new rollout plan in draft state.
 */
rolloutRouter.post("/", async (req, res) => {
  try {
    const { repo, proposed_config, created_by } = req.body;

    if (!repo || typeof repo !== "string") {
      return res.status(400).json({ error: "repo is required (owner/repo)" });
    }
    if (!proposed_config || typeof proposed_config !== "object") {
      return res.status(400).json({ error: "proposed_config is required (object)" });
    }
    if (!created_by || typeof created_by !== "string") {
      return res.status(400).json({ error: "created_by is required (GitHub username)" });
    }

    const plan = await createRolloutPlan({ repo, proposed_config, created_by });
    res.status(201).json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create rollout plan");
    if (err.message.includes("not found") || err.message.includes("required")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to create rollout plan" });
  }
});

/**
 * GET /api/rollouts
 *
 * List rollout plans with optional filters.
 * Query params: repo, status, created_by, limit, offset
 */
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

/**
 * GET /api/rollouts/:id
 *
 * Get a single rollout plan by ID.
 */
rolloutRouter.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Valid plan ID is required" });
    }

    const plan = await getRolloutPlan(id);
    if (!plan) {
      return res.status(404).json({ error: "Rollout plan not found" });
    }

    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get rollout plan");
    res.status(500).json({ error: "Failed to get rollout plan" });
  }
});

/**
 * PATCH /api/rollouts/:id/evidence
 *
 * Attach evidence (validation, simulation, diff, recommendations) to a plan.
 * Only allowed in draft or validated state.
 */
rolloutRouter.patch("/:id/evidence", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { validation_result, simulation_summary, diff_impact_summary, recommendations_summary } = req.body;

    const plan = await attachEvidence(id, {
      validation_result,
      simulation_summary,
      diff_impact_summary,
      recommendations_summary,
    });

    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to attach evidence");
    if (err.message.includes("not found") || err.message.includes("Cannot attach")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to attach evidence" });
  }
});

/**
 * POST /api/rollouts/:id/transition
 *
 * Transition a rollout plan to a new status.
 * Body: { status, actor?, review_notes? }
 */
rolloutRouter.post("/:id/transition", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, actor, review_notes } = req.body;

    if (!status || typeof status !== "string") {
      return res.status(400).json({ error: "status is required" });
    }

    const plan = await transitionRolloutPlan(id, { status, actor, review_notes });
    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to transition rollout plan");
    if (err.message.includes("Invalid transition") ||
        err.message.includes("not found") ||
        err.message.includes("terminal") ||
        err.message.includes("missing required") ||
        err.message.includes("required") ||
        err.message.includes("must go through")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to transition rollout plan" });
  }
});

/**
 * POST /api/rollouts/:id/approve
 *
 * Approve a rollout plan. Requires:
 * - Plan in review_ready state
 * - All evidence attached (validation, simulation, diff, recommendations)
 * - Proposed policy valid
 * - All critical recommendations acknowledged
 *
 * Body: { actor, reason?, acknowledged_recommendations? }
 */
rolloutRouter.post("/:id/approve", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { actor, reason, acknowledged_recommendations } = req.body;

    if (!actor || typeof actor !== "string") {
      return res.status(400).json({ error: "actor is required (GitHub username)" });
    }

    const plan = await approveRolloutPlan(id, {
      actor,
      reason,
      acknowledged_recommendations: acknowledged_recommendations || [],
    });

    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to approve rollout plan");
    if (err.message.includes("not found") ||
        err.message.includes("Cannot approve") ||
        err.message.includes("missing") ||
        err.message.includes("not acknowledged") ||
        err.message.includes("validation failed")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to approve rollout plan" });
  }
});

/**
 * POST /api/rollouts/:id/reject
 *
 * Reject a rollout plan. Records rejection actor, timestamp, and reason.
 * Plan must be in review_ready state.
 *
 * Body: { actor, reason? }
 */
rolloutRouter.post("/:id/reject", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { actor, reason } = req.body;

    if (!actor || typeof actor !== "string") {
      return res.status(400).json({ error: "actor is required (GitHub username)" });
    }

    const plan = await rejectRolloutPlan(id, { actor, reason });

    res.json(plan);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to reject rollout plan");
    if (err.message.includes("not found") ||
        err.message.includes("Cannot reject")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to reject rollout plan" });
  }
});
