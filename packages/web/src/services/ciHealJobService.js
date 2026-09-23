// src/services/ciHealJobService.js
// Canonical producer contract for CI healing jobs.
//
// D0-01: every supported trigger source must enqueue the same validated
// `heal-run` payload. The worker continues to receive `{ payload }`, preserving
// the existing automatic-heal behavior while manual/API triggers are normalized
// to the same trusted shape.

import { z } from "zod";

export const CI_HEAL_JOB_SCHEMA_VERSION = 1;
const PG_BIGINT_MAX = 9223372036854775807n;

function isPositivePgBigintString(value) {
  if (!/^[1-9]\d*$/.test(value)) return false;
  try {
    return BigInt(value) <= PG_BIGINT_MAX;
  } catch {
    return false;
  }
}

// GitHub identifiers arrive as JSON numbers on webhook/API responses, while
// PostgreSQL BIGINT/BIGSERIAL values are returned as decimal strings by node-pg
// unless a global type parser is installed. Preserve both losslessly rather
// than coercing DB identifiers through Number().
const githubIdSchema = z.union([
  z.number().int().positive().refine(Number.isSafeInteger, "must be a safe integer"),
  z.string().refine(isPositivePgBigintString, "must be a positive PostgreSQL BIGINT identifier"),
]);

const triggerSchema = z.object({
  kind: z.enum(["webhook", "manual_api", "telegram"]),
  requested_at: z.string().min(1),
  delivery_id: z.string().min(1).optional(),
}).passthrough();

const workflowRunSchema = z.object({
  id: githubIdSchema,
  status: z.literal("completed"),
  conclusion: z.literal("failure"),
  head_branch: z.string().min(1),
  head_sha: z.string().min(7),
}).passthrough();

const repositorySchema = z.object({
  id: githubIdSchema,
  full_name: z.string().min(3),
  name: z.string().min(1),
  owner: z.object({
    login: z.string().min(1),
  }).passthrough(),
}).passthrough();

const installationSchema = z.object({
  id: githubIdSchema,
}).passthrough();

export const ciHealJobSchema = z.object({
  schema_version: z.literal(CI_HEAL_JOB_SCHEMA_VERSION),
  eventName: z.literal("workflow_run"),
  payload: z.object({
    action: z.literal("completed"),
    workflow_run: workflowRunSchema,
    repository: repositorySchema,
    installation: installationSchema,
    sender: z.object({ login: z.string().optional() }).passthrough().optional(),
  }).passthrough(),
  trigger: triggerSchema,
  deliveryId: z.string().optional(),
  receivedAt: z.number().int().nonnegative(),
}).passthrough();

export class InvalidCIHealJobError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "InvalidCIHealJobError";
    this.code = "INVALID_CI_HEAL_JOB";
    this.issues = issues;
  }
}

/** Validate and return the canonical v1 job object. */
export function validateCIHealJob(jobData) {
  const parsed = ciHealJobSchema.safeParse(jobData);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new InvalidCIHealJobError(
      "Invalid CI heal job: " + issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
      issues,
    );
  }
  return parsed.data;
}

/** Build the canonical job from an HMAC-verified workflow_run webhook payload. */
export function buildCIHealJobFromWebhook({ payload, deliveryId, receivedAt = Date.now() }) {
  return validateCIHealJob({
    schema_version: CI_HEAL_JOB_SCHEMA_VERSION,
    eventName: "workflow_run",
    payload,
    deliveryId,
    receivedAt,
    trigger: {
      kind: "webhook",
      requested_at: new Date(receivedAt).toISOString(),
      ...(deliveryId ? { delivery_id: deliveryId } : {}),
    },
  });
}

/**
 * Build the canonical job for a manually requested run.
 *
 * `workflowRun` must be freshly read from GitHub. Repository and installation
 * identity must be server-resolved from GitWire state, never supplied by the
 * caller as authoritative values.
 */
export function buildCIHealJobFromManualRun({
  workflowRun,
  repository,
  installationId,
  triggerKind = "manual_api",
  receivedAt = Date.now(),
}) {
  return validateCIHealJob({
    schema_version: CI_HEAL_JOB_SCHEMA_VERSION,
    eventName: "workflow_run",
    payload: {
      action: "completed",
      workflow_run: workflowRun,
      repository,
      installation: { id: installationId },
    },
    receivedAt,
    trigger: {
      kind: triggerKind,
      requested_at: new Date(receivedAt).toISOString(),
    },
  });
}

/** Validate once more at the queue producer boundary and enqueue `heal-run`. */
export async function enqueueCIHealJob(queue, jobData, options = {}) {
  const validated = validateCIHealJob(jobData);
  return queue.add("heal-run", validated, options);
}
