// src/services/auth/consequentialSurfaceManifest.js
// D0-04: independent inventory of actual consequential entry points.
// Keep this file independent from authorization declarations.

const S = Object.freeze({s0: "src/routes/maintainer.js", s1: "src/routes/config.js", s2: "src/routes/rollouts.js", s3: "src/routes/ciRuns.js", s4: "src/routes/fix.js", s5: "src/routes/repos.js", s6: "src/routes/actions.js", s7: "src/routes/transfers.js", s8: "src/routes/triageOperations.js", s9: "src/routes/phase2.js", s10: "src/routes/enforcement.js", s11: "src/routes/gates.js", s12: "src/routes/waivers.js", s13: "src/routes/duplicates.js", s14: "src/routes/phase3.js", s15: "src/routes/phase4.js"});
const P = Object.freeze({p0: "installation:read", p1: "repository:github:act", p2: "repository:update", p3: "policy_definition:create", p4: "policy_rollout_plan:update", p5: "policy_rollout_plan:approve", p6: "issue:create", p7: "merge_queue_entry:update", p8: "quality_gate:evaluate", p9: "ai_review:create", p10: "issue:update", p11: "ci_run:read", p12: "repair_proposal:read", p13: "patch_artifact:create", p14: "execution_receipt:read", p15: "pull_request:create", p16: "repository:list", p17: "issue:list", p18: "pull_request:list", p19: "decision_log:list", p20: "repair_proposal:list"});
const T = Object.freeze({t0: "fleet", t1: "repository", t2: "policy_definition", t3: "policy_rollout_plan", t4: "installation"});
const V = Object.freeze({r0: "all active installations", r1: "owner/repo -> repositories", r2: "request repo -> policy definition scope", r3: "rollout id -> rollout plan", r4: "runId -> ci_runs -> repository", r5: "owner/repo -> repositories -> installation", r6: "action id -> managed_actions -> repository", r7: "body orphan/live repository names", r8: "body orphan repository name", r9: "jobId -> retained triage payload repository", r10: "body installation_id or repo_filter -> installation", r11: "feedback rule id -> installation", r12: "policy id -> policy_definitions.installation_id", r13: "violation id -> enforcement_violations.repo_id", r14: "optional body.repo -> repository; otherwise fleet", r15: "body.repo_id -> repositories", r16: "waiver id -> waivers.repo_id -> repositories", r17: "duplicate signal id -> repository", r18: "flaky test id -> flaky_tests.repo_id", r19: "vulnerability id -> vulnerability_advisories.repo_id", r20: "requested export date -> audit trail", r21: "requested report period -> audit trail", r22: "trusted webhook installation", r23: "trusted job repository", r24: "trusted CI run repository", r25: "trusted proposal repository", r26: "trusted review repository", r27: "trusted installation job", r28: "trusted maintainer job repository", r29: "trusted issue-fix job repository", r30: "trusted Phase-2 job repository", r31: "trusted Phase-3 job installation", r32: "trusted Phase-4 job repository", r33: "scheduler -> sync worker", r34: "scheduler -> maintainer worker", r35: "scheduler -> Phase-3 worker", r36: "scheduler -> Phase-4 worker", r37: "scheduler -> reconciliation worker", r38: "telegram command target repository", r39: "verified GitHub installation payload"});

const route = (method, mount, path, source, permission, resourceType, resolver, mutationIdentity) => Object.freeze({
  surfaceId: `route:${method}:${path === "/" ? mount : mount.replace(/\/$/, "") + path}`, kind: "route", method, mountPath: mount, routePath: path,
  sourcePath: source, permission, resourceType, resourceResolver: resolver, mutationIdentity, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record",
});
const runtime = (surfaceId, kind, permission, resourceType, principalSource, authMethod, resolver, mutationIdentity, sourceIdentity) => Object.freeze({
  surfaceId, kind, permission, resourceType, principalSource, authMethod, observeHandling: "record", resourceResolver: resolver, mutationIdentity, sourceIdentity,
});

