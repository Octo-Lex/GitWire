// src/services/auth/declarations.js
// Protected-surface authorization metadata. D0-04 keeps this declaration
// inventory separate from the source-derived surface manifest so completeness
// is no longer declaration-self-consistent.

import { declareProtectedSurfaces } from "./protectedSurfaces.js";
import { expectedProtectedSurfaceIdsFromManifest } from "./consequentialSurfaceManifest.js";

const R = (id, permission, resourceType, resourceResolver, mutationIdentity) => ({
  id, kind: "route", permission, resourceType, principalSource: "req.auth",
  authMethod: "api_key", observeHandling: "record", resourceResolver, mutationIdentity,
});

const ROUTE_SURFACES = [
  R("route:POST:/api/maintainer/members/sync", "installation:read", "fleet", "all active installations", "maintainer.members.sync"),
  R("route:PUT:/api/maintainer/collaborators/:owner/:repo/:login", "repository:github:act", "repository", "owner/repo -> repositories", "maintainer.collaborator.permission"),
  R("route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login", "repository:github:act", "repository", "owner/repo -> repositories", "maintainer.collaborator.remove"),
  R("route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern", "repository:github:act", "repository", "owner/repo -> repositories", "maintainer.branch_protection"),
  R("route:PATCH:/api/maintainer/:owner/:repo/settings", "repository:update", "repository", "owner/repo -> repositories", "maintainer.settings.write"),
  R("route:POST:/api/maintainer/:owner/:repo/stale-scan", "repository:github:act", "repository", "owner/repo -> repositories", "maintainer.stale_scan.enqueue"),
  R("route:POST:/api/maintainer/:owner/:repo/branch-cleanup", "repository:github:act", "repository", "owner/repo -> repositories", "maintainer.branch_cleanup.enqueue"),
  R("route:PUT:/api/config/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "config.override.set"),
  R("route:PATCH:/api/config/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "config.override.patch"),
  R("route:DELETE:/api/config/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "config.override.delete"),
  R("route:POST:/api/config/:owner/:repo/restore/:historyId", "repository:update", "repository", "owner/repo -> repositories", "config.override.restore"),
  R("route:POST:/api/rollouts", "policy_definition:create", "policy_definition", "request policy definition -> installation scope", "policy.rollout.create"),
  R("route:PATCH:/api/rollouts/:id/evidence", "policy_rollout_plan:update", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.evidence.attach"),
  R("route:POST:/api/rollouts/:id/transition", "policy_rollout_plan:update", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.transition"),
  R("route:POST:/api/rollouts/:id/approve", "policy_rollout_plan:approve", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.approve"),
  R("route:POST:/api/rollouts/:id/reject", "policy_rollout_plan:approve", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.reject"),
  R("route:POST:/api/rollouts/:id/promote", "policy_rollout_plan:approve", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.promote"),
  R("route:POST:/api/rollouts/:id/rollback", "policy_rollout_plan:approve", "policy_rollout_plan", "rollout id -> rollout plan", "policy.rollout.rollback"),
  R("route:POST:/api/ci/:runId/retry", "repository:github:act", "repository", "runId -> ci_runs -> repository", "ci.manual.rerun"),
  R("route:POST:/api/ci/:runId/heal", "repository:github:act", "repository", "runId -> ci_runs -> repository", "ci.manual.heal.enqueue"),
  R("route:POST:/api/fix/:owner/:repo/issues/:number", "issue:create", "repository", "owner/repo -> repositories", "issue_fix.enqueue"),
  R("route:POST:/api/repos/:owner/:repo/sync", "repository:update", "installation", "owner/repo -> repositories -> installation", "repository.sync"),
  R("route:POST:/api/actions/:id/retry", "repository:update", "repository", "managed action id -> repository", "actions.retry"),
  R("route:POST:/api/actions/:id/cancel", "repository:update", "repository", "managed action id -> repository", "actions.cancel"),
  R("route:POST:/api/actions/:id/reconcile", "repository:update", "repository", "managed action id -> repository", "actions.reconcile"),
  R("route:POST:/api/repos/reconcile/merge", "repository:update", "repository", "body orphan/live -> repositories", "repository.transfer.merge"),
  R("route:POST:/api/repos/reconcile/discard", "repository:update", "repository", "body orphan -> repositories", "repository.transfer.discard"),
  R("route:POST:/api/triage/failures/:jobId/disposition", "repository:update", "repository", "retained triage job -> authoritative repository IDs", "triage.failure.disposition"),
  R("route:POST:/api/triage/failures/:jobId/retry", "repository:update", "repository", "retained triage job -> authoritative repository IDs", "triage.failure.retry"),
  R("route:POST:/api/phase2/queue/:owner/:repo/config", "repository:update", "repository", "owner/repo -> repositories", "merge_queue.config.write"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/admit", "merge_queue_entry:update", "repository", "owner/repo -> repositories", "merge_queue.admit"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/remove", "merge_queue_entry:update", "repository", "owner/repo -> repositories", "merge_queue.remove"),
  R("route:POST:/api/phase2/feedback", "repository:update", "installation", "body.installation_id or repo_filter -> installation", "feedback.rule.create"),
  R("route:PUT:/api/phase2/feedback/:id", "repository:update", "installation", "feedback rule id -> installation", "feedback.rule.update"),
  R("route:DELETE:/api/phase2/feedback/:id", "repository:update", "installation", "feedback rule id -> installation", "feedback.rule.delete"),
  R("route:POST:/api/enforcement/policies", "repository:update", "installation", "body.installation_id or repo_filter -> installation", "enforcement.policy.create"),
  R("route:PUT:/api/enforcement/policies/:id", "repository:update", "installation", "policy id -> policy_definitions.installation_id", "enforcement.policy.update"),
  R("route:DELETE:/api/enforcement/policies/:id", "repository:update", "installation", "policy id -> policy_definitions.installation_id", "enforcement.policy.delete"),
  R("route:POST:/api/enforcement/violations/:id/suppress", "repository:update", "repository", "violation id -> enforcement_violations.repo_id", "enforcement.violation.suppress"),
  R("route:POST:/api/enforcement/run", "repository:github:act", "fleet", "optional body.repo -> repository; otherwise fleet", "enforcement.run"),
  R("route:POST:/api/gates/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "quality_gate.definition.upsert"),
  R("route:DELETE:/api/gates/:owner/:repo/:name", "repository:update", "repository", "owner/repo -> repositories", "quality_gate.definition.delete"),
  R("route:POST:/api/gates/:owner/:repo/evaluate", "quality_gate:evaluate", "repository", "owner/repo -> repositories", "quality_gate.evaluate"),
  R("route:POST:/api/waivers", "repository:update", "repository", "body.repo_id -> repositories", "waivers.grant"),
  R("route:DELETE:/api/waivers/:id", "repository:update", "repository", "waiver id -> waivers.repo_id -> repositories", "waivers.revoke"),
  R("route:POST:/api/duplicates/:id(\\d+)/confirm", "repository:github:act", "repository", "duplicate signal id -> repository", "duplicates.confirm"),
  R("route:POST:/api/duplicates/:id(\\d+)/dismiss", "repository:update", "repository", "duplicate signal id -> repository", "duplicates.dismiss"),
  R("route:POST:/api/duplicates/backfill/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "duplicates.embedding_backfill"),
  R("route:POST:/api/phase3/flaky/:id/graduate", "repository:update", "repository", "flaky test id -> flaky_tests.repo_id", "flaky.graduate"),
  R("route:POST:/api/phase3/flaky/:id/dismiss", "repository:update", "repository", "flaky test id -> flaky_tests.repo_id", "flaky.dismiss"),
  R("route:POST:/api/phase3/reconciler/run", "installation:read", "fleet", "optional body.repo -> repository; otherwise fleet", "policy_reconciler.run"),
  R("route:PUT:/api/phase3/reconciler/repos/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "policy_reconciler.skip.write"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/scan", "repository:update", "repository", "owner/repo -> repositories", "dependency.scan"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr", "repository:github:act", "repository", "owner/repo -> repositories", "dependency.update_pr"),
  R("route:POST:/api/phase3/dependencies/vuln/:id/dismiss", "repository:update", "repository", "vulnerability id -> vulnerability_advisories.repo_id", "dependency.vulnerability.dismiss"),
  R("route:POST:/api/review/config/:owner/:repo", "repository:update", "repository", "owner/repo -> repositories", "ai_review.config.write"),
  R("route:POST:/api/review/trigger/:owner/:repo/:pr", "ai_review:create", "repository", "owner/repo -> repositories", "ai_review.enqueue"),
  R("route:POST:/api/audit/export", "decision_log:list", "fleet", "audit export scope", "audit.export.generate"),
  R("route:POST:/api/audit/reports", "decision_log:list", "fleet", "audit report scope", "audit.report.generate"),
  { id: "route:GET:/api/repos", kind: "route", permission: "repository:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/issues/:owner/:repo", kind: "route", permission: "issue:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", permission: "pull_request:list", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/decisions", kind: "route", permission: "decision_log:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/repairs", kind: "route", permission: "repair_proposal:list", resourceType: "fleet", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
];

const WORKER_SURFACES = [
  { id: "worker:webhook", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "webhook_hmac", observeHandling: "record", resourceResolver: "trusted webhook installation", mutationIdentity: "webhook.process" },
  { id: "worker:triage", kind: "worker", permission: "issue:update", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted job repository", mutationIdentity: "triage.process" },
  { id: "worker:ciHeal", kind: "worker", permission: "repository:github:act", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted CI run repository", mutationIdentity: "ci_heal.process" },
  { id: "worker:ciEvidence", kind: "worker", permission: "ci_run:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted CI run repository", mutationIdentity: "ci_evidence.persist" },
  { id: "worker:diagnosis", kind: "worker", permission: "repair_proposal:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "repair job repository", mutationIdentity: "diagnosis.persist" },
  { id: "worker:patch", kind: "worker", permission: "patch_artifact:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "repair job repository", mutationIdentity: "patch.create" },
  { id: "worker:verification", kind: "worker", permission: "execution_receipt:read", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "repair job repository", mutationIdentity: "verification.persist" },
  { id: "worker:critic", kind: "worker", permission: "ai_review:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted PR repository", mutationIdentity: "critic.review" },
  { id: "worker:sync", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted installation", mutationIdentity: "repository.sync" },
  { id: "worker:maintainer", kind: "worker", permission: "repository:github:act", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted maintainer job repository", mutationIdentity: "maintainer.process" },
  { id: "worker:issueFix", kind: "worker", permission: "pull_request:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted issue-fix repository", mutationIdentity: "issue_fix.process" },
  { id: "worker:phase2", kind: "worker", permission: "merge_queue_entry:update", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted merge-queue repository", mutationIdentity: "phase2.process" },
  { id: "worker:phase3", kind: "worker", permission: "installation:read", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted phase3 installation", mutationIdentity: "phase3.process" },
  { id: "worker:phase4", kind: "worker", permission: "ai_review:create", resourceType: "repository", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "trusted review repository", mutationIdentity: "phase4.process" },
];

const SCHEDULED_SURFACES = [
  { id: "scheduled:sync", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "scheduler enumerates installations", mutationIdentity: "scheduled.sync" },
  { id: "scheduled:maintainer", kind: "scheduled", permission: "repository:github:act", resourceType: "installation", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "scheduler installation scope", mutationIdentity: "scheduled.maintainer" },
  { id: "scheduled:phase3", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.phase3" },
  { id: "scheduled:phase4", kind: "scheduled", permission: "ai_review:create", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.phase4" },
  { id: "scheduled:reconciliation", kind: "scheduled", permission: "installation:read", resourceType: "fleet", principalSource: "worker-context", authMethod: "system", observeHandling: "record", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.reconciliation" },
];

const INGRESS_SURFACES = [
  { id: "telegram:heal", kind: "telegram", permission: "repository:github:act", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record", resourceResolver: "command run -> repository", mutationIdentity: "telegram.heal" },
  { id: "telegram:fix", kind: "telegram", permission: "issue:create", resourceType: "repository", principalSource: "req.auth", authMethod: "api_key", observeHandling: "record", resourceResolver: "command issue -> repository", mutationIdentity: "telegram.fix" },
  { id: "webhook:github", kind: "webhook", permission: "installation:read", resourceType: "installation", principalSource: "webhook-installation", authMethod: "webhook_hmac", observeHandling: "record", resourceResolver: "verified webhook installation", mutationIdentity: "github.webhook.ingress" },
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
