// src/services/auth/declarations.js
// D0-04 authorization metadata. This declaration set is maintained separately
// from consequentialSurfaceManifest.js; CI compares the independent sources.

import { declareProtectedSurfaces } from "./protectedSurfaces.js";
import { expectedProtectedSurfaceIdsFromManifest } from "./consequentialSurfaceManifest.js";

const P = Object.freeze({p0: "installation:read", p1: "repository:github:act", p2: "repository:update", p3: "policy_definition:create", p4: "policy_rollout_plan:update", p5: "policy_rollout_plan:approve", p6: "issue:create", p7: "merge_queue_entry:update", p8: "quality_gate:evaluate", p9: "ai_review:create", p10: "issue:update", p11: "ci_run:read", p12: "repair_proposal:read", p13: "patch_artifact:create", p14: "execution_receipt:read", p15: "pull_request:create", p16: "repository:list", p17: "issue:list", p18: "pull_request:list", p19: "decision_log:list", p20: "repair_proposal:list"});
const T = Object.freeze({t0: "fleet", t1: "repository", t2: "policy_definition", t3: "policy_rollout_plan", t4: "installation"});
const V = Object.freeze({r0: "all active installations", r1: "owner/repo -> repositories", r2: "request repo -> policy definition scope", r3: "rollout id -> rollout plan", r4: "runId -> ci_runs -> repository", r5: "owner/repo -> repositories -> installation", r6: "action id -> managed_actions -> repository", r7: "body orphan/live repository names", r8: "body orphan repository name", r9: "jobId -> retained triage payload repository", r10: "body installation_id or repo_filter -> installation", r11: "feedback rule id -> installation", r12: "policy id -> policy_definitions.installation_id", r13: "violation id -> enforcement_violations.repo_id", r14: "optional body.repo -> repository; otherwise fleet", r15: "body.repo_id -> repositories", r16: "waiver id -> waivers.repo_id -> repositories", r17: "duplicate signal id -> repository", r18: "flaky test id -> flaky_tests.repo_id", r19: "vulnerability id -> vulnerability_advisories.repo_id", r20: "requested export date -> audit trail", r21: "requested report period -> audit trail", r22: "trusted webhook installation", r23: "trusted job repository", r24: "trusted CI run repository", r25: "trusted proposal repository", r26: "trusted review repository", r27: "trusted installation job", r28: "trusted maintainer job repository", r29: "trusted issue-fix job repository", r30: "trusted Phase-2 job repository", r31: "trusted Phase-3 job installation", r32: "trusted Phase-4 job repository", r33: "scheduler -> sync worker", r34: "scheduler -> maintainer worker", r35: "scheduler -> Phase-3 worker", r36: "scheduler -> Phase-4 worker", r37: "scheduler -> reconciliation worker", r38: "telegram command target repository", r39: "verified GitHub installation payload"});

