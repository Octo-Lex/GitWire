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
  createApprovalRule,
  recordApproval,
  revokeApproval,
  expireApproval,
  evaluateApprovals,
  approveChangeRequest,
  getApprovalRules,
  getApprovals,
  evaluateChangeRequest,
  getValidationEvidence,
  getSimulationEvidence,
  // GP-05
  promoteChangeRequest,
  createRollbackRequest,
  approveRollbackRequest,
  rejectRollbackRequest,
  withdrawRollbackRequest,
  promoteRollbackRequest,
  getActiveBindings,
  getPromotionRecords,
  getRollbackRequests,
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

// ════════════════════════════════════════════════════════════════════════════
// GP-03: Approval rules, approvals, expiry, separation of duties
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/policy/approval-rules
 * Create an immutable approval rule.
 */
governedPolicyRouter.post("/approval-rules", async (req, res) => {
  try {
    const { ruleVersion, policyFamily, resourceScopeType, resourceScopeId, riskClassification, requiredCount, requiredRoles, approvalTtlSeconds } = req.body;
    if (!ruleVersion || !policyFamily || !resourceScopeType || !resourceScopeId || !riskClassification || !requiredCount || !requiredRoles) {
      return res.status(400).json({ error: "Missing required fields" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_approval_rule:create",
      resource: { type: "policy_definition" },
    });
    const rule = await createApprovalRule({ ruleVersion, policyFamily, resourceScopeType, resourceScopeId, riskClassification, requiredCount, requiredRoles, principalId, approvalTtlSeconds });
    res.status(201).json(rule);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create approval rule");
    if (err.message.includes("required") || err.message.includes("must") || err.message.includes("fleet") || err.message.includes("admin") || err.message.includes("role") || err.message.includes("active")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to create approval rule" });
  }
});

/**
 * GET /api/policy/approval-rules
 * List approval rules with optional filters.
 */
governedPolicyRouter.get("/approval-rules", async (req, res) => {
  try {
    const { resourceScopeType, resourceScopeId, policyFamily } = req.query;
    await observeAuthorize(req, {
      permission: "policy_approval_rule:read",
      resource: { type: "policy_definition" },
    });
    const rules = await getApprovalRules({ resourceScopeType, resourceScopeId, policyFamily });
    res.json({ data: rules });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list approval rules");
    res.status(500).json({ error: "Failed to list approval rules" });
  }
});

/**
 * POST /api/policy/change-requests/:id/approvals
 * Record an approval. Server derives all authority fields.
 */
governedPolicyRouter.post("/change-requests/:id/approvals", async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalRuleId } = req.body;
    if (!approvalRuleId) {
      return res.status(400).json({ error: "approvalRuleId is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_approval:create",
      resource: { type: "policy_definition", resourceId: id },
    });
    const approval = await recordApproval({ changeRequestId: id, approvalRuleId, principalId });
    res.status(201).json(approval);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to record approval");
    if (err.message.includes("self-approval") || err.message.includes("not found") || err.message.includes("awaiting_approval") || err.message.includes("active") || err.message.includes("duplicate") || err.message.includes("role") || err.message.includes("required") || err.message.includes("rule") || err.message.includes("context")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to record approval" });
  }
});

/**
 * GET /api/policy/change-requests/:id/approvals
 * List approvals for a change request with latest lifecycle status.
 */
governedPolicyRouter.get("/change-requests/:id/approvals", async (req, res) => {
  try {
    const { id } = req.params;
    await observeAuthorize(req, {
      permission: "policy_approval:read",
      resource: { type: "policy_definition", resourceId: id },
    });
    const approvals = await getApprovals({ changeRequestId: id });
    res.json({ data: approvals });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list approvals");
    res.status(500).json({ error: "Failed to list approvals" });
  }
});

/**
 * GET /api/policy/change-requests/:id/approvals/evaluate
 * Advisory sufficiency evaluation.
 */
governedPolicyRouter.get("/change-requests/:id/approvals/evaluate", async (req, res) => {
  try {
    const { id } = req.params;
    await observeAuthorize(req, {
      permission: "policy_approval:evaluate",
      resource: { type: "policy_definition", resourceId: id },
    });
    const result = await evaluateApprovals({ changeRequestId: id });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to evaluate approvals");
    if (err.message.includes("not found") || err.message.includes("no selected") || err.message.includes("context")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to evaluate approvals" });
  }
});

/**
 * POST /api/policy/change-requests/:id/approve
 * Atomic sufficiency evaluation + CAS transition awaiting_approval → approved.
 */
governedPolicyRouter.post("/change-requests/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStateRevision } = req.body;
    if (expectedStateRevision === undefined) {
      return res.status(400).json({ error: "expectedStateRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:approve",
      resource: { type: "policy_definition", resourceId: id },
    });
    const cr = await approveChangeRequest({ changeRequestId: id, expectedStateRevision: Number(expectedStateRevision), principalId });
    res.json(cr);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to approve change request");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: change request was modified concurrently" });
    }
    if (err.message.includes("insufficient") || err.message.includes("not found") || err.message.includes("awaiting_approval") || err.message.includes("admin") || err.message.includes("rule")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to approve" });
  }
});

