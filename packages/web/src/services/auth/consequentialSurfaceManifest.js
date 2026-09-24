// src/services/auth/consequentialSurfaceManifest.js
//
// D0-04: independent inventory of protected/consequential execution surfaces.
//
// This file is intentionally independent from declarations.js. It answers
// "what protected surfaces exist?" from source/mutation tracing. declarations.js
// answers "what authorization metadata protects each surface?". CI compares the
// independently derived candidate set with this manifest and then compares this
// manifest with the declaration registry, so declarations cannot prove their
// own completeness.

function joinRoute(mountPath, routePath) {
  return routePath === "/" ? mountPath : mountPath + routePath;
}

function route({ method, mountPath, routePath, sourcePath, permission, resourceType, resourceResolver, mutationIdentity }) {
  const upperMethod = method.toUpperCase();
  return Object.freeze({
    surfaceId: `route:${upperMethod}:${joinRoute(mountPath, routePath)}`,
    kind: "route",
    method: upperMethod,
    mountPath,
    routePath,
    sourcePath,
    permission,
    resourceType,
    resourceResolver,
    mutationIdentity,
  });
}

function runtime({ surfaceId, kind, sourcePath, permission, resourceType, resourceResolver, mutationIdentity }) {
  return Object.freeze({ surfaceId, kind, sourcePath, permission, resourceType, resourceResolver, mutationIdentity });
}