const R = (id, permission, resourceType, resolver, mutationIdentity) => ({ id, kind: "route", permission, resourceType, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record", resourceResolver: resolver, mutationIdentity });
const W = (id, kind, permission, resourceType, principalSource, authMethod, resolver, mutationIdentity) => ({ id, kind, permission, resourceType, principalSource, authMethod, observeHandling: "record", resourceResolver: resolver, mutationIdentity });

const ROUTE_SURFACES = [
  R("route:POST:/api/maintainer/members/sync", P.p0, T.t0, V.r0, "maintainer.members.sync"),
  R("route:PUT:/api/maintainer/collaborators/:owner/:repo/:login", P.p1, T.t1, V.r1, "maintainer.collaborator.permission"),
  R("route:DELETE:/api/maintainer/collaborators/:owner/:repo/:login", P.p1, T.t1, V.r1, "maintainer.collaborator.remove"),
  R("route:PUT:/api/maintainer/branch-rules/:owner/:repo/:pattern", P.p1, T.t1, V.r1, "maintainer.branch.protection"),
  R("route:PATCH:/api/maintainer/:owner/:repo/settings", P.p2, T.t1, V.r1, "maintainer.settings.write"),
  R("route:POST:/api/maintainer/:owner/:repo/stale-scan", P.p1, T.t1, V.r1, "maintainer.stale.scan.enqueue"),
  R("route:POST:/api/maintainer/:owner/:repo/branch-cleanup", P.p1, T.t1, V.r1, "maintainer.branch.cleanup.enqueue"),
  R("route:PUT:/api/config/:owner/:repo", P.p2, T.t1, V.r1, "config.override.set"),
  R("route:PATCH:/api/config/:owner/:repo", P.p2, T.t1, V.r1, "config.override.patch"),
  R("route:DELETE:/api/config/:owner/:repo", P.p2, T.t1, V.r1, "config.override.delete"),
  R("route:POST:/api/config/:owner/:repo/restore/:historyId", P.p2, T.t1, V.r1, "config.override.restore"),
  R("route:POST:/api/rollouts", P.p3, T.t2, V.r2, "policy.rollout.create"),
  R("route:PATCH:/api/rollouts/:id/evidence", P.p4, T.t3, V.r3, "policy.rollout.evidence.attach"),
  R("route:POST:/api/rollouts/:id/transition", P.p4, T.t3, V.r3, "policy.rollout.transition"),
  R("route:POST:/api/rollouts/:id/approve", P.p5, T.t3, V.r3, "policy.rollout.approve"),
  R("route:POST:/api/rollouts/:id/reject", P.p5, T.t3, V.r3, "policy.rollout.reject"),
  R("route:POST:/api/rollouts/:id/promote", P.p5, T.t3, V.r3, "policy.rollout.promote"),
  R("route:POST:/api/rollouts/:id/rollback", P.p5, T.t3, V.r3, "policy.rollout.rollback"),
  R("route:POST:/api/ci/:runId/retry", P.p1, T.t1, V.r4, "ci.manual.rerun"),
  R("route:POST:/api/ci/:runId/heal", P.p1, T.t1, V.r4, "ci.manual.heal.enqueue"),
  R("route:POST:/api/fix/:owner/:repo/issues/:number", P.p6, T.t1, V.r1, "issue.fix.enqueue"),
  R("route:POST:/api/repos/:owner/:repo/sync", P.p2, T.t4, V.r5, "repository.sync"),
  R("route:POST:/api/actions/:id/retry", P.p2, T.t0, V.r6, "actions.retry"),
  R("route:POST:/api/actions/:id/cancel", P.p2, T.t0, V.r6, "actions.cancel"),
  R("route:POST:/api/actions/:id/reconcile", P.p2, T.t0, V.r6, "actions.reconcile"),
  R("route:POST:/api/repos/reconcile/merge", P.p2, T.t0, V.r7, "repository.reconcile.merge"),
  R("route:POST:/api/repos/reconcile/discard", P.p2, T.t0, V.r8, "repository.reconcile.discard"),
  R("route:POST:/api/triage/failures/:jobId/disposition", P.p2, T.t1, V.r9, "triage.failure.disposition"),
  R("route:POST:/api/triage/failures/:jobId/retry", P.p2, T.t1, V.r9, "triage.failure.retry"),
  R("route:POST:/api/phase2/queue/:owner/:repo/config", P.p7, T.t1, V.r1, "merge_queue.config.write"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/admit", P.p7, T.t1, V.r1, "merge_queue.admit"),
  R("route:POST:/api/phase2/queue/:owner/:repo/:pr/remove", P.p7, T.t1, V.r1, "merge_queue.remove"),
  R("route:POST:/api/phase2/feedback", P.p2, T.t4, V.r10, "feedback.rule.create"),
  R("route:PUT:/api/phase2/feedback/:id", P.p2, T.t4, V.r11, "feedback.rule.update"),
  R("route:DELETE:/api/phase2/feedback/:id", P.p2, T.t4, V.r11, "feedback.rule.delete"),
  R("route:POST:/api/enforcement/policies", P.p2, T.t4, V.r10, "enforcement.policy.create"),
  R("route:PUT:/api/enforcement/policies/:id", P.p2, T.t4, V.r12, "enforcement.policy.update"),
  R("route:DELETE:/api/enforcement/policies/:id", P.p2, T.t4, V.r12, "enforcement.policy.delete"),
  R("route:POST:/api/enforcement/violations/:id/suppress", P.p2, T.t1, V.r13, "enforcement.violation.suppress"),
  R("route:POST:/api/enforcement/run", P.p1, T.t0, V.r14, "enforcement.run"),
  R("route:POST:/api/gates/:owner/:repo", P.p2, T.t1, V.r1, "quality_gate.definition.upsert"),
  R("route:DELETE:/api/gates/:owner/:repo/:name", P.p2, T.t1, V.r1, "quality_gate.definition.delete"),
  R("route:POST:/api/gates/:owner/:repo/evaluate", P.p8, T.t1, V.r1, "quality_gate.evaluate"),
  R("route:POST:/api/waivers", P.p2, T.t1, V.r15, "waiver.grant"),
  R("route:DELETE:/api/waivers/:id", P.p2, T.t1, V.r16, "waiver.revoke"),
  R("route:POST:/api/duplicates/:id(\\d+)/confirm", P.p1, T.t1, V.r17, "duplicate.confirm"),
  R("route:POST:/api/duplicates/:id(\\d+)/dismiss", P.p2, T.t1, V.r17, "duplicate.dismiss"),
  R("route:POST:/api/duplicates/backfill/:owner/:repo", P.p2, T.t1, V.r1, "duplicate.embedding.backfill"),
  R("route:POST:/api/phase3/flaky/:id/graduate", P.p2, T.t1, V.r18, "flaky_test.graduate"),
  R("route:POST:/api/phase3/flaky/:id/dismiss", P.p2, T.t1, V.r18, "flaky_test.dismiss"),
  R("route:POST:/api/phase3/reconciler/run", P.p0, T.t0, V.r14, "policy.reconciliation.run"),
  R("route:PUT:/api/phase3/reconciler/repos/:owner/:repo", P.p2, T.t1, V.r1, "policy.reconciliation.skip.update"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/scan", P.p2, T.t1, V.r1, "dependency.scan"),
  R("route:POST:/api/phase3/dependencies/:owner/:repo/batch-pr", P.p1, T.t1, V.r1, "dependency.batch_update_pr"),
  R("route:POST:/api/phase3/dependencies/vuln/:id/dismiss", P.p2, T.t1, V.r19, "dependency.vulnerability.dismiss"),
  R("route:POST:/api/review/config/:owner/:repo", P.p9, T.t1, V.r1, "ai_review.config.write"),
  R("route:POST:/api/review/trigger/:owner/:repo/:pr", P.p9, T.t1, V.r1, "ai_review.trigger"),
  R("route:POST:/api/audit/export", P.p0, T.t0, V.r20, "audit.export.generate"),
  R("route:POST:/api/audit/reports", P.p0, T.t0, V.r21, "audit.report.generate"),
  { id: "route:GET:/api/repos", kind: "route", permission: P.p16, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/issues/:owner/:repo", kind: "route", permission: P.p17, resourceType: T.t1, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", permission: P.p18, resourceType: T.t1, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/decisions", kind: "route", permission: P.p19, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
  { id: "route:GET:/api/repairs", kind: "route", permission: P.p20, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" },
];

const RUNTIME_SURFACES = [
  W("worker:webhook", "worker", P.p0, T.t4, "worker-context", "webhook_hmac", V.r22, "webhook.process"),
  W("worker:triage", "worker", P.p10, T.t1, "worker-context", "system", V.r23, "triage.process"),
  W("worker:ciHeal", "worker", P.p1, T.t1, "worker-context", "system", V.r24, "ci_heal.process"),
  W("worker:ciEvidence", "worker", P.p11, T.t1, "worker-context", "system", V.r24, "ci_evidence.collect"),
  W("worker:diagnosis", "worker", P.p12, T.t1, "worker-context", "system", V.r25, "repair.diagnose"),
  W("worker:patch", "worker", P.p13, T.t1, "worker-context", "system", V.r25, "repair.patch"),
  W("worker:verification", "worker", P.p14, T.t1, "worker-context", "system", V.r25, "repair.verify"),
  W("worker:critic", "worker", P.p9, T.t1, "worker-context", "system", V.r26, "review.critic"),
  W("worker:sync", "worker", P.p0, T.t4, "worker-context", "system", V.r27, "repository.sync.worker"),
  W("worker:maintainer", "worker", P.p1, T.t1, "worker-context", "system", V.r28, "maintainer.worker"),
  W("worker:issueFix", "worker", P.p15, T.t1, "worker-context", "system", V.r29, "issue_fix.worker"),
  W("worker:phase2", "worker", P.p7, T.t1, "worker-context", "system", V.r30, "phase2.worker"),
  W("worker:phase3", "worker", P.p0, T.t4, "worker-context", "system", V.r31, "phase3.worker"),
  W("worker:phase4", "worker", P.p9, T.t1, "worker-context", "system", V.r32, "phase4.worker"),
  W("scheduled:sync", "scheduled", P.p0, T.t0, "worker-context", "system", V.r33, "sync.schedule"),
  W("scheduled:maintainer", "scheduled", P.p1, T.t4, "worker-context", "system", V.r34, "maintainer.schedule"),
  W("scheduled:phase3", "scheduled", P.p0, T.t0, "worker-context", "system", V.r35, "phase3.schedule"),
  W("scheduled:phase4", "scheduled", P.p9, T.t0, "worker-context", "system", V.r36, "phase4.schedule"),
  W("scheduled:reconciliation", "scheduled", P.p0, T.t0, "worker-context", "system", V.r37, "reconciliation.schedule"),
  W("telegram:heal", "telegram", P.p1, T.t1, "req.auth", "api_key", V.r38, "telegram.heal"),
  W("telegram:fix", "telegram", P.p6, T.t1, "req.auth", "api_key", V.r38, "telegram.fix"),
  W("webhook:github", "webhook", P.p0, T.t4, "webhook-installation", "webhook_hmac", V.r39, "github.webhook.ingress"),
];

let REGISTERED = false;
export function registerAllProtectedSurfaces() {
  if (REGISTERED) return;
  declareProtectedSurfaces([...ROUTE_SURFACES, ...RUNTIME_SURFACES]);
  REGISTERED = true;
}
export function expectedProtectedSurfaceIds() { return expectedProtectedSurfaceIdsFromManifest(); }
