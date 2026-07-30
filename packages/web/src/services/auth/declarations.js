// src/services/auth/declarations.js
//
// Protected-surface declarations for Wave 2 (issue #94).
//
// Registers every protected HTTP route, worker, scheduled task, Telegram
// action, and mutation-producing execution path with the protected-surface
// registry. Each declaration names: required permission, resource type,
// principal source, authentication method, and observe-only handling.
//
// This is the machine-testable source of truth that the protected-surface
// completeness check (issue #94 §5) consults. A surface not declared here
// fails the check.
//
// Wave 2 observes only — every surface's observeHandling is 'record' (the
// authoritative decision is computed and logged, but legacy behavior is not
// globally blocked). Enforcement is Wave 5.

import { declareProtectedSurfaces } from "./protectedSurfaces.js";

// ── HTTP routes (from the route inventory) ──────────────────────────────────
// Permission tokens follow '<resource_type>:<action>' (ADR-0002 vocabulary).
const ROUTE_SURFACES = [
  // maintainer.js — highest-risk: real GitHub mutations (collaborators, branch protection)
  // Corrected to match actual route paths (investigation issue #94):
  //   DELETE collaborators: actual path is /collaborators/:owner/:repo/:login (was /:owner/:repo/collaborators/:username)
  //   PUT branch protection: actual path is /branch-rules/:owner/:repo/:pattern (was /:owner/:repo/branches/:branch/protection)
  { id: "route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // config.js — privileged config changes
  { id: "route:PUT:/api/config/:owner/:repo", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/config/:owner/:repo/restore/:historyId", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // rollouts.js — governed policy mutations
  { id: "route:POST:/api/rollouts", kind: "route", permission: "policy_definition:create", resourceType: "policy_definition", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/transition", kind: "route", permission: "policy_rollout_plan:update", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/approve", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/promote", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/rollback", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // ciRuns.js — direct octokit mutation (rerun)
  { id: "route:POST:/api/ci/:runId/heal", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // fix.js — enqueues issue-fix (trusts req.query.installation_id)
  { id: "route:POST:/api/fix/:owner/:repo/issues/:number", kind: "route", permission: "issue:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // enforcement.js — fire-and-forget GitHub writes
  { id: "route:POST:/api/enforcement/run", kind: "route", permission: "repository:github:act", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // phase2/phase3/phase4 — installation-scoped automation mutations
  // Corrected to match actual route paths:
  //   phase2 admit: actual is /phase2/queue/:owner/:repo/:pr/admit (was /:owner/:repo/admit)
  //   phase3 run: actual is /phase3/reconciler/run (was /run)
  //   review: actual is /review/trigger/:owner/:repo/:pr (was /:owner/:repo/pr/:number; phase4Router mounted at /api)
  { id: "route:POST:/api/phase2/queue/:owner/:repo/:pr/admit", kind: "route", permission: "merge_queue_entry:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/reconciler/run", kind: "route", permission: "installation:read", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/review/trigger/:owner/:repo/:pr", kind: "route", permission: "ai_review:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // repos.js — sync enqueue
  { id: "route:POST:/api/repos/:owner/:repo/sync", kind: "route", permission: "repository:update", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // gates.js — posts check runs
  { id: "route:POST:/api/gates/:owner/:repo/evaluate", kind: "route", permission: "quality_gate:evaluate", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // Read-only routes (still protected — require authenticated principal)
  { id: "route:GET:/api/repos", kind: "route", permission: "repository:list", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/issues/:owner/:repo", kind: "route", permission: "issue:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", permission: "pull_request:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/decisions", kind: "route", permission: "decision_log:list", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/repairs", kind: "route", permission: "repair_proposal:list", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
];

// ── Workers (from the worker inventory) ─────────────────────────────────────
const WORKER_SURFACES = [
  { id: "worker:webhook", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "webhook_hmac", observeHandling: "record" },
  { id: "worker:triage", kind: "worker", permission: "issue:update", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:ciHeal", kind: "worker", permission: "repository:github:act", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:ciEvidence", kind: "worker", permission: "ci_run:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:diagnosis", kind: "worker", permission: "repair_proposal:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:patch", kind: "worker", permission: "patch_artifact:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:verification", kind: "worker", permission: "execution_receipt:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:critic", kind: "worker", permission: "ai_review:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:sync", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:maintainer", kind: "worker", permission: "repository:github:act", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:issueFix", kind: "worker", permission: "pull_request:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:phase2", kind: "worker", permission: "merge_queue_entry:update", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:phase3", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "worker:phase4", kind: "worker", permission: "ai_review:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
];

// ── Scheduled tasks ─────────────────────────────────────────────────────────
const SCHEDULED_SURFACES = [
  { id: "scheduled:sync", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:maintainer", kind: "scheduled", permission: "repository:github:act", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:phase3", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:phase4", kind: "scheduled", permission: "ai_review:create", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:reconciliation", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
];

// ── Telegram + webhook ingress ──────────────────────────────────────────────
const INGRESS_SURFACES = [
  { id: "telegram:heal", kind: "telegram", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "telegram:fix", kind: "telegram", permission: "issue:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "webhook:github", kind: "webhook", permission: "installation:read", resourceType: "installation", principalSource: "webhook-installation", authMethod: "webhook_hmac", observeHandling: "record" },
];

let REGISTERED = false;

/**
 * Register all Wave 2 protected surfaces. Idempotent (guards against
 * double-registration in tests). Throws on any incomplete/duplicate declaration.
 */
export function registerAllProtectedSurfaces() {
  if (REGISTERED) return;
  declareProtectedSurfaces([
    ...ROUTE_SURFACES,
    ...WORKER_SURFACES,
    ...SCHEDULED_SURFACES,
    ...INGRESS_SURFACES,
  ]);
  REGISTERED = true;
}

/**
 * The canonical expected-id list (for the completeness check).
 * @returns {string[]}
 */
export function expectedProtectedSurfaceIds() {
  return [
    ...ROUTE_SURFACES,
    ...WORKER_SURFACES,
    ...SCHEDULED_SURFACES,
    ...INGRESS_SURFACES,
  ].map((s) => s.id);
}
