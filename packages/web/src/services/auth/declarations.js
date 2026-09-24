// src/services/auth/declarations.js
// Protected-surface authorization metadata. D0-04 keeps this declaration
// inventory separate from the source-derived surface manifest so completeness
// is no longer declaration-self-consistent.

import { declareProtectedSurfaces } from "./protectedSurfaces.js";
import { expectedProtectedSurfaceIdsFromManifest } from "./consequentialSurfaceManifest.js";

const R = (id, permission, resourceType) => ({ id, kind: "route", permission, resourceType, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" });

const ROUTE_SURFACES = [
  R("route:POST:/api/maintainer/members/sync", "installation:read", "fleet"),
  R("route:PUT:/api/maintainer/collaborators/:owner/:repo/:login", "repository:github:act", "repository"),
  R("route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login", "repository:github:act", "repository"),
  R("route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern", "repository:github:act", "repository"),
  R("route:PATCH:/api/maintainer/:owner/:repo/settings", "repository:update", "repository"),
  R("route:POST:/api/maintainer/:owner/:repo/stale-scan", "repository:github:act", "repository"),
  R("route:POST:/api/maintainer/:owner/:repo/branch-cleanup", "repository:github:act", "repository"),

  R("route:PUT:/api/config/:owner/:repo", "repository:update", "repository"),
  R("route:PATCH:/api/config/:owner/:repo", "repository:update", "repository"),
  R("route:DELETE:/api/config/:owner/:repo", "repository:update", "repository"),
  R("route:POST:/api/config/:owner/:repo/restore/:historyId", "repository:update", "repository"),

  R("route:POST:/api/rollouts", "policy_definition:create", "policy_definition"),
  R("route:PATCH:/api/rollouts/:id/evidence", "policy_rollout_plan:update", "policy_rollout_plan"),
  R("route:POST:/api/rollouts/:id/transition", "policy_rollout_plan:update", "policy_rollout_plan"),
  R("route:POST:/api/rollouts/:id/approve", "policy_rollout_plan:approve", "policy_rollout_plan"),
  R("route:POST:/api/rollouts/:id/reject", "policy_rollout_plan:approve", "policy_rollout_plan"),
  R("route:POST:/api/rollouts/:id/promote", "policy_rollout_plan:approve", "policy_rollout_plan"),
  R("route:POST:/api/rollouts/:id/rollback", "policy_rollout_plan:approve", "policy_rollout_plan"),

  R("route:POST:/api/ci/:runId/retry", "repository:github:act", "repository"),
  R("route:POST:/api/ci/:runId/heal", "repository:github:act", "repository"),
  R("route:POST:/api/fix/:owner/:repo/issues/:number", "issue:create", "repository"),

  R("route:POST:/api/actions/:id/retry", "repository:update", "repository"),
  R("route:POST:/api/actions/:id/cancel", "repository:update", "repository"),
  R("route:POST:/api/actions/:id/reconcile", "repository:update", "repository"),

  R("route:POST:/api/phase2/queue/:owner/:repo/config", "repository:update", "repository"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/admit", "merge_queue_entry:update", "repository"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/remove", "merge_queue_entry:update", "repository"),
  R("route:POST:/api/phase2/feedback", "repository:update", "installation"),
  R("route:PUT:/api/phase2/feedback/:id", "repository:update", "installation"),
  R("route:DELETE:/api/phase2/feedback/:id", "repository:update", "installation"),

  R("route:POST:/api/enforcement/run", "repository:github:act", "fleet"),
  R("route:POST:/api/enforcement/policies", "repository:update", "installation"),
  R("route:PUT:/api/enforcement/policies/:id", "repository:update", "installation"),
  R("route:DELETE:/api/enforcement/policies/:id", "repository:update", "installation"),
  R("route:POST:/api/enforcement/violations/:id/suppress", "repository:update", "repository"),

  R("route:POST:/api/duplicates/:id(\\d+)/confirm", "repository:github:act", "repository"),
  R("route:POST:/api/duplicates/:id(\\d+)/dismiss", "repository:update", "repository"),
  R("route:POST:/api/duplicates/backfill/:owner/:repo", "repository:update", "repository"),

  R("route:POST:/api/gates/:owner/:repo", "repository:update", "repository"),
  R("route:DELETE:/api/gates/:owner/:repo/:name", "repository:update", "repository"),
  R("route:POST:/api/gates/:owner/:repo/evaluate", "quality_gate:evaluate", "repository"),

  R("route:POST:/api/phase3/flaky/:id/graduate", "repository:update", "repository"),
  R("route:POST:/api/phase3/flaky/:id/dismiss", "repository:update", "repository"),
  R("route:POST:/api/phase3/reconciler/run", "installation:read", "fleet"),
  R("route:PUT:/api/phase3/reconciler/repos/:owner/:repo", "repository:update", "repository"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/scan", "repository:update", "repository"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr", "repository:github:act", "repository"),
  R("route:POST:/api/phase3/dependencies/vuln/:id/dismiss", "repository:update", "repository"),

  R("route:POST:/api/review/config/:owner/:repo", "repository:update", "repository"),
  R("route:POST:/api/review/trigger/:owner/:repo/:pr", "ai_review:create", "repository"),
  R("route:POST:/api/audit/export", "decision_log:list", "fleet"),
  R("route:POST:/api/audit/reports", "decision_log:list", "fleet"),

  R("route:POST:/api/repos/:owner/:repo/sync", "repository:update", "installation"),
  R("route:POST:/api/repos/reconcile/merge", "repository:update", "repository"),
  R("route:POST:/api/repos/reconcile/discard", "repository:update", "repository"),

  R("route:POST:/api/triage/failures/:jobId/disposition", "repository:update", "repository"),
  R("route:POST:/api/triage/failures/:jobId/retry", "repository:update", "repository"),

  R("route:POST:/api/waivers", "repository:update", "repository"),
  R("route:DELETE:/api/waivers/:id", "repository:update", "repository"),

  // Existing read-only protected surfaces remain part of completeness.
  R("route:GET:/api/repos", "repository:list", "fleet"),
  R("route:GET:/api/issues/:owner/:repo", "issue:list", "repository"),
  R("route:GET:/api/pull-requests/:owner/:repo", "pull_request:list", "repository"),
  R("route:GET:/api/decisions", "decision_log:list", "fleet"),
  R("route:GET:/api/repairs", "repair_proposal:list", "fleet"),
];

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

const SCHEDULED_SURFACES = [
  { id: "scheduled:sync", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:maintainer", kind: "scheduled", permission: "repository:github:act", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:phase3", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:phase4", kind: "scheduled", permission: "ai_review:create", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
  { id: "scheduled:reconciliation", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record" },
];

const INGRESS_SURFACES = [
  { id: "telegram:heal", kind: "telegram", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "telegram:fix", kind: "telegram", permission: "issue:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "webhook:github", kind: "webhook", permission: "installation:read", resourceType: "installation", principalSource: "webhook-installation", authMethod: "webhook_hmac", observeHandling: "record" },
];

let REGISTERED = false;

export function registerAllProtectedSurfaces() {
  if (REGISTERED) return;
  declareProtectedSurfaces([...ROUTE_SURFACES, ...WORKER_SURFACES, ...SCHEDULED_SURFACES, ...INGRESS_SURFACES]);
  REGISTERED = true;
}

export function expectedProtectedSurfaceIds() {
  return expectedProtectedSurfaceIdsFromManifest();
}
