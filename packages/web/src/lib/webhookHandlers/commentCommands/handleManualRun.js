// src/lib/webhookHandlers/commentCommands/handleManualRun.js
// /gitwire run [pillar] — manual re-evaluation of one or more pillars.
//
// This handler resolves the full target object (issue or PR) from GitHub,
// constructs worker-native payloads with a stable "manual-run" action,
// clears the exact lifecycle keys the workers will check, enqueues the
// correct job per target type, and posts a GitHub-visible acknowledgment.

import { buildTriageOperationKey } from "../../../services/idempotencyService.js";
import { buildCommandResponse } from "../../../lib/commentRouter.js";

export async function handleManualRun(payload, parsed, action, ctx) {
  const isPR = !!payload.issue?.pull_request;
  const pillar = action.pillar;
  const repoFullName = payload.repository?.full_name;
  const issueNumber = parsed.issueNumber;
  const installationId = payload.installation?.id;

  const { clearIdempotencyKey, clearTriageOperation } = await import("../../../services/idempotencyService.js");

  // For PRs, we need the full PR object (with head.sha, base.ref, id, etc.)
  // that the issue_comment webhook payload does not carry.
  let fullPR = null;
  if (isPR && installationId) {
    try {
      const octokit = ctx.wrapOctokit(await ctx.getInstallationClient(installationId));
      const [owner, repo] = repoFullName.split("/");
      const { data: prData } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner, repo, pull_number: issueNumber,
      });
      fullPR = prData;
    } catch (err) {
      ctx.logger.warn({ err: err.message, repo: repoFullName, pr: issueNumber }, "Failed to fetch full PR for manual-run");
    }
  }

  let dispatched = [];
  let blocked = [];

  if (isPR) {
    const result = await handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, {
      clearIdempotencyKey, clearTriageOperation, fullPR,
    });
    dispatched = result.dispatched;
    blocked = result.blocked || [];
  } else {
    dispatched = await handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, {
      clearIdempotencyKey, clearTriageOperation,
    });
  }

  // Post GitHub-visible acknowledgment
  await postAcknowledgment(payload, parsed, action, dispatched, blocked, ctx);

  ctx.logger.info({ command: "run", pillar, repo: repoFullName, issue: issueNumber, isPR, dispatched }, "/gitwire run processed");
}

// ── Issue manual run ─────────────────────────────────────────────────────────

async function handleIssueManualRun(payload, parsed, pillar, repoFullName, issueNumber, installationId, ctx, idem) {
  const dispatched = [];

  if (pillar === "all" || pillar === "triage") {
    // Normalize the payload so the worker builds the same lifecycle key we clear.
    // The worker uses payload.action for the operation key; we set it to "manual-run"
    // so beginOperation checks repo:...:issue:...:manual-run — the exact key we clear.
    const normalizedPayload = { ...payload, action: "manual-run" };
    const opKey = buildTriageOperationKey({
      targetType: "issue",
      repoId: payload.repository?.id ?? payload.repository?.full_name ?? "unknown",
      targetId: payload.issue?.id ?? issueNumber,
      action: "manual-run",
    });
    await idem.clearTriageOperation("triage", opKey);
    // Legacy key clear for backward compat with pre-lifecycle jobs
    await idem.clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
    await ctx.triageQueue.add("triage-issue", { payload: normalizedPayload }, { priority: 1 });
    dispatched.push("triage");
  }

  if (pillar === "all" || pillar === "fix") {
    await idem.clearIdempotencyKey("issue_fix", "issue-" + issueNumber);
    await ctx.issueFixQueue.add("fix-issue", {
      repo: repoFullName, issueNumber, installationId, triggeredBy: parsed.authorLogin,
    }, { priority: 1 });
    dispatched.push("fix");
  }

  return dispatched;
}

// ── PR manual run ────────────────────────────────────────────────────────────

