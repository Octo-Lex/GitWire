// src/lib/webhookHandlers/commentCommands/handleManualRun.js
// /gitwire run [pillar] — manual re-evaluation of one or more pillars.

export async function handleManualRun(payload, parsed, action, ctx) {
  const isPR = !!payload.issue?.pull_request;
  const pillar = action.pillar;
  const repoFullName = payload.repository?.full_name;
  const issueNumber = parsed.issueNumber;
  const installationId = payload.installation?.id;

  const { clearIdempotencyKey } = await import("../../../services/idempotencyService.js");

  if (isPR) {
    await handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, clearIdempotencyKey);
  } else {
    await handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, clearIdempotencyKey);
  }

  ctx.logger.info({ command: "run", pillar, repo: repoFullName, issue: issueNumber, isPR }, "/gitwire run queued");
}

async function handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, clearIdempotencyKey) {
  if (pillar === "all" || pillar === "review") {
    await clearIdempotencyKey("ai_review", "pr-" + issueNumber + "-" + (payload.issue?.pull_request?.url || "unknown"));
    await ctx.phase4Queue.add("ai-review", {
      pr: { number: issueNumber, base: { ref: payload.issue?.pull_request?.base?.ref }, user: payload.issue?.user },
      repository: payload.repository,
      installation: payload.installation,
    }, { priority: 1 });
  }
  if (pillar === "all" || pillar === "triage") {
    await clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
    await ctx.triageQueue.add("triage-issue", { payload }, { priority: 1 });
  }
  if (pillar === "heal") {
    await clearIdempotencyKey("ci_heal", "heal-pr-" + issueNumber);
    ctx.logger.info({ repo: payload.repository?.full_name, pr: issueNumber }, "/gitwire run heal — CI heal requires a failed workflow_run event");
  }
}

async function handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, clearIdempotencyKey) {
  if (pillar === "all" || pillar === "triage") {
    await clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
    await ctx.triageQueue.add("triage-issue", { payload }, { priority: 1 });
  }
  if (pillar === "all" || pillar === "fix") {
    await clearIdempotencyKey("issue_fix", "issue-" + issueNumber);
    await ctx.issueFixQueue.add("fix-issue", {
      repo: repoFullName,
      issueNumber,
      installationId,
      triggeredBy: parsed.authorLogin,
    }, { priority: 1 });
  }
}
