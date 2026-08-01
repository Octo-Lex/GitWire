// src/routes/governedPolicy.js
// Governed Policy Authority API routes.
// GP-02 (issue #98): Immutable policy versions and change-request state machine.
//
// All mutating routes call observeAuthorize (Wave 2 observe-only seam) and
// use authoritativePrincipalId(req) for server-owned principal attribution.

import { Router } from "express";
import { logger } from "../lib/logger.js";
import { observeAuthorize, authoritativePrincipalId } from "../services/auth/observeAdopt.js";
import {
  createChangeRequest,
  createVersion,
  selectVersion,
  submitChangeRequest,
  getChangeRequest,
  listChangeRequests,
  getVersions,
  getTransitionEvents,
} from "../services/governedPolicyService.js";

export const governedPolicyRouter = Router();

/**
 * POST /api/policy/change-requests
 * Create a new policy change request in draft state.
 */
governedPolicyRouter.post("/change-requests", async (req, res) => {
  try {
    const { resourceType, resourceId, policyFamily } = req.body;
    if (!resourceType || !resourceId || !policyFamily) {
      return res.status(400).json({ error: "resourceType, resourceId, and policyFamily are required" });
    }

    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:create",
      resource: { type: "policy_definition" },
    });

    const cr = await createChangeRequest({ resourceType, resourceId, policyFamily, principalId });
    res.status(201).json(cr);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create policy change request");
    if (err.message.includes("required") || err.message.includes("must be") || err.message.includes("fleet")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to create change request" });
  }
});

/**
 * GET /api/policy/change-requests
 * List change requests with optional filters.
 */
governedPolicyRouter.get("/change-requests", async (req, res) => {
  try {
    const { resourceType, resourceId, state, limit, offset } = req.query;
    const rows = await listChangeRequests({ resourceType, resourceId, state, limit, offset });
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list policy change requests");
    res.status(500).json({ error: "Failed to list change requests" });
  }
});

/**
 * GET /api/policy/change-requests/:id
 * Get a single change request with its versions and transition events.
 */
governedPolicyRouter.get("/change-requests/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cr = await getChangeRequest({ changeRequestId: id });
    if (!cr) return res.status(404).json({ error: "Change request not found" });
    const versions = await getVersions({ changeRequestId: id });
    const events = await getTransitionEvents({ changeRequestId: id });
    res.json({ ...cr, versions, transitionEvents: events });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to get policy change request");
    res.status(500).json({ error: "Failed to get change request" });
  }
});

/**
 * POST /api/policy/change-requests/:id/versions
 * Create a new immutable policy version (draft state only).
 */
governedPolicyRouter.post("/change-requests/:id/versions", async (req, res) => {
  try {
    const { id } = req.params;
    const { payload } = req.body;
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "payload must be an object" });
    }

    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:create",
      resource: { type: "policy_definition", resourceId: id },
    });

    const version = await createVersion({ changeRequestId: id, payload, principalId });
    res.status(201).json(version);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create policy version");
    if (err.message.includes("not found") || err.message.includes("draft") || err.message.includes("required") || err.message.includes("object")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to create version" });
  }
});

/**
 * POST /api/policy/change-requests/:id/select-version
 * Select a version as the target for submission.
 */
governedPolicyRouter.post("/change-requests/:id/select-version", async (req, res) => {
  try {
    const { id } = req.params;
    const { versionId } = req.body;
    if (!versionId) {
      return res.status(400).json({ error: "versionId is required" });
    }

    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:update",
      resource: { type: "policy_definition", resourceId: id },
    });

    const cr = await selectVersion({ changeRequestId: id, versionId, principalId });
    res.json(cr);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to select version");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: change request was modified concurrently" });
    }
    if (err.message.includes("not found") || err.message.includes("draft") || err.message.includes("belong") || err.message.includes("required")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to select version" });
  }
});

/**
 * POST /api/policy/change-requests/:id/submit
 * Submit the change request (draft → submitted).
 */
governedPolicyRouter.post("/change-requests/:id/submit", async (req, res) => {
  try {
    const { id } = req.params;

    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:update",
      resource: { type: "policy_definition", resourceId: id },
    });

    const cr = await submitChangeRequest({ changeRequestId: id, principalId });
    res.json(cr);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to submit change request");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: change request was modified concurrently" });
    }
    if (err.message.includes("not found") || err.message.includes("no version") || err.message.includes("Invalid transition") || err.message.includes("terminal")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to submit" });
  }
});