/**
 * POST /api/policy/approvals/:id/revoke
 * Revoke an approval. CAS on lifecycle revision.
 */
governedPolicyRouter.post("/approvals/:id/revoke", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedLifecycleRevision, reason } = req.body;
    if (expectedLifecycleRevision === undefined || !reason) {
      return res.status(400).json({ error: "expectedLifecycleRevision and reason are required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_approval:revoke",
      resource: { type: "policy_definition", resourceId: id },
    });
    const result = await revokeApproval({ approvalId: id, expectedLifecycleRevision: Number(expectedLifecycleRevision), principalId, reason });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to revoke approval");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: approval was modified concurrently" });
    }
    if (err.message.includes("not found") || err.message.includes("active") || err.message.includes("approver") || err.message.includes("admin") || err.message.includes("required") || err.message.includes("empty")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to revoke" });
  }
});

/**
 * POST /api/policy/approvals/:id/expire
 * Expire an approval past its TTL. CAS on lifecycle revision.
 */
governedPolicyRouter.post("/approvals/:id/expire", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedLifecycleRevision } = req.body;
    if (expectedLifecycleRevision === undefined) {
      return res.status(400).json({ error: "expectedLifecycleRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_approval:revoke",
      resource: { type: "policy_definition", resourceId: id },
    });
    const result = await expireApproval({ approvalId: id, expectedLifecycleRevision: Number(expectedLifecycleRevision), principalId });
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to expire approval");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: approval was modified concurrently" });
    }
    if (err.message.includes("not found") || err.message.includes("active") || err.message.includes("admin") || err.message.includes("expired") || err.message.includes("required")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to expire" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GP-04: Validation and simulation evidence (issue #100)
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/policy/change-requests/:id/evaluate
 * Validate, simulate, and atomically finalize the change request.
 * Body: exactly { expectedStateRevision: <safe non-negative integer> }.
 * Exact-key whitelist: any additional or missing key is rejected with 400
 * BEFORE authoritativePrincipalId/observeAuthorize/service are called, so
 * prohibited fields (results, hashes, risk classification, actor/principal
 * ids, version ids, simulation profiles, date ranges, limits) cannot reach
 * computation or the database.
 */
governedPolicyRouter.post("/change-requests/:id/evaluate", async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    // Exact-key whitelist. Accept ONLY { expectedStateRevision }. Reject null,
    // arrays, primitives, prototype-pollution attempts, and any extra/missing key.
    const proto = body !== null && typeof body === "object" ? Object.getPrototypeOf(body) : null;
    const isPlainObject =
      proto === Object.prototype || proto === null;
    const keys = isPlainObject ? Object.keys(body).sort() : [];
    if (!isPlainObject || keys.length !== 1 || keys[0] !== "expectedStateRevision") {
      const received = isPlainObject ? `keys=[${keys.join(",")}]` : `type=${Array.isArray(body) ? "array" : body === null ? "null" : typeof body}`;
      return res.status(400).json({ error: `Request body must be exactly { expectedStateRevision }; received ${received}` });
    }
    // No Number() coercion at the boundary. Strings like "1" are rejected.
    const rev = body.expectedStateRevision;
    if (!Number.isSafeInteger(rev) || rev < 0) {
      return res.status(400).json({ error: "expectedStateRevision must be a non-negative safe integer" });
    }

    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:evaluate",
      resource: { type: "policy_definition", resourceId: id },
    });
    const result = await evaluateChangeRequest({ changeRequestId: id, expectedStateRevision: rev, principalId });
    if (result.state === "rejected") {
      return res.status(422).json(result);
    }
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, "Failed to evaluate change request");
    if (err.message.includes("CAS failed") || err.message.includes("revision mismatch")) {
      return res.status(409).json({ error: "Conflict: change request was modified concurrently" });
    }
    if (err.message.includes("not found") || err.message.includes("submitted") || err.message.includes("version") || err.message.includes("required") || err.message.includes("boolean")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to evaluate" });
  }
});