async function handlePRManualRun(payload, parsed, pillar, issueNumber, installationId, ctx, idem) {
  const { fullPR } = idem;
  const dispatched = [];
  const blocked = [];

  if (pillar === "all" || pillar === "review") {
    if (!fullPR?.head?.sha) {
      ctx.logger.warn({ repo: payload.repository?.full_name, pr: issueNumber }, "/gitwire run review: could not resolve PR head SHA — skipping review");
    } else {
      // Preflight: is AI review effectively activated? Check BEFORE clearing
      // the idempotency key so we don't poison the key for a future activation.
      const { getEffectiveReviewState } = await import("../../../services/aiReviewService.js");
      const repoId = payload.repository?.id;
      const repoFullName = payload.repository?.full_name;
      const state = await getEffectiveReviewState(repoId, repoFullName);

      if (!state.runnable) {
        // Do not enqueue a knowingly silent review. Record the block so the
        // acknowledgment can tell the maintainer exactly what happened.
        blocked.push({ pillar: "review", reason: state.reason, activationUrl: state.activationUrl });
        ctx.logger.info({ repo: repoFullName, pr: issueNumber, reason: state.reason }, "/gitwire run review: AI review not runnable — blocked preflight");
      } else {
        // Clear the exact key the phase4 worker checks: pr-{number}-{head.sha}
        const reviewKey = "pr-" + issueNumber + "-" + fullPR.head.sha;
        await idem.clearIdempotencyKey("ai_review", reviewKey);
        // Queue with the full PR object so head.sha, base.ref, changed_files, etc. are available
        await ctx.phase4Queue.add("ai-review", {
          pr: fullPR,
          repository: payload.repository,
          installation: payload.installation,
          logicalInvocation: "manual-" + Date.now(),
        }, { priority: 1 });
        dispatched.push("review");
      }
    }
  }

  if (pillar === "all" || pillar === "triage") {
    if (!fullPR?.id) {
      // Fail closed: without the real PR we cannot build a correct lifecycle key
      // or provide a worker-native pull_request payload. Do not enqueue a malformed job.
      ctx.logger.warn({ repo: payload.repository?.full_name, pr: issueNumber }, "/gitwire run triage: could not resolve full PR — skipping PR triage");
    } else {
      // Construct a worker-native pull_request payload with the full PR object.
      // Queue triage-pr (not triage-issue) so triagePR() handles it.
      const normalizedPayload = {
        ...payload,
        action: "manual-run",
        pull_request: fullPR,
      };
      const opKey = buildTriageOperationKey({
        targetType: "pr",
        repoId: payload.repository?.id ?? payload.repository?.full_name ?? "unknown",
        targetId: fullPR.id,
        action: "manual-run",
      });
      await idem.clearTriageOperation("triage", opKey);
      await idem.clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
      await ctx.triageQueue.add("triage-pr", { payload: normalizedPayload }, { priority: 1 });
      dispatched.push("triage");
    }
  }

  if (pillar === "heal") {
    // CI heal requires a workflow_run event — cannot be manually triggered.
    dispatched.push("heal-unsupported");
  }

  return { dispatched, blocked };
}

// ── Acknowledgment ───────────────────────────────────────────────────────────

async function postAcknowledgment(payload, parsed, action, dispatched, blocked, ctx) {
  try {
    let body;

    if (dispatched.includes("heal-unsupported") && dispatched.length === 1 && blocked.length === 0) {
      // Only heal was requested
      body = "ℹ️ **GitWire:** CI healing requires a failed workflow run event and cannot be manually triggered through this command.";
    } else if (dispatched.length === 0 && blocked.length > 0) {
      // Nothing dispatched, but we have a specific block reason.
      // This is the /gitwire run review + not activated case.
      const reviewBlock = blocked.find(b => b.pillar === "review");
      if (reviewBlock && reviewBlock.reason === "not_activated") {
        body = "ℹ️ **GitWire:** AI Review is enabled by repository policy but has not been activated in GitWire. "
             + "Activate it in the [Intelligence dashboard](" + reviewBlock.activationUrl + ") to enable AI code reviews.";
      } else if (reviewBlock && reviewBlock.reason === "pillar_disabled") {
        body = "ℹ️ **GitWire:** AI Review is disabled by repository policy.";
      } else {
        body = "⚠️ **GitWire:** No workers could be dispatched. The repository or PR data could not be resolved. Check that GitWire is properly configured.";
      }
    } else if (dispatched.length === 0) {
      body = "⚠️ **GitWire:** No workers could be dispatched. The repository or PR data could not be resolved. Check that GitWire is properly configured.";
    } else {
      // Use the existing buildCommandResponse for the standard acknowledgment
      body = buildCommandResponse("manual_run", { pillar: action.pillar || "all" });
      if (dispatched.includes("heal-unsupported")) {
        body += "\n\nℹ️ CI healing requires a failed workflow run event and was not triggered.";
      }
      // If some pillars were blocked, append a truthful note
      const reviewBlock = blocked.find(b => b.pillar === "review");
      if (reviewBlock && reviewBlock.reason === "not_activated") {
        body += "\n\nℹ️ AI Review was not triggered — it is enabled by policy but not activated in GitWire. "
              + "Activate it in the [Intelligence dashboard](" + reviewBlock.activationUrl + ").";
      } else if (reviewBlock && reviewBlock.reason === "pillar_disabled") {
        body += "\n\nℹ️ AI Review was not triggered — it is disabled by repository policy.";
      }
    }

    const octokit = ctx.wrapOctokit(await ctx.getInstallationClient(payload.installation?.id));
    const [owner, repo] = payload.repository.full_name.split("/");
    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: parsed.issueNumber, body,
    });
  } catch (err) {
    ctx.logger.warn({ err: err.message }, "Failed to post /gitwire run acknowledgment comment");
  }
}
