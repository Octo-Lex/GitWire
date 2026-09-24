// src/services/auth/consequentialSurfaceManifest.js
//
// D0-04: independent inventory of consequential mutation entry points.
//
// This file is intentionally independent from declarations.js.  It answers
// "what mutation-capable surfaces exist?" from source/mutation tracing, while
// declarations.js answers "what authorization metadata protects each surface?".
// CI compares the two sets so declarations cannot prove their own completeness.

function joinRoute(mountPath, routePath) {
  return routePath === "/" ? mountPath : mountPath + routePath;
}

function route({
  method, mountPath, routePath, sourcePath, permission, resourceType,
  resourceResolver, mutationIdentity,
}) {
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

function runtime({
  surfaceId, kind, sourcePath, permission, resourceType, resourceResolver,
  mutationIdentity,
}) {
  return Object.freeze({
    surfaceId,
    kind,
    sourcePath,
    permission,
    resourceType,
    resourceResolver,
    mutationIdentity,
  });
}

const ROUTES = [
  // Maintainer: live GitHub governance + queued mutation work + settings.
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/members/sync", sourcePath: "src/routes/maintainer.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "all active installations", mutationIdentity: "maintainer.members.sync" }),
  route({ method: "PUT", mountPath: "/api/maintainer", routePath: "/collaborators/:owner/:repo/:login", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "github.collaborator.permission.update" }),
  route({ method: "DELETE", mountPath: "/api/maintainer", routePath: "/collaborators/:owner/:repo/:login", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "github.collaborator.remove" }),
  route({ method: "PUT", mountPath: "/api/maintainer", routePath: "/branch-rules/:owner/:repo/:pattern", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "github.branch_protection.update" }),
  route({ method: "PATCH", mountPath: "/api/maintainer", routePath: "/:owner/:repo/settings", sourcePath: "src/routes/maintainer.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.settings.update" }),
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/:owner/:repo/stale-scan", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.stale_scan.enqueue" }),
  route({ method: "POST", mountPath: "/api/maintainer", routePath: "/:owner/:repo/branch-cleanup", sourcePath: "src/routes/maintainer.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "maintainer.branch_cleanup.enqueue" }),

  // Repository configuration + governed policy.
  route({ method: "PUT", mountPath: "/api/config", routePath: "/:owner/:repo", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "repository.config.update" }),
  route({ method: "POST", mountPath: "/api/config", routePath: "/:owner/:repo/restore/:historyId", sourcePath: "src/routes/config.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "repository.config.restore" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/", sourcePath: "src/routes/rollouts.js", permission: "policy_definition:create", resourceType: "policy_definition", resourceResolver: "request policy definition -> installation scope", mutationIdentity: "policy.definition.create" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/transition", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:update", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.transition" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/approve", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.approve" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/promote", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.promote" }),
  route({ method: "POST", mountPath: "/api/rollouts", routePath: "/:id/rollback", sourcePath: "src/routes/rollouts.js", permission: "policy_rollout_plan:approve", resourceType: "policy_rollout_plan", resourceResolver: "rollout id -> rollout plan", mutationIdentity: "policy.rollout.rollback" }),

  // Existing automation triggers.
  route({ method: "POST", mountPath: "/api/ci", routePath: "/:runId/heal", sourcePath: "src/routes/ciRuns.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "runId -> ci_runs -> repository", mutationIdentity: "ci.heal.enqueue" }),
  route({ method: "POST", mountPath: "/api/fix", routePath: "/:owner/:repo/issues/:number", sourcePath: "src/routes/fix.js", permission: "issue:create", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "issue.fix.enqueue" }),
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/run", sourcePath: "src/routes/enforcement.js", permission: "repository:github:act", resourceType: "fleet", resourceResolver: "optional body.repo -> repository; otherwise fleet", mutationIdentity: "enforcement.run" }),
  route({ method: "POST", mountPath: "/api/phase2", routePath: "/queue/:owner/:repo/:pr/admit", sourcePath: "src/routes/phase2.js", permission: "merge_queue_entry:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "merge_queue.admit" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/reconciler/run", sourcePath: "src/routes/phase3.js", permission: "installation:read", resourceType: "fleet", resourceResolver: "optional body.repo -> repository; otherwise fleet", mutationIdentity: "policy.reconciliation.run" }),
  route({ method: "POST", mountPath: "/api/review", routePath: "/trigger/:owner/:repo/:pr", sourcePath: "src/routes/phase4.js", permission: "ai_review:create", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "ai_review.enqueue" }),
  route({ method: "POST", mountPath: "/api/repos", routePath: "/:owner/:repo/sync", sourcePath: "src/routes/repos.js", permission: "repository:update", resourceType: "installation", resourceResolver: "owner/repo -> repositories -> installation", mutationIdentity: "repository.sync" }),

  // Waiver control-state mutations.
  route({ method: "POST", mountPath: "/api/waivers", routePath: "/", sourcePath: "src/routes/waivers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "body.repo_id -> repositories", mutationIdentity: "waiver.grant" }),
  route({ method: "DELETE", mountPath: "/api/waivers", routePath: "/:id", sourcePath: "src/routes/waivers.js", permission: "repository:update", resourceType: "repository", resourceResolver: "waiver id -> waivers.repo_id -> repositories", mutationIdentity: "waiver.revoke" }),

  // Duplicate decisions and backfill.
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/:id(\\d+)/confirm", sourcePath: "src/routes/duplicates.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "duplicate signal id -> repository", mutationIdentity: "duplicate.confirm" }),
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/:id(\\d+)/dismiss", sourcePath: "src/routes/duplicates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "duplicate signal id -> repository", mutationIdentity: "duplicate.dismiss" }),
  route({ method: "POST", mountPath: "/api/duplicates", routePath: "/backfill/:owner/:repo", sourcePath: "src/routes/duplicates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "duplicate.embedding_backfill" }),

  // Quality-gate definition mutations + evaluation.
  route({ method: "POST", mountPath: "/api/gates", routePath: "/:owner/:repo", sourcePath: "src/routes/gates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.definition.upsert" }),
  route({ method: "DELETE", mountPath: "/api/gates", routePath: "/:owner/:repo/:name", sourcePath: "src/routes/gates.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.definition.delete" }),
  route({ method: "POST", mountPath: "/api/gates", routePath: "/:owner/:repo/evaluate", sourcePath: "src/routes/gates.js", permission: "quality_gate:evaluate", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "quality_gate.evaluate" }),

  // Enforcement policy/control-state mutations.
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/policies", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "body.installation_id or body.repo_filter -> installation", mutationIdentity: "enforcement.policy.create" }),
  route({ method: "PUT", mountPath: "/api/enforcement", routePath: "/policies/:id", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "policy id -> policy_definitions.installation_id", mutationIdentity: "enforcement.policy.update" }),
  route({ method: "DELETE", mountPath: "/api/enforcement", routePath: "/policies/:id", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "installation", resourceResolver: "policy id -> policy_definitions.installation_id", mutationIdentity: "enforcement.policy.delete" }),
  route({ method: "POST", mountPath: "/api/enforcement", routePath: "/violations/:id/suppress", sourcePath: "src/routes/enforcement.js", permission: "repository:update", resourceType: "repository", resourceResolver: "violation id -> enforcement_violations.repo_id", mutationIdentity: "enforcement.violation.suppress" }),

  // Phase-3 manual control mutations and dependency effects.
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/flaky/:id/graduate", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "flaky test id -> flaky_tests.repo_id", mutationIdentity: "flaky_test.graduate" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/flaky/:id/dismiss", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "flaky test id -> flaky_tests.repo_id", mutationIdentity: "flaky_test.dismiss" }),
  route({ method: "PUT", mountPath: "/api/phase3", routePath: "/reconciler/repos/:owner/:repo", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "policy.reconciliation.skip.update" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/:owner/:repo/scan", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "dependency.scan" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/:owner/:repo/batch-pr", sourcePath: "src/routes/phase3.js", permission: "repository:github:act", resourceType: "repository", resourceResolver: "owner/repo -> repositories", mutationIdentity: "dependency.batch_update_pr" }),
  route({ method: "POST", mountPath: "/api/phase3", routePath: "/dependencies/vuln/:id/dismiss", sourcePath: "src/routes/phase3.js", permission: "repository:update", resourceType: "repository", resourceResolver: "vulnerability id -> vulnerability_advisories.repo_id", mutationIdentity: "dependency.vulnerability.dismiss" }),
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

export const CONSEQUENTIAL_SURFACE_MANIFEST = Object.freeze([
  ...ROUTES,
  ...WORKERS,
  ...SCHEDULED,
  ...INGRESS,
]);

// These files were the source-verified D0-04 omission set. CI derives every
// mutating Express route in them and requires an independent manifest entry.
// Adding POST/PUT/PATCH/DELETE in one of these mutation-bearing modules therefore
// fails CI until the manifest and declaration are both updated.
export const SOURCE_DERIVED_ROUTE_MODULES = Object.freeze([
  Object.freeze({ sourcePath: "src/routes/waivers.js", mountPath: "/api/waivers" }),
  Object.freeze({ sourcePath: "src/routes/duplicates.js", mountPath: "/api/duplicates" }),
  Object.freeze({ sourcePath: "src/routes/gates.js", mountPath: "/api/gates" }),
  Object.freeze({ sourcePath: "src/routes/enforcement.js", mountPath: "/api/enforcement" }),
  Object.freeze({ sourcePath: "src/routes/phase3.js", mountPath: "/api/phase3" }),
  Object.freeze({ sourcePath: "src/routes/maintainer.js", mountPath: "/api/maintainer" }),
]);

export function expectedConsequentialSurfaceIds() {
  return CONSEQUENTIAL_SURFACE_MANIFEST.map((entry) => entry.surfaceId);
}