/**
 * GET /api/policy/change-requests/:id/validation-evidence
 * List validation evidence for a change request.
 */
governedPolicyRouter.get("/change-requests/:id/validation-evidence", async (req, res) => {
  try {
    const { id } = req.params;
    await observeAuthorize(req, {
      permission: "policy_validation_evidence:read",
      resource: { type: "policy_definition", resourceId: id },
    });
    const evidence = await getValidationEvidence({ changeRequestId: id });
    res.json({ data: evidence });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list validation evidence");
    res.status(500).json({ error: "Failed to list validation evidence" });
  }
});

/**
 * GET /api/policy/change-requests/:id/simulation-evidence
 * List simulation evidence for a change request.
 */
governedPolicyRouter.get("/change-requests/:id/simulation-evidence", async (req, res) => {
  try {
    const { id } = req.params;
    await observeAuthorize(req, {
      permission: "policy_simulation_evidence:read",
      resource: { type: "policy_definition", resourceId: id },
    });
    const evidence = await getSimulationEvidence({ changeRequestId: id });
    res.json({ data: evidence });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list simulation evidence");
    res.status(500).json({ error: "Failed to list simulation evidence" });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// GP-05: Atomic promotion and governed rollback routes
// Exact-key request whitelists; identity from req.auth only.
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/policy/change-requests/:id/promote
 * Forward promotion. Body whitelist: expectedStateRevision, expectedBindingRevision.
 */
governedPolicyRouter.post("/change-requests/:id/promote", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStateRevision, expectedBindingRevision } = req.body;
    if (expectedStateRevision === undefined || expectedStateRevision === null) {
      return res.status(400).json({ error: "expectedStateRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_change_request:promote",
      resource: { type: "policy_definition", resourceId: id },
    });
    const result = await promoteChangeRequest({
      changeRequestId: id,
      expectedStateRevision: Number(expectedStateRevision),
      expectedBindingRevision: expectedBindingRevision === undefined || expectedBindingRevision === null ? null : Number(expectedBindingRevision),
      principalId,
    });
    if (result.outcome === "failed" && /CAS|stale|concurrently/i.test(result.failureCode || "")) {
      return res.status(409).json({ error: "Request or binding state changed concurrently", ...result });
    }
    if (result.outcome === "failed") {
      return res.status(422).json({ error: `Promotion refused: ${result.failureCode}`, ...result });
    }
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to promote change request");
    res.status(500).json({ error: "Failed to promote change request" });
  }
});

/**
 * POST /api/policy/bindings/:id/rollback-requests
 * Create rollback request. Body whitelist: expectedBindingRevision, targetVersionId.
 */
governedPolicyRouter.post("/bindings/:id/rollback-requests", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedBindingRevision, targetVersionId } = req.body;
    if (expectedBindingRevision === undefined || expectedBindingRevision === null || !targetVersionId) {
      return res.status(400).json({ error: "expectedBindingRevision and targetVersionId are required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_rollback_request:create",
      resource: { type: "policy_binding", resourceId: id },
    });
    const result = await createRollbackRequest({
      bindingId: id,
      expectedBindingRevision: Number(expectedBindingRevision),
      targetVersionId,
      principalId,
    });
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to create rollback request");
    res.status(500).json({ error: "Failed to create rollback request" });
  }
});

/**
 * POST /api/policy/rollback-requests/:id/approve
 * Body whitelist: expectedStatusRevision.
 */
governedPolicyRouter.post("/rollback-requests/:id/approve", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStatusRevision } = req.body;
    if (expectedStatusRevision === undefined || expectedStatusRevision === null) {
      return res.status(400).json({ error: "expectedStatusRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_rollback_request:approve",
      resource: { type: "policy_rollback", resourceId: id },
    });
    const result = await approveRollbackRequest({
      rollbackRequestId: id,
      expectedStatusRevision: Number(expectedStatusRevision),
      principalId,
    });
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to approve rollback request");
    res.status(500).json({ error: "Failed to approve rollback request" });
  }
});

