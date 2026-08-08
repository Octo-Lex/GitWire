// src/lib/webhookHandlers/commentCommands/handleManualRun.js
// /gitwire run [pillar] — manual re-evaluation of one or more pillars.

import { buildTriageOperationKey } from "../../../services/idempotencyService.js";

export async function handleManualRun(payload, parsed, action, ctx) {
  const isPR = !!payload.issue?.pull_request;
  const pillar = action.pillar;
  const repoFullName = payload.repository?.full_name;
  const issueNumber = parsed.issueNumber;
  const installationId = payload.installation?.id;

  const { clearIdempotencyKey, clearTriageOperation } = await import("../../../services/idempotencyService.js");

  if (isPR) {
    await handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, { clearIdempotencyKey, clearTriageOperation, buildTriageOperationKey });
  } else {
    await handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, { clearIdempotencyKey, clearTriageOperation, buildTriageOperationKey });
  }

  ctx.logger.info({ command: "run", pillar, repo: repoFullName, issue: issueNumber, isPR }, "/gitwire run queued");
}

// Build the repository-scoped triage operation key for manual-run re-clearing.
// The webhook payload may not carry the GitHub-internal repository/issue ids in
// every shape; we fall back to the numbers so the key remains stable across
// the manual-run path and the worker path (which uses the same builder).
function manualTriageOperationKey(payload, issueNumber, isPR) {
  const repoId = payload.repository?.id ?? payload.repository?.full_name ?? "unknown";
  const targetId = payload.issue?.id ?? issueNumber;
  return buildTriageOperationKey({
    targetType: isPR ? "pr" : "issue",
    repoId,
    targetId,
    action: "manual-run",
  });
}

async function handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, idem) {
  if (pillar === "all" || pillar === "review") {
    // AI review is not migrated to the new lifecycle — legacy key retained.
    await idem.clearIdempotencyKey("ai_review", "pr-" + issueNumber + "-" + (payload.issue?.pull_request?.url || "unknown"));
    await ctx.phase4Queue.add("ai-review", {
      pr: { number: issueNumber, base: { ref: payload.issue?.pull_request?.base?.ref }, user: payload.issue?.user },
      repository: payload.repository,
      installation: payload.installation,
    }, { priority: 1 });
  }
  if (pillar === "all" || pillar === "triage") {
    // Triage uses the success-bound lifecycle. Clear both the active lease and
    // the complete marker so the queued job can re-acquire the lease and run.
    // Also clear the legacy key to cover jobs enqueued before this change.
    const opKey = manualTriageOperationKey(payload, issueNumber, true);
    await idem.clearTriageOperation("triage", opKey);
    await idem.clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
    await ctx.triageQueue.add("triage-issue", { payload }, { priority: 1 });
  }
  if (pillar === "heal") {
    // CI heal is not migrated to the new lifecycle — legacy key retained.
    await idem.clearIdempotencyKey("ci_heal", "heal-pr-" + issueNumber);
    ctx.logger.info({ repo: payload.repository?.full_name, pr: issueNumber }, "/gitwire run heal — CI heal requires a failed workflow_run event");
  }
}

async function handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, idem) {
  if (pillar === "all" || pillar === "triage") {
    // Triage uses the success-bound lifecycle. Clear the new operation keys.
    const opKey = manualTriageOperationKey(payload, issueNumber, false);
    await idem.clearTriageOperation("triage", opKey);
    await idem.clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
    await ctx.triageQueue.add("triage-issue", { payload }, { priority: 1 });
  }
  if (pillar === "all" || pillar === "fix") {
    // Issue fix is not migrated to the new lifecycle — legacy key retained.
    await idem.clearIdempotencyKey("issue_fix", "issue-" + issueNumber);
    await ctx.issueFixQueue.add("fix-issue", {
      repo: repoFullName,
      issueNumber,
      installationId,
      triggeredBy: parsed.authorLogin,
    }, { priority: 1 });
  }
}