export const CONSEQUENTIAL_SURFACE_MANIFEST = Object.freeze([
  route("POST", "/api/maintainer", "/members/sync", S.s0, P.p0, T.t0, V.r0, "maintainer.members.sync"),
  route("PUT", "/api/maintainer", "/collaborators/:owner/:repo/:login", S.s0, P.p1, T.t1, V.r1, "maintainer.collaborator.permission"),
  route("DELETE", "/api/maintainer", "/collaborators/:owner/:repo/:login", S.s0, P.p1, T.t1, V.r1, "maintainer.collaborator.remove"),
  route("PUT", "/api/maintainer", "/branch-rules/:owner/:repo/:pattern", S.s0, P.p1, T.t1, V.r1, "maintainer.branch.protection"),
  route("PATCH", "/api/maintainer", "/:owner/:repo/settings", S.s0, P.p2, T.t1, V.r1, "maintainer.settings.write"),
  route("POST", "/api/maintainer", "/:owner/:repo/stale-scan", S.s0, P.p1, T.t1, V.r1, "maintainer.stale.scan.enqueue"),
  route("POST", "/api/maintainer", "/:owner/:repo/branch-cleanup", S.s0, P.p1, T.t1, V.r1, "maintainer.branch.cleanup.enqueue"),
  route("PUT", "/api/config", "/:owner/:repo", S.s1, P.p2, T.t1, V.r1, "config.override.set"),
  route("PATCH", "/api/config", "/:owner/:repo", S.s1, P.p2, T.t1, V.r1, "config.override.patch"),
  route("DELETE", "/api/config", "/:owner/:repo", S.s1, P.p2, T.t1, V.r1, "config.override.delete"),
  route("POST", "/api/config", "/:owner/:repo/restore/:historyId", S.s1, P.p2, T.t1, V.r1, "config.override.restore"),
  route("POST", "/api/rollouts", "/", S.s2, P.p3, T.t2, V.r2, "policy.rollout.create"),
  route("PATCH", "/api/rollouts", "/:id/evidence", S.s2, P.p4, T.t3, V.r3, "policy.rollout.evidence.attach"),
  route("POST", "/api/rollouts", "/:id/transition", S.s2, P.p4, T.t3, V.r3, "policy.rollout.transition"),
  route("POST", "/api/rollouts", "/:id/approve", S.s2, P.p5, T.t3, V.r3, "policy.rollout.approve"),
  route("POST", "/api/rollouts", "/:id/reject", S.s2, P.p5, T.t3, V.r3, "policy.rollout.reject"),
  route("POST", "/api/rollouts", "/:id/promote", S.s2, P.p5, T.t3, V.r3, "policy.rollout.promote"),
  route("POST", "/api/rollouts", "/:id/rollback", S.s2, P.p5, T.t3, V.r3, "policy.rollout.rollback"),
  route("POST", "/api/ci", "/:runId/retry", S.s3, P.p1, T.t1, V.r4, "ci.manual.rerun"),
  route("POST", "/api/ci", "/:runId/heal", S.s3, P.p1, T.t1, V.r4, "ci.manual.heal.enqueue"),
  route("POST", "/api/fix", "/:owner/:repo/issues/:number", S.s4, P.p6, T.t1, V.r1, "issue.fix.enqueue"),
  route("POST", "/api/repos", "/:owner/:repo/sync", S.s5, P.p2, T.t4, V.r5, "repository.sync"),
  route("POST", "/api/actions", "/:id/retry", S.s6, P.p2, T.t0, V.r6, "actions.retry"),
  route("POST", "/api/actions", "/:id/cancel", S.s6, P.p2, T.t0, V.r6, "actions.cancel"),
  route("POST", "/api/actions", "/:id/reconcile", S.s6, P.p2, T.t0, V.r6, "actions.reconcile"),
  route("POST", "/api/repos", "/reconcile/merge", S.s7, P.p2, T.t0, V.r7, "repository.reconcile.merge"),
  route("POST", "/api/repos", "/reconcile/discard", S.s7, P.p2, T.t0, V.r8, "repository.reconcile.discard"),
  route("POST", "/api/triage", "/failures/:jobId/disposition", S.s8, P.p2, T.t1, V.r9, "triage.failure.disposition"),
  route("POST", "/api/triage", "/failures/:jobId/retry", S.s8, P.p2, T.t1, V.r9, "triage.failure.retry"),
  route("POST", "/api/phase2", "/queue/:owner/:repo/config", S.s9, P.p7, T.t1, V.r1, "merge_queue.config.write"),
  route("POST", "/api/phase2", "/queue/:owner/:repo/:pr/admit", S.s9, P.p7, T.t1, V.r1, "merge_queue.admit"),
  route("POST", "/api/phase2", "/queue/:owner/:repo/:pr/remove", S.s9, P.p7, T.t1, V.r1, "merge_queue.remove"),
  route("POST", "/api/phase2", "/feedback", S.s9, P.p2, T.t4, V.r10, "feedback.rule.create"),
  route("PUT", "/api/phase2", "/feedback/:id", S.s9, P.p2, T.t4, V.r11, "feedback.rule.update"),
  route("DELETE", "/api/phase2", "/feedback/:id", S.s9, P.p2, T.t4, V.r11, "feedback.rule.delete"),
  route("POST", "/api/enforcement", "/policies", S.s10, P.p2, T.t4, V.r10, "enforcement.policy.create"),
  route("PUT", "/api/enforcement", "/policies/:id", S.s10, P.p2, T.t4, V.r12, "enforcement.policy.update"),
  route("DELETE", "/api/enforcement", "/policies/:id", S.s10, P.p2, T.t4, V.r12, "enforcement.policy.delete"),
  route("POST", "/api/enforcement", "/violations/:id/suppress", S.s10, P.p2, T.t1, V.r13, "enforcement.violation.suppress"),
  route("POST", "/api/enforcement", "/run", S.s10, P.p1, T.t0, V.r14, "enforcement.run"),
  route("POST", "/api/gates", "/:owner/:repo", S.s11, P.p2, T.t1, V.r1, "quality_gate.definition.upsert"),
  route("DELETE", "/api/gates", "/:owner/:repo/:name", S.s11, P.p2, T.t1, V.r1, "quality_gate.definition.delete"),
  route("POST", "/api/gates", "/:owner/:repo/evaluate", S.s11, P.p8, T.t1, V.r1, "quality_gate.evaluate"),
  route("POST", "/api/waivers", "/", S.s12, P.p2, T.t1, V.r15, "waiver.grant"),
  route("DELETE", "/api/waivers", "/:id", S.s12, P.p2, T.t1, V.r16, "waiver.revoke"),
  route("POST", "/api/duplicates", "/:id(\\d+)/confirm", S.s13, P.p1, T.t1, V.r17, "duplicate.confirm"),
  route("POST", "/api/duplicates", "/:id(\\d+)/dismiss", S.s13, P.p2, T.t1, V.r17, "duplicate.dismiss"),
  route("POST", "/api/duplicates", "/backfill/:owner/:repo", S.s13, P.p2, T.t1, V.r1, "duplicate.embedding.backfill"),
  route("POST", "/api/phase3", "/flaky/:id/graduate", S.s14, P.p2, T.t1, V.r18, "flaky_test.graduate"),
  route("POST", "/api/phase3", "/flaky/:id/dismiss", S.s14, P.p2, T.t1, V.r18, "flaky_test.dismiss"),
  route("POST", "/api/phase3", "/reconciler/run", S.s14, P.p0, T.t0, V.r14, "policy.reconciliation.run"),
  route("PUT", "/api/phase3", "/reconciler/repos/:owner/:repo", S.s14, P.p2, T.t1, V.r1, "policy.reconciliation.skip.update"),
  route("POST", "/api/phase3", "/dependencies/:owner/:repo/scan", S.s14, P.p2, T.t1, V.r1, "dependency.scan"),
  route("POST", "/api/phase3", "/dependencies/:owner/:repo/batch-pr", S.s14, P.p1, T.t1, V.r1, "dependency.batch_update_pr"),
  route("POST", "/api/phase3", "/dependencies/vuln/:id/dismiss", S.s14, P.p2, T.t1, V.r19, "dependency.vulnerability.dismiss"),
  route("POST", "/api", "/review/config/:owner/:repo", S.s15, P.p9, T.t1, V.r1, "ai_review.config.write"),
  route("POST", "/api", "/review/trigger/:owner/:repo/:pr", S.s15, P.p9, T.t1, V.r1, "ai_review.trigger"),
  route("POST", "/api", "/audit/export", S.s15, P.p0, T.t0, V.r20, "audit.export.generate"),
  route("POST", "/api", "/audit/reports", S.s15, P.p0, T.t0, V.r21, "audit.report.generate"),
  runtime("worker:webhook", "worker", P.p0, T.t4, "worker-context", "webhook_hmac", V.r22, "webhook.process", "src/workers/webhookWorker.js"),
  runtime("worker:triage", "worker", P.p10, T.t1, "worker-context", "system", V.r23, "triage.process", "src/workers/triageWorker.js"),
  runtime("worker:ciHeal", "worker", P.p1, T.t1, "worker-context", "system", V.r24, "ci_heal.process", "src/workers/ciHealWorker.js"),
  runtime("worker:ciEvidence", "worker", P.p11, T.t1, "worker-context", "system", V.r24, "ci_evidence.collect", "src/workers/ciEvidenceWorker.js"),
  runtime("worker:diagnosis", "worker", P.p12, T.t1, "worker-context", "system", V.r25, "repair.diagnose", "src/workers/diagnosisWorker.js"),
  runtime("worker:patch", "worker", P.p13, T.t1, "worker-context", "system", V.r25, "repair.patch", "src/workers/patchWorker.js"),
  runtime("worker:verification", "worker", P.p14, T.t1, "worker-context", "system", V.r25, "repair.verify", "src/workers/verificationWorker.js"),
  runtime("worker:critic", "worker", P.p9, T.t1, "worker-context", "system", V.r26, "review.critic", "src/workers/criticWorker.js"),
  runtime("worker:sync", "worker", P.p0, T.t4, "worker-context", "system", V.r27, "repository.sync.worker", "src/workers/syncWorker.js"),
  runtime("worker:maintainer", "worker", P.p1, T.t1, "worker-context", "system", V.r28, "maintainer.worker", "src/workers/maintainerWorker.js"),
  runtime("worker:issueFix", "worker", P.p15, T.t1, "worker-context", "system", V.r29, "issue_fix.worker", "src/workers/issueFixWorker.js"),
  runtime("worker:phase2", "worker", P.p7, T.t1, "worker-context", "system", V.r30, "phase2.worker", "src/workers/phase2Worker.js"),
  runtime("worker:phase3", "worker", P.p0, T.t4, "worker-context", "system", V.r31, "phase3.worker", "src/workers/phase3Worker.js"),
  runtime("worker:phase4", "worker", P.p9, T.t1, "worker-context", "system", V.r32, "phase4.worker", "src/workers/phase4Worker.js"),
  runtime("scheduled:sync", "scheduled", P.p0, T.t0, "worker-context", "system", V.r33, "sync.schedule", "src/workers/syncWorker.js"),
  runtime("scheduled:maintainer", "scheduled", P.p1, T.t4, "worker-context", "system", V.r34, "maintainer.schedule", "src/workers/maintainerWorker.js"),
  runtime("scheduled:phase3", "scheduled", P.p0, T.t0, "worker-context", "system", V.r35, "phase3.schedule", "src/workers/phase3Worker.js"),
  runtime("scheduled:phase4", "scheduled", P.p9, T.t0, "worker-context", "system", V.r36, "phase4.schedule", "src/workers/phase4Worker.js"),
  runtime("scheduled:reconciliation", "scheduled", P.p0, T.t0, "worker-context", "system", V.r37, "reconciliation.schedule", "src/workers/reconciliationWorker.js"),
  runtime("telegram:heal", "telegram", P.p1, T.t1, "req.auth", "api_key", V.r38, "telegram.heal", "telegram heal handler"),
  runtime("telegram:fix", "telegram", P.p6, T.t1, "req.auth", "api_key", V.r38, "telegram.fix", "telegram fix handler"),
  runtime("webhook:github", "webhook", P.p0, T.t4, "webhook-installation", "webhook_hmac", V.r39, "github.webhook.ingress", "src/routes/webhooks.js"),
]);

