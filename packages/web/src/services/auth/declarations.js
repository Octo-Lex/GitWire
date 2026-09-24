// src/services/auth/declarations.js
//
// Protected-surface declarations for Wave 2 (issue #94) + D0-04 completeness.
//
// Authorization metadata lives here. The independent inventory of actual
// consequential mutation surfaces lives in consequentialSurfaceManifest.js;
// expectedProtectedSurfaceIds() is derived from that inventory, never from the
// declaration arrays below.
//
// Wave 2 observes only — every surface's observeHandling is 'record' (the
// authoritative decision is computed and logged, but legacy behavior is not
// globally blocked). D0-04 does not change those runtime semantics.

import { declareProtectedSurfaces } from "./protectedSurfaces.js";
import { expectedConsequentialSurfaceIds } from "./consequentialSurfaceManifest.js";

// ── HTTP routes ──────────────────────────────────────────────────────────────
const ROUTE_SURFACES = [
  // maintainer.js
  { id: "route:POST:/api/maintainer/members/sync", kind: "route", permission: "installation:read", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PUT:/api/maintainer/collaborators/:owner/:repo/:login", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PATCH:/api/maintainer/:owner/:repo/settings", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/maintainer/:owner/:repo/stale-scan", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/maintainer/:owner/:repo/branch-cleanup", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // config.js
  { id: "route:PUT:/api/config/:owner/:repo", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/config/:owner/:repo/restore/:historyId", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // rollouts.js
  { id: "route:POST:/api/rollouts", kind: "route", permission: "policy_definition:create", resourceType: "policy_definition", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/transition", kind: "route", permission: "policy_rollout_plan:update", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/approve", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/promote", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/rollouts/:id/rollback", kind: "route", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // ciRuns.js / fix.js / orchestration
  { id: "route:POST:/api/ci/:runId/heal", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/fix/:owner/:repo/issues/:number", kind: "route", permission: "issue:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/enforcement/run", kind: "route", permission: "repository:github:act", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase2/queue/:owner/:repo/:pr/admit", kind: "route", permission: "merge_queue_entry:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/reconciler/run", kind: "route", permission: "installation:read", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/review/trigger/:owner/:repo/:pr", kind: "route", permission: "ai_review:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/repos/:owner/:repo/sync", kind: "route", permission: "repository:update", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // waivers.js
  { id: "route:POST:/api/waivers", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:DELETE:/api/waivers/:id", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // duplicates.js
  { id: "route:POST:/api/duplicates/:id(\\d+)/confirm", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/duplicates/:id(\\d+)/dismiss", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/duplicates/backfill/:owner/:repo", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // gates.js
  { id: "route:POST:/api/gates/:owner/:repo", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:DELETE:/api/gates/:owner/:repo/:name", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/gates/:owner/:repo/evaluate", kind: "route", permission: "quality_gate:evaluate", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // enforcement.js
  { id: "route:POST:/api/enforcement/policies", kind: "route", permission: "repository:update", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PUT:/api/enforcement/policies/:id", kind: "route", permission: "repository:update", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:DELETE:/api/enforcement/policies/:id", kind: "route", permission: "repository:update", resourceType: "installation", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/enforcement/violations/:id/suppress", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // phase3.js
  { id: "route:POST:/api/phase3/flaky/:id/graduate", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/flaky/:id/dismiss", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:PUT:/api/phase3/reconciler/repos/:owner/:repo", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/dependencies/:owner/:repo/scan", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr", kind: "route", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:POST:/api/phase3/dependencies/vuln/:id/dismiss", kind: "route", permission: "repository:update", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },

  // Read-only protected surfaces remain declared but are not part of the
  // consequential mutation manifest.
  { id: "route:GET:/api/repos", kind: "route", permission: "repository:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/issues/:owner/:repo", kind: "route", permission: "issue:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", permission: "pull_request:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/decisions", kind: "route", permission: "decision_log:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/repairs", kind: "route", permission: "repair_proposal:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
];

// ── Workers ─────────────────────────────────────────────────────────────────
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

export function expectedProtectedSurfaceIds() {
  return expectedConsequentialSurfaceIds();
}