const ROUTES = [
  // Maintainer mutations.
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/members/sync", sourcePath: "src/routes/maintainer.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "all active installations", mutationIdentity: "maintainer.members.sync" }),
  route({ method: "PUT", mountPath: "/api/maintainer", routePath: "/collaborators/:owner/:repo/:login", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.collaborator.permission" }),
  route({ method: "DELETE", mountPath: "/api/maintainer", routePath: "/collaborators/:owner/:repo/:login", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.collaborator.remove" }),
  route({ method: "PUT", mountPath: "/api/maintainer", routePath: "/branch-rules/:owner/:repo/:pattern", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.branch_protection" }),
  route({ method: "PATCH", mountPath: "/api/maintainer", routePath: "/:owner/:repo/settings", sourcePath: "src/routes/maintainer.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.settings.write" }),
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/:owner/:repo/stale-scan", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.stale_scan.enqueue" }),
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/:owner/:repo/branch-cleanup", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.branch_cleanup.enqueue" }),

  // Repository config authority state.
  route({ method: "PUT", mountPath: "/api/config", routePath: "/:owner/:repo", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "config.override.set" }),
  route({ method: "PATCH", mountPath: "/api/config", routePath: "/:owner/:repo", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "config.override.patch" }),
  route({ method: "DELETE", mountPath: "/api/config", routePath: "/:owner/:repo", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "config.override.delete" }),
  route({ method: "POST", mountPath: "/api/config", routePath: "/:owner/:repo/restore/:historyId", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "config.override.restore" }),

  // Governed policy rollouts.
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/", sourcePath: "src/routes/rollouts.js", permission: "policy_definition:create", resourceType: "policy_definition", resourceResolver: "request policy definition -> installation scope", mutationIdentity: "policy.rollout.create" }),
  route({ method: "PATCH", mountPath: "/api/rollouts", routePath: "/:id/evidence", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:update", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.evidence.attach" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/transition", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:update", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.transition" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/approve", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.approve" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/reject", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.reject" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/promote", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.promote" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/rollback", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.rollback" }),

  // CI / issue-fix automation.
  route({ method: "POST", mountPath: "/api/ci", routePath: "/:runId/retry", sourcePath: "src/routes/ciRuns.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "runId -> ci_runs -> repository", mutationIdentity: "ci.manual.rerun" }),
  route({ method: "POST", mountPath: "/api/ci", routePath: "/:runId/heal", sourcePath: "src/routes/ciRuns.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "runId -> ci_runs -> repository", mutationIdentity: "ci.manual.heal.enqueue" }),
  route({ method: "POST", mountPath: "/api/fix", routePath: "/:owner/:repo/issues/:number", sourcePath: "src/routes/fix.js", permission: "issue:create", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "issue_fix.enqueue" }),

  // Managed-action operator lifecycle.
  route({ method: "POST", mountPath: "/api/actions", routePath: "/:id/retry", sourcePath: "src/routes/actions.js", permission: "repository:update", resourceType: "repository", resourceResolver: "managed action id -> repository", mutationIdentity: "actions.retry" }),
  route({ method: "POST", mountPath: "/api/actions", routePath: "/:id/cancel", sourcePath: "src/routes/actions.js", permission: "repository:update", resourceType: "repository", resourceResolver: "managed action id -> repository", mutationIdentity: "actions.cancel" }),
  route({ method: "POST", mountPath: "/api/actions", routePath: "/:id/reconcile", sourcePath: "src/routes/actions.js", permission: "repository:update", resourceType: "repository", resourceResolver: "managed action id -> repository", mutationIdentity: "actions.reconcile" }),

  // Merge queue and feedback control state.
  route({ method: "POST", mountPath: "/api/phase2", routePath: "/queue/:owner/:repo/config", sourcePath: "src/routes/phase2.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "merge_queue.config.write" }),
  route({ method: "POST", mountPath: "/api/phase2", routePath: "/queue/:owner/:repo/:pr/admit", sourcePath: "src/routes/phase2.js", permission: "merge_queue_entry:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "merge_queue.admit" }),
  route({ method: "POST", mountPath: "/api/phase2", routePath: "/queue/:owner/:repo/:pr/remove", sourcePath: "src/routes/phase2.js", permission: "merge_queue_entry:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "merge_queue.remove" }),
  route({ method: "POST", mountPath: "/api/phase2", routePath: "/feedback", sourcePath: "src/routes/phase2.js", permission: "repository:update", resourceType: "installation", resourceResolver: "body.installation_id or repo_filter -> installation", mutationIdentity: "feedback.rule.create" }),
  route({ method: "PUT", mountPath: "/api/phase2", routePath: "/feedback/:id", sourcePath: "src/routes/phase2.js", permission: "repository:update", resourceType: "installation", resourceResolver: "feedback rule id -> installation", mutationIdentity: "feedback.rule.update" }),
  route({ method: "DELETE", mountPath: "/api/phase2", routePath: "/feedback/:id", sourcePath: "src/routes/phase2.js", permission: "repository:update", resourceType: "installation", resourceResolver: "feedback rule id -> installation", mutationIdentity: "feedback.rule.delete" }),

  // Enforcement policy/control-state mutations.
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/run", sourcePath: "src/routes/enforcement.js", permission: "repository:github:act", resourceType: "fleet", resourceResolver: "optional body.repo -> repository; otherwise fleet", mutationIdentity: "enforcement.run" }),
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/policies", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "body.installation_id or repo_filter -> installation", mutationIdentity: "enforcement.policy.create" }),
  route({ method: "PUT", mountPath: "/api/enforcement", routePath: "/policies/:id", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "policy id -> policy_definitions.installation_id", mutationIdentity: "enforcement.policy.update" }),
  route({ method: "DELETE", mountPath: "/api/enforcement", routePath: "/policies/:id", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "policy id -> policy_definitions.installation_id", mutationIdentity: "enforcement.policy.delete" }),
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/violations/:id/suppress", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "repository", resourceResolver: "violation id -> enforcement_violations.repo_id", mutationIdentity: "enforcement.violation.suppress" }),

  // Duplicate decisions and backfill.
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/:id(\\d+)/confirm", sourcePath: "src/routes/duplicates.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "duplicate signal id -> repository", mutationIdentity: "duplicates.confirm" }),
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/:id(\\d+)/dismiss", sourcePath: "src/routes/duplicates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "duplicate signal id -> repository", mutationIdentity: "duplicates.dismiss" }),
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/backfill/:owner/:repo", sourcePath: "src/routes/duplicates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "duplicates.embedding_backfill" }),

  // Quality gates.
  route({ method: "POST", mountPath: "/api/gates", routePath: "/:owner/:repo", sourcePath: "src/routes/gates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.definition.upsert" }),
  route({ method: "DELETE", mountPath: "/api/gates", routePath: "/:owner/:repo/:name", sourcePath: "src/routes/gates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.definition.delete" }),
  route({ method: "POST", mountPath: "/api/gates", routePath: "/:owner/:repo/evaluate", sourcePath: "src/routes/gates.js", permission: "quality_gate:evaluate", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.evaluate" }),

  // Phase-3 trust/resilience control state and effects.
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/flaky/:id/graduate", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "flaky test id -> flaky_tests.repo_id", mutationIdentity: "flaky.graduate" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/flaky/:id/dismiss", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "flaky test id -> flaky_tests.repo_id", mutationIdentity: "flaky.dismiss" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/reconciler/run", sourcePath: "src/routes/phase3.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "optional body.repo -> repository; otherwise fleet", mutationIdentity: "policy_reconciler.run" }),
  route({ method: "PUT", mountPath: "/api/phase3", routePath: "/reconciler/repos/:owner/:repo", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "policy_reconciler.skip.write" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/:owner/:repo/scan", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "dependency.scan" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/:owner/:repo/batch-pr", sourcePath: "src/routes/phase3.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "dependency.update_pr" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/vuln/:id/dismiss", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "vulnerability id -> vulnerability_advisories.repo_id", mutationIdentity: "dependency.vulnerability.dismiss" }),

  // AI review/audit control state.
  route({ method: "POST", mountPath: "/api", routePath: "/review/config/:owner/:repo", sourcePath: "src/routes/phase4.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "ai_review.config.write" }),
  route({ method: "POST", mountPath: "/api", routePath: "/review/trigger/:owner/:repo/:pr", sourcePath: "src/routes/phase4.js", permission: "ai_review:create", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "ai_review.enqueue" }),
  route({ method: "POST", mountPath: "/api", routePath: "/audit/export", sourcePath: "src/routes/phase4.js", permission: "decision_log:list", resourceType: "fleet", resourceResolver: "audit export scope", mutationIdentity: "audit.export.generate" }),
  route({ method: "POST", mountPath: "/api", routePath: "/audit/reports", sourcePath: "src/routes/phase4.js", permission: "decision_log:list", resourceType: "fleet", resourceResolver: "audit report scope", mutationIdentity: "audit.report.generate" }),

  // Repo sync and transfer reconciliation.
  route({ method: "POST", mountPath: "/api/repos", routePath: "/:owner/:repo/sync", sourcePath: "src/routes/repos.js", permission: "repository:update", resourceType: "installation", resourceResolver: "owner/repo -> repositories -> installation", mutationIdentity: "repository.sync" }),
  route({ method: "POST", mountPath: "/api/repos", routePath: "/reconcile/merge", sourcePath: "src/routes/transfers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "body orphan/live -> repositories", mutationIdentity: "repository.transfer.merge" }),
  route({ method: "POST", mountPath: "/api/repos", routePath: "/reconcile/discard", sourcePath: "src/routes/transfers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "body orphan -> repositories", mutationIdentity: "repository.transfer.discard" }),

  // Triage operator control state.
  route({ method: "POST", mountPath: "/api/triage", routePath: "/failures/:jobId/disposition", sourcePath: "src/routes/triageOperations.js", permission: "repository:update", resourceType: "repository", resourceResolver: "retained triage job -> authoritative repository IDs", mutationIdentity: "triage.failure.disposition" }),
  route({ method: "POST", mountPath: "/api/triage", routePath: "/failures/:jobId/retry", sourcePath: "src/routes/triageOperations.js", permission: "repository:update", resourceType: "repository", resourceResolver: "retained triage job -> authoritative repository IDs", mutationIdentity: "triage.failure.retry" }),

  // Waiver control state.
  route({ method: "POST", mountPath: "/api/waivers", routePath: "/", sourcePath: "src/routes/waivers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "body.repo_id -> repositories", mutationIdentity: "waivers.grant" }),
  route({ method: "DELETE", mountPath: "/api/waivers", routePath: "/:id", sourcePath: "src/routes/waivers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "waiver id -> waivers.repo_id -> repositories", mutationIdentity: "waivers.revoke" }),
];

const WORKERS = [
  runtime({ surfaceId: "worker:webhook", kind: "worker", sourcePath: "src/workers/webhookWorker.js", permission: "installation:read", resourceType: "installation", resourceResolver: "trusted webhook installation", mutationIdentity: "webhook.process" }),
  runtime({ surfaceId: "worker:triage", kind: "worker", sourcePath: "src/workers/triageWorker.js", permission: "issue:update", resourceType: "repository", resourceResolver: "trusted job repository", mutationIdentity: "triage.process" }),
  runtime({ surfaceId: "worker:ciHeal", kind: "worker", sourcePath: "src/workers/ciHealWorker.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "trusted CI run repository", mutationIdentity: "ci_heal.process" }),
  runtime({ surfaceId: "worker:ciEvidence", kind: "worker", sourcePath: "src/workers/ciEvidenceWorker.js", permission: "ci_run:read", resourceType: "repository", resourceResolver: "trusted CI run repository", mutationIdentity: "ci_evidence.persist" }),
  runtime({ surfaceId: "worker:diagnosis", kind: "worker", sourcePath: "src/workers/diagnosisWorker.js", permission: "repair_proposal:read", resourceType: "repository", resourceResolver: "repair job repository", mutationIdentity: "diagnosis.persist" }),
  runtime({ surfaceId: "worker:patch", kind: "worker", sourcePath: "src/workers/patchWorker.js", permission: "patch_artifact:create", resourceType: "repository", resourceResolver: "repair job repository", mutationIdentity: "patch.create" }),
  runtime({ surfaceId: "worker:verification", kind: "worker", sourcePath: "src/workers/verificationWorker.js", permission: "execution_receipt:read", resourceType: "repository", resourceResolver: "repair job repository", mutationIdentity: "verification.persist" }),
  runtime({ surfaceId: "worker:critic", kind: "worker", sourcePath: "src/workers/criticWorker.js", permission: "ai_review:create", resourceType: "repository", resourceResolver: "trusted PR repository", mutationIdentity: "critic.review" }),
  runtime({ surfaceId: "worker:sync", kind: "worker", sourcePath: "src/workers/syncWorker.js", permission: "installation:read", resourceType: "installation", resourceResolver: "trusted installation", mutationIdentity: "repository.sync" }),
  runtime({ surfaceId: "worker:maintainer", kind: "worker", sourcePath: "src/workers/maintainerWorker.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "trusted maintainer job repository", mutationIdentity: "maintainer.process" }),
  runtime({ surfaceId: "worker:issueFix", kind: "worker", sourcePath: "src/workers/issueFixWorker.js", permission: "pull_request:create", resourceType: "repository", resourceResolver: "trusted issue-fix repository", mutationIdentity: "issue_fix.process" }),
  runtime({ surfaceId: "worker:phase2", kind: "worker", sourcePath: "src/workers/phase2Worker.js", permission: "merge_queue_entry:update", resourceType: "repository", resourceResolver: "trusted merge-queue repository", mutationIdentity: "phase2.process" }),
  runtime({ surfaceId: "worker:phase3", kind: "worker", sourcePath: "src/workers/phase3Worker.js", permission: "installation:read", resourceType: "installation", resourceResolver: "trusted phase3 installation", mutationIdentity: "phase3.process" }),
  runtime({ surfaceId: "worker:phase4", kind: "worker", sourcePath: "src/workers/phase4Worker.js", permission: "ai_review:create", resourceType: "repository", resourceResolver: "trusted review repository", mutationIdentity: "phase4.process" }),
];

const SCHEDULED = [
  runtime({ surfaceId: "scheduled:sync", kind: "scheduled", sourcePath: "src/index.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "scheduler enumerates installations", mutationIdentity: "scheduled.sync" }),
  runtime({ surfaceId: "scheduled:maintainer", kind: "scheduled", sourcePath: "src/index.js", permission: "repository:github:act", resourceType: "installation", resourceResolver: "scheduler installation scope", mutationIdentity: "scheduled.maintainer" }),
  runtime({ surfaceId: "scheduled:phase3", kind: "scheduled", sourcePath: "src/index.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.phase3" }),
  runtime({ surfaceId: "scheduled:phase4", kind: "scheduled", sourcePath: "src/index.js", permission: "ai_review:create", resourceType: "fleet", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.phase4" }),
  runtime({ surfaceId: "scheduled:reconciliation", kind: "scheduled", sourcePath: "src/index.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "scheduler fleet scope", mutationIdentity: "scheduled.reconciliation" }),
];

const INGRESS = [
  runtime({ surfaceId: "telegram:heal", kind: "telegram", sourcePath: "src/services/telegramBot.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "command run -> repository", mutationIdentity: "telegram.heal" }),
  runtime({ surfaceId: "telegram:fix", kind: "telegram", sourcePath: "src/services/telegramBot.js", permission: "issue:create", resourceType: "repository", resourceResolver: "command issue -> repository", mutationIdentity: "telegram.fix" }),
  runtime({ surfaceId: "webhook:github", kind: "webhook", sourcePath: "src/routes/webhooks.js", permission: "installation:read", resourceType: "installation", resourceResolver: "verified webhook installation", mutationIdentity: "github.webhook.ingress" }),
];

const READ_ONLY_PROTECTED = [
  Object.freeze({ surfaceId: "route:GET:/api/repos", kind: "route", sourcePath: "src/routes/repos.js", permission: "repository:list", resourceType: "fleet", resourceResolver: "fleet read" }),
  Object.freeze({ surfaceId: "route:GET:/api/issues/:owner/:repo", kind: "route", sourcePath: "src/routes/issues.js", permission: "issue:list", resourceType: "repository", resourceResolver: "owner/repo -> repositories" }),
  Object.freeze({ surfaceId: "route:GET:/api/pull-requests/:owner/:repo", kind: "route", sourcePath: "src/routes/pullRequests.js", permission: "pull_request:list", resourceType: "repository", resourceResolver: "owner/repo -> repositories" }),
  Object.freeze({ surfaceId: "route:GET:/api/decisions", kind: "route", sourcePath: "src/routes/decisions.js", permission: "decision_log:list", resourceType: "fleet", resourceResolver: "fleet read" }),
  Object.freeze({ surfaceId: "route:GET:/api/repairs", kind: "route", sourcePath: "src/routes/repairs.js", permission: "repair_proposal:list", resourceType: "fleet", resourceResolver: "fleet read" }),
];

export const CONSEQUENTIAL_SURFACE_MANIFEST = Object.freeze([...ROUTES, ...WORKERS, ...SCHEDULED, ...INGRESS]);
export const PROTECTED_SURFACE_MANIFEST = Object.freeze([...CONSEQUENTIAL_SURFACE_MANIFEST, ...READ_ONLY_PROTECTED]);

// Candidate mutation verbs that are source-reviewed as non-consequential:
// config playground/validation/simulation are explicitly non-mutating, and
// repair mutation-shaped public stubs always return 403 without changing state.
export const NON_CONSEQUENTIAL_MUTATION_SURFACE_IDS = Object.freeze([
  "route:POST:/api/config/playground",
  "route:POST:/api/config/validate",
  "route:POST:/api/config/simulate",
  "route:POST:/api/config/diff-impact",
  "route:POST:/api/config/recommendations",
  "route:POST:/api/repairs",
  "route:PATCH:/api/repairs/:id/evidence",
  "route:POST:/api/repairs/:id/transition",
]);

export function expectedConsequentialSurfaceIds() {
  return CONSEQUENTIAL_SURFACE_MANIFEST.map((entry) => entry.surfaceId);
}

export function expectedProtectedSurfaceIdsFromManifest() {
  return PROTECTED_SURFACE_MANIFEST.map((entry) => entry.surfaceId);
}