export const PROTECTED_READ_SURFACE_MANIFEST = Object.freeze([
  Object.freeze({ surfaceId: "route:GET:/api/repos", kind: "route", permission: P.p16, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" }),
  Object.freeze({ surfaceId: "route:GET:/api/issues/:owner/:repo", kind: "route", permission: P.p17, resourceType: T.t1, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" }),
  Object.freeze({ surfaceId: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", permission: P.p18, resourceType: T.t1, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" }),
  Object.freeze({ surfaceId: "route:GET:/api/decisions", kind: "route", permission: P.p19, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" }),
  Object.freeze({ surfaceId: "route:GET:/api/repairs", kind: "route", permission: P.p20, resourceType: T.t0, principalSource: "req.auth", authMethod: "api_key", observeHandling: "record" }),
]);

export const ROUTE_CLASSIFICATION_EXCLUSIONS = Object.freeze([
  Object.freeze({ surfaceId: "route:POST:/api/config/playground", sourcePath: S.s1, classification: "semantic_read", reason: "Evaluates supplied expressions only; no GitWire authority or external effect is written." }),
  Object.freeze({ surfaceId: "route:POST:/api/config/validate", sourcePath: S.s1, classification: "semantic_read", reason: "Validates a proposed policy only; no config or external state is written." }),
  Object.freeze({ surfaceId: "route:POST:/api/config/simulate", sourcePath: S.s1, classification: "semantic_read", reason: "Simulates proposed policy against historical decisions without mutation." }),
  Object.freeze({ surfaceId: "route:POST:/api/config/diff-impact", sourcePath: S.s1, classification: "semantic_read", reason: "Computes policy impact only; no config or external state is written." }),
  Object.freeze({ surfaceId: "route:POST:/api/config/recommendations", sourcePath: S.s1, classification: "semantic_read", reason: "Computes recommendations only; no config or external state is written." }),
  Object.freeze({ surfaceId: "route:POST:/api/repairs", sourcePath: "src/routes/repairs.js", classification: "hard_denied", reason: "Public repair creation route always returns 403; trusted services own proposal creation." }),
  Object.freeze({ surfaceId: "route:PATCH:/api/repairs/:id/evidence", sourcePath: "src/routes/repairs.js", classification: "hard_denied", reason: "Public evidence mutation route always returns 403; trusted services own evidence attachment." }),
  Object.freeze({ surfaceId: "route:POST:/api/repairs/:id/transition", sourcePath: "src/routes/repairs.js", classification: "hard_denied", reason: "Public transition route always returns 403; trusted services own lifecycle mutation." }),
  Object.freeze({ surfaceId: "route:POST:/api/auth/login", sourcePath: "src/routes/auth.js", classification: "separate_security_contract", reason: "Session login is mounted before apiKeyAuth and governed by the authentication/session contract." }),
  Object.freeze({ surfaceId: "route:POST:/api/auth/logout", sourcePath: "src/routes/auth.js", classification: "separate_security_contract", reason: "Session logout is mounted before apiKeyAuth and governed by the authentication/session contract." }),
  Object.freeze({ surfaceId: "route:POST:/api/bootstrap/first", sourcePath: "src/routes/bootstrap.js", classification: "separate_security_contract", reason: "First-admin bootstrap is intentionally anonymous until initialized and enforces its own atomic bootstrap contract." }),
  Object.freeze({ surfaceId: "route:POST:/webhooks/github", sourcePath: "src/routes/webhooks.js", classification: "covered_by_ingress", coveredBySurfaceId: "webhook:github", reason: "GitHub webhook ingress is HMAC verified and represented by the webhook:github protected ingress surface." }),
]);

export const expectedConsequentialSurfaceIds = () => CONSEQUENTIAL_SURFACE_MANIFEST.map((s) => s.surfaceId);
export const expectedProtectedSurfaceIdsFromManifest = () => [...CONSEQUENTIAL_SURFACE_MANIFEST, ...PROTECTED_READ_SURFACE_MANIFEST].map((s) => s.surfaceId);
