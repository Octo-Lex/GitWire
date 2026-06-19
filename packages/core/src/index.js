// @gitwire/core — shared types, constants, and utilities
//
// This package is the single source of truth for:
//   - Queue names
//   - Heal/triage status enums
//   - Shared type definitions (JSDoc for now, TypeScript later)
//   - Utility functions used across all packages

// ── Queue names ────────────────────────────────────────────────────────────
export const QUEUES = Object.freeze({
  WEBHOOK_EVENTS: "webhook-events",
  TRIAGE:         "triage",
  CI_HEALING:     "ci-healing",
  CI_EVIDENCE:    "ci-evidence",
  DIAGNOSIS:      "diagnosis",
  PATCH:          "patch",
  SYNC:           "sync",
  MAINTAINER:     "maintainer",
  ISSUE_FIX:      "issue-fix",
  PHASE2:         "phase2",
  PHASE3:         "phase3",
  PHASE4:         "phase4",
});

// ── Heal status ────────────────────────────────────────────────────────────
export const HEAL_STATUS = Object.freeze({
  PENDING:   "pending",
  ATTEMPTED: "attempted",
  HEALED:    "healed",
  FAILED:    "failed",
  SKIPPED:   "skipped",
});

// ── Triage priority ───────────────────────────────────────────────────────
export const TRIAGE_PRIORITY = Object.freeze({
  CRITICAL: "critical",
  HIGH:     "high",
  MEDIUM:   "medium",
  LOW:      "low",
});

// ── CI conclusion ──────────────────────────────────────────────────────────
export const CI_CONCLUSION = Object.freeze({
  SUCCESS:   "success",
  FAILURE:   "failure",
  CANCELLED: "cancelled",
  NEUTRAL:   "neutral",
  TIMED_OUT: "timed_out",
  ACTION_REQUIRED: "action_required",
});

// ── Failure types (from Claude diagnosis) ──────────────────────────────────
export const FAILURE_TYPES = Object.freeze({
  LINT_ERROR:         "lint_error",
  TYPE_ERROR:         "type_error",
  TEST_FLAKY:         "test_flaky",
  TEST_PERMANENT:     "test_permanent",
  DEPENDENCY_MISSING: "dependency_missing",
  FORMAT_ERROR:       "format_error",
  BUILD_ERROR:        "build_error",
  INFRA_ERROR:        "infra_error",
  UNKNOWN:            "unknown",
});

// ── Healable failure types (can be auto-fixed) ────────────────────────────
export const HEALABLE_TYPES = new Set([
  FAILURE_TYPES.LINT_ERROR,
  FAILURE_TYPES.TYPE_ERROR,
  FAILURE_TYPES.TEST_FLAKY,
  FAILURE_TYPES.DEPENDENCY_MISSING,
  FAILURE_TYPES.FORMAT_ERROR,
]);

// ── Package version ────────────────────────────────────────────────────────
export const VERSION = "0.18.0";