/**
 * POST /api/policy/rollback-requests/:id/reject
 * Body whitelist: expectedStatusRevision.
 */
governedPolicyRouter.post("/rollback-requests/:id/reject", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStatusRevision } = req.body;
    if (expectedStatusRevision === undefined || expectedStatusRevision === null) {
      return res.status(400).json({ error: "expectedStatusRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_rollback_request:approve",
      resource: { type: "policy_rollback", resourceId: id },
    });
    const result = await rejectRollbackRequest({
      rollbackRequestId: id,
      expectedStatusRevision: Number(expectedStatusRevision),
      principalId,
    });
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to reject rollback request");
    res.status(500).json({ error: "Failed to reject rollback request" });
  }
});

/**
 * POST /api/policy/rollback-requests/:id/withdraw
 * Body whitelist: expectedStatusRevision. Requester only (enforced in SQL).
 */
governedPolicyRouter.post("/rollback-requests/:id/withdraw", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStatusRevision } = req.body;
    if (expectedStatusRevision === undefined || expectedStatusRevision === null) {
      return res.status(400).json({ error: "expectedStatusRevision is required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_rollback_request:create",
      resource: { type: "policy_rollback", resourceId: id },
    });
    const result = await withdrawRollbackRequest({
      rollbackRequestId: id,
      expectedStatusRevision: Number(expectedStatusRevision),
      principalId,
    });
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to withdraw rollback request");
    res.status(500).json({ error: "Failed to withdraw rollback request" });
  }
});

/**
 * POST /api/policy/rollback-requests/:id/promote
 * Rollback promotion. Body whitelist: expectedStatusRevision, expectedBindingRevision.
 */
governedPolicyRouter.post("/rollback-requests/:id/promote", async (req, res) => {
  try {
    const { id } = req.params;
    const { expectedStatusRevision, expectedBindingRevision } = req.body;
    if (expectedStatusRevision === undefined || expectedStatusRevision === null
        || expectedBindingRevision === undefined || expectedBindingRevision === null) {
      return res.status(400).json({ error: "expectedStatusRevision and expectedBindingRevision are required" });
    }
    const principalId = authoritativePrincipalId(req);
    await observeAuthorize(req, {
      permission: "policy_rollback_request:promote",
      resource: { type: "policy_rollback", resourceId: id },
    });
    const result = await promoteRollbackRequest({
      rollbackRequestId: id,
      expectedStatusRevision: Number(expectedStatusRevision),
      expectedBindingRevision: Number(expectedBindingRevision),
      principalId,
    });
    if (result.outcome === "failed") {
      return res.status(422).json({ error: `Rollback promotion refused: ${result.failureCode}`, ...result });
    }
    res.json({ data: result });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to promote rollback request");
    res.status(500).json({ error: "Failed to promote rollback request" });
  }
});

// ── Read surfaces ───────────────────────────────────────────────────────────

governedPolicyRouter.get("/bindings", async (req, res) => {
  try {
    const { resourceType, resourceId, policyFamily } = req.query;
    await observeAuthorize(req, { permission: "policy_active_binding:read", resource: { type: "policy_definition" } });
    const rows = await getActiveBindings({ resourceType, resourceId, policyFamily });
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list bindings");
    res.status(500).json({ error: "Failed to list bindings" });
  }
});

governedPolicyRouter.get("/promotion-records", async (req, res) => {
  try {
    const { changeRequestId, bindingId } = req.query;
    await observeAuthorize(req, { permission: "policy_promotion_record:read", resource: { type: "policy_definition" } });
    const rows = await getPromotionRecords({ changeRequestId, bindingId });
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list promotion records");
    res.status(500).json({ error: "Failed to list promotion records" });
  }
});

governedPolicyRouter.get("/rollback-requests", async (req, res) => {
  try {
    const { bindingId, status } = req.query;
    await observeAuthorize(req, { permission: "policy_rollback_request:read", resource: { type: "policy_definition" } });
    const rows = await getRollbackRequests({ bindingId, status });
    res.json({ data: rows });
  } catch (err) {
    logger.error({ err: err.message }, "Failed to list rollback requests");
    res.status(500).json({ error: "Failed to list rollback requests" });
  }
});
