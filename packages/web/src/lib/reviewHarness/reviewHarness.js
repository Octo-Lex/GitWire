// ReviewHarness — GitWire-owned agent-harness boundary (RI-9 amendment,
// Phase 8).
//
// The smallest stable boundary between GitWire and ANY coding-agent
// harness (the current GitWire loop, Pi, a future alternative):
//
//   ReviewTask  →  harness.runReview(task)  →  ReviewExecution
//
// The types below carry ONLY GitWire-domain values. No Pi session, message,
// tool, or provider type may leak across this boundary — harness-specific
// concepts stay inside their adapter (src/lib/reviewHarness/pi/*).
//
// Authority contract: a harness EXPLORES and SUBMITS. It never mutates
// GitHub, never decides policy, and its submission is data, not a decision.
// GitWire still owns findings → RI-4 validation → verifier → RI-6 policy →
// RI-7 mutation.

export const REVIEW_EXECUTION_STATUSES = Object.freeze(["completed", "incomplete", "error"]);

export const TERMINATION_REASONS = Object.freeze([
  "submitted",
  "no_submission",
  "deadline_exceeded",
  "budget_exceeded",
  "provider_error",
  "invalid_submission",
  "session_error",
]);

export class ReviewHarnessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReviewHarnessError";
    this.code = code;
  }
}

/**
 * Validate a ReviewTask. Required fields:
 *   reviewInvocationId, repositorySessionId — identity binding
 *   repository {owner, name} — repository identity (label only)
 *   baseSha, headSha — immutable review range
 *   reviewRoot — the ReviewEvidence root this run is bound to
 *   objective — the review objective text shown to the agent
 *   findingSchema {name, version} — the expected structured-result schema
 *   deadlineMs — wall-clock budget for the whole execution
 *   budget — {maxTotalTokens?, maxCostUsd?, maxToolCalls?}
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateReviewTask(task) {
  const errors = [];
  const t = task ?? {};
  for (const field of ["reviewInvocationId", "repositorySessionId"]) {
    if (typeof t[field] !== "string" || t[field].length === 0) {
      errors.push(`missing ${field}`);
    }
  }
  if (!t.repository || typeof t.repository.owner !== "string" || typeof t.repository.name !== "string") {
    errors.push("repository {owner, name} is required");
  }
  for (const field of ["baseSha", "headSha"]) {
    if (typeof t[field] !== "string" || t[field].length === 0) {
      errors.push(`missing ${field}`);
    }
  }
  if (!t.reviewRoot || typeof t.reviewRoot !== "object") {
    errors.push("reviewRoot is required");
  }
  if (typeof t.objective !== "string" || t.objective.length === 0) {
    errors.push("objective is required");
  }
  if (!t.findingSchema || typeof t.findingSchema.name !== "string" || typeof t.findingSchema.version !== "string") {
    errors.push("findingSchema {name, version} is required");
  }
  if (!Number.isInteger(t.deadlineMs) || t.deadlineMs < 1) {
    errors.push("deadlineMs must be a positive integer");
  }
  if (!t.budget || typeof t.budget !== "object") {
    errors.push("budget is required");
  } else {
    for (const key of ["maxTotalTokens", "maxCostUsd", "maxToolCalls"]) {
      const v = t.budget[key];
      if (v !== undefined && (!Number.isFinite(v) || v < 0)) {
        errors.push(`budget.${key} must be a non-negative number`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Build a frozen ReviewExecution record with mechanical invariants:
 *   completed  ⇒ submission captured, terminationReason "submitted"
 *   incomplete ⇒ terminationReason set, no submission treated as valid
 *   error      ⇒ error {code, message} present, no submission
 */
export function makeReviewExecution(fields) {
  const {
    status,
    requestedHarness,
    actualHarness,
    requestedProvider,
    actualProvider,
    requestedModel,
    actualModel,
    startedAt,
    completedAt,
    durationMs,
    toolTrace = [],
    submission,
    usage = null,
    terminationReason,
    error,
    submissionDiagnostics,
  } = fields ?? {};

  if (!REVIEW_EXECUTION_STATUSES.includes(status)) {
    throw new ReviewHarnessError("E_INVALID_EXECUTION", `unknown status: ${status}`);
  }
  for (const reason of terminationReason ? [terminationReason] : []) {
    if (!TERMINATION_REASONS.includes(reason)) {
      throw new ReviewHarnessError("E_INVALID_EXECUTION", `unknown terminationReason: ${reason}`);
    }
  }
  if (status === "completed") {
    if (submission === undefined) {
      throw new ReviewHarnessError("E_INVALID_EXECUTION", "completed execution requires a submission");
    }
    if (terminationReason !== "submitted") {
      throw new ReviewHarnessError("E_INVALID_EXECUTION", "completed execution must terminate via submitted");
    }
  }
  if (status === "incomplete" && !terminationReason) {
    throw new ReviewHarnessError("E_INVALID_EXECUTION", "incomplete execution requires a terminationReason");
  }
  if (status === "error") {
    if (!error || typeof error.code !== "string") {
      throw new ReviewHarnessError("E_INVALID_EXECUTION", "error execution requires error.code");
    }
    if (submission !== undefined) {
      throw new ReviewHarnessError("E_INVALID_EXECUTION", "error execution must not carry a submission");
    }
  }
  if (status !== "completed" && terminationReason === "submitted") {
    throw new ReviewHarnessError("E_INVALID_EXECUTION", "terminationReason submitted requires status completed");
  }

  const execution = Object.freeze({
    status,
    requestedHarness,
    actualHarness,
    requestedProvider,
    actualProvider,
    requestedModel,
    actualModel,
    startedAt,
    completedAt,
    durationMs,
    toolTrace: Object.freeze([...toolTrace]),
    ...(submission !== undefined ? { submission } : {}),
    usage,
    ...(terminationReason ? { terminationReason } : {}),
    ...(error ? { error } : {}),
    ...(submissionDiagnostics ? { submissionDiagnostics } : {}),
  });
  return execution;
}

/**
 * A harness registry: GitWire code looks harnesses up by name and never
 * imports an adapter directly.
 */
export function createReviewHarnessRegistry() {
  const harnesses = new Map();
  return {
    register(harness) {
      if (!harness || typeof harness.name !== "string" || typeof harness.runReview !== "function") {
        throw new ReviewHarnessError("E_INVALID_HARNESS", "harness requires name and runReview");
      }
      harnesses.set(harness.name, harness);
      return harness;
    },
    get(name) {
      return harnesses.get(name) ?? null;
    },
    names() {
      return [...harnesses.keys()];
    },
  };
}
