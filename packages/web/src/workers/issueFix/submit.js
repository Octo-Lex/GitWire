// src/workers/issueFix/submit.js
// Stage 6: pre-effect authority/head/issue/idempotency fence → branch → commit fixes → open PR.

import { succeed, fail, cancel } from "../../services/actionStateMachine.js";
import { checkAndMark } from "../../services/idempotencyService.js";
import { notifyIssueFix } from "../../services/telegramNotifyService.js";
import { detectConvention, formatPRTitle, extractScope } from "../../services/conventionDetector.js";
import {
  resolveIssueFixRepositoryById,
  sameIssueFixRepositoryBinding,
  buildIssueFixIssueSnapshot,
  sameIssueFixIssueSnapshot,
} from "../../services/issueFixTargetService.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment, truncate } from "./helpers.js";

async function supersedeFix({ ctx, analysis, fixAction, reason, detail, log = {} }) {
  const { repoId, issueNumber, branchName, repo } = ctx;
  await cancel(fixAction.id, reason);
  await upsertFixAttempt(
    repoId,
    issueNumber,
    branchName,
    "superseded",
    analysis.complexity,
    analysis.explanation,
    detail,
  );
  logger.info({ repo, issueNumber, ...log }, "Issue fix superseded before mutation");
}

async function clearSubmissionMarker(idempotencyKey) {
  if (!idempotencyKey) return false;
  try {
    const { clearIdempotencyKey } = await import("../../services/idempotencyService.js");
    if (typeof clearIdempotencyKey !== "function") return false;
    await clearIdempotencyKey("issue_fix", idempotencyKey);
    return true;
  } catch (err) {
    logger.warn({ err: err.message || err, idempotencyKey }, "Failed to clear issue-fix submission marker");
    return false;
  }
}

async function cleanupOwnedBranch({ octokit, owner, repoName, branchName, ownedHeadSha, repo, issueNumber }) {
  if (!ownedHeadSha) return false;
  try {
    const { data: currentBranch } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner,
      repo: repoName,
      branch: branchName,
    });
    const currentSha = currentBranch?.object?.sha;
    if (currentSha !== ownedHeadSha) {
      logger.warn(
        { repo, issueNumber, branchName, ownedHeadSha, currentSha },
        "Skipping issue-fix branch cleanup because branch head no longer matches GitWire-owned head"
      );
      return false;
    }

    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo: repoName,
      ref: "heads/" + branchName,
    });
    logger.info({ repo, issueNumber, branchName, ownedHeadSha }, "Removed partial GitWire-owned issue-fix branch after failure");
    return true;
  } catch (err) {
    if (err?.status === 404) return true;
    logger.warn({ err: err.message || err, repo, issueNumber, branchName }, "Failed to clean up partial issue-fix branch");
    return false;
  }
}

/** Creates the branch, commits fixes, opens PR. */
export async function submitFix(ctx, analysis, validated) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repo, repository } = ctx;
  const { fixes, fileContents, fixAction } = validated;
  const baseSha = ctx._scope?.baseSha;
  const defaultBranch = ctx._scope?.defaultBranch;
  const issueSnapshot = ctx._scope?.issueSnapshot;
  let idempotencyKey = null;
  let ownedBranchHeadSha = null;
  let prCreated = false;

  try {
    if (!baseSha || !defaultBranch || !issueSnapshot) {
      throw new Error("Exact-head issue-fix snapshot is missing");
    }

    // A queued/long-running fix may outlive a transfer, uninstall, rename or
    // soft-delete. Re-resolve server-owned state immediately before mutation.
    const currentResolution = await resolveIssueFixRepositoryById(repoId);
    const currentRepository = currentResolution.status === "resolved" ? currentResolution.repository : null;
    if (!sameIssueFixRepositoryBinding(repository, currentRepository)) {
      await supersedeFix({
        ctx,
        analysis,
        fixAction,
        reason: "Repository binding changed before issue-fix submission",
        detail: "Repository binding changed before submission",
        log: { expected: repository, current: currentRepository, resolution: currentResolution.status },
      });
      return;
    }

    // DB default_branch is synchronized metadata, not publication authority.
    // Read the live GitHub repository using the cache-bypassed client and make
    // the current repository id/name/default branch part of the effect fence.
    const { data: liveRepo } = await octokit.request("GET /repos/{owner}/{repo}", {
      owner,
      repo: repoName,
    });
    const liveRepoId = liveRepo?.id != null ? String(liveRepo.id) : null;
    const liveFullName = liveRepo?.full_name;
    const liveDefaultBranch = liveRepo?.default_branch;
    if (liveRepoId !== String(repoId) || liveFullName !== repo || liveDefaultBranch !== defaultBranch) {
      await supersedeFix({
        ctx,
        analysis,
        fixAction,
        reason: "Repository identity or default branch changed before issue-fix submission",
        detail: "Live GitHub repository identity/default branch changed before submission",
        log: { liveRepoId, liveFullName, liveDefaultBranch, expectedDefaultBranch: defaultBranch },
      });
      return;
    }

    // Generation read files from baseSha. Never apply that diagnosis/patch to a
    // newer head. This GET is live because the issue-fix Octokit skips cache.
    const { data: currentRef } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner,
      repo: repoName,
      branch: defaultBranch,
    });
    const currentHeadSha = currentRef.object?.sha;
    if (!currentHeadSha || currentHeadSha !== baseSha) {
      await supersedeFix({
        ctx,
        analysis,
        fixAction,
        reason: "Default branch advanced before issue-fix submission",
        detail: "Default branch advanced from " + baseSha + " to " + (currentHeadSha || "unknown"),
        log: { baseSha, currentHeadSha },
      });
      return;
    }

    // The issue itself is part of the intent snapshot. Do not create a PR from a
    // stale problem statement, changed eligibility labels, or a pull request
    // exposed through GitHub's Issues API.
    const { data: liveIssue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });
    const liveIssueSnapshot = buildIssueFixIssueSnapshot(liveIssue);
    if (!sameIssueFixIssueSnapshot(issueSnapshot, liveIssueSnapshot)) {
      await supersedeFix({
        ctx,
        analysis,
        fixAction,
        reason: "Issue target changed before issue-fix submission",
        detail: "Issue title/body/state/labels or target identity changed before submission",
        log: { expectedIssue: issueSnapshot, currentIssue: liveIssueSnapshot },
      });
      return;
    }

    // Never repurpose or force-update an existing branch. The deterministic
    // issue-fix branch name can collide with prior GitWire work or human work;
    // branch ownership is not proven by its name. Treat any existing ref as a
    // no-effect supersession before idempotency is consumed.
    let existingBranchSha = null;
    try {
      const { data: existingBranch } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
        owner,
        repo: repoName,
        branch: branchName,
      });
      existingBranchSha = existingBranch?.object?.sha || "unknown";
    } catch (refErr) {
      if (refErr?.status !== 404) throw refErr;
    }
    if (existingBranchSha) {
      await supersedeFix({
        ctx,
        analysis,
        fixAction,
        reason: "Issue-fix branch already exists before submission",
        detail: "Refusing to overwrite existing branch " + branchName,
        log: { branchName, existingBranchSha },
      });
      return;
    }

    // Legacy idempotency remains for this bounded change, but the marker is
    // resource-scoped and written only after every no-effect freshness fence.
    // Wave 3 will replace it with durable command/effect idempotency.
    idempotencyKey = "repo-" + repoId + ":issue-" + issueNumber;
    if (!(await checkAndMark("issue_fix", idempotencyKey))) {
      await cancel(fixAction.id, "Duplicate issue-fix submission");
      logger.info({ repo, issueNumber, idempotencyKey }, "Issue fix submission already marked — skipping duplicate");
      return;
    }

    // Branch creation is create-only. If another actor wins the check/create
    // race, confirm the ref now exists and convert the 422 into the same safe
    // no-effect supersession used by the preflight collision fence.
    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo: repoName,
        ref: "refs/heads/" + branchName,
        sha: baseSha,
      });
      ownedBranchHeadSha = baseSha;
    } catch (refErr) {
      if (refErr?.status === 422) {
        try {
          const { data: racedBranch } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
            owner,
            repo: repoName,
            branch: branchName,
          });
          const racedBranchSha = racedBranch?.object?.sha;
          if (racedBranchSha) {
            await clearSubmissionMarker(idempotencyKey);
            await supersedeFix({
              ctx,
              analysis,
              fixAction,
              reason: "Issue-fix branch appeared during submission",
              detail: "Refusing to overwrite branch created during issue-fix submission race: " + branchName,
              log: { branchName, racedBranchSha },
            });
            return;
          }
        } catch (confirmErr) {
          if (confirmErr?.status !== 404) throw confirmErr;
        }
      }
      throw refErr;
    }

    for (const fix of fixes) {
      const origFile = fileContents.find((f) => f.path === fix.path);
      if (!origFile) throw new Error("Original content not found for " + fix.path);

      if (fix.fixed_content === origFile.content) {
        logger.warn({ path: fix.path }, "AI returned identical content — skipping");
        continue;
      }

      const fixedB64 = Buffer.from(fix.fixed_content).toString("base64");
      const { data: writeResult } = await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo: repoName,
        path: fix.path,
        message: fix.commit_message || ("fix: " + truncate(fix.explanation || fix.path, 72)),
        content: fixedB64,
        sha: origFile.sha,
        branch: branchName,
      });
      // Contents writes return the commit that advanced the branch. Track the
      // exact head owned by this invocation so cleanup never deletes later human
      // or concurrent work.
      if (writeResult?.commit?.sha) ownedBranchHeadSha = writeResult.commit.sha;

      logger.info({ path: fix.path, explanation: fix.explanation }, "Fix committed");
    }

    const confidence = calibrateConfidence(analysis, fileContents.length, fixes.length);
    const convention = await detectConvention(octokit, owner, repoName);
    const mainFile = fixes[0]?.path || "";
    const scope = extractScope(mainFile);
    var prTitle = formatPRTitle(convention, "fix", scope, truncate(ctx._scope.issue.title, 60), issueNumber);
    var prBody = buildPRBodyFullFile(ctx._scope.issue, analysis, fixes, issueNumber, confidence, baseSha, ctx.triggeredBy);

    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo: repoName,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    });
    // From this point forward the branch is the base of an externally visible PR
    // and must never be deleted by local recovery logic.
    prCreated = true;

    logger.info({ repo, issueNumber, prNumber: pr.number, prUrl: pr.html_url, confidence, baseSha }, "Fix PR created");

    await succeed(fixAction.id, {
      pr_number: pr.number,
      pr_url: pr.html_url,
      branch: branchName,
      base_sha: baseSha,
    });

    notifyIssueFix(repo, {
      issue_number: issueNumber,
      status: "fix_pr_created",
    }).catch((err) => {
      logger.warn({ err: err.message, repo }, "Telegram issue-fix notification failed (non-fatal)");
    });

    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo: repoName,
        issue_number: pr.number,
        labels: ["gitwire-fix", analysis.complexity || "unknown-complexity"],
      });
    } catch (err) {
      logger.warn({ err: err.message || err, repo, prNumber: pr.number }, "Failed to label issue-fix PR (non-fatal)");
    }

    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F527} **GitWire Fix - PR submitted**\n\n" +
      "**PR:** [#" + pr.number + "](" + pr.html_url + ")\n" +
      "**Complexity:** " + (analysis.complexity || "unknown") + "\n" +
      "**Confidence:** " + confidence + "\n" +
      "**Reviewed head:** `" + baseSha.slice(0, 12) + "`\n" +
      "**Changes:** " + fixes.length + " file" + (fixes.length > 1 ? "s" : "") + "\n\n" +
      "**Assessment:** " + (analysis.explanation || "") + "\n\n" +
      (confidence === "low" ? "\u26A0\uFE0F Low confidence — please review carefully.\n\n" : "") +
      "_Please review before merging._"
    );

    await upsertFixAttempt(repoId, issueNumber, branchName, "submitted",
      analysis.complexity, analysis.explanation, null, pr.number);

  } catch (err) {
    logger.error({ err, repo, issueNumber }, "Fix PR creation failed");

    let partialBranchCleaned = false;
    if (!prCreated && ownedBranchHeadSha) {
      partialBranchCleaned = await cleanupOwnedBranch({
        octokit,
        owner,
        repoName,
        branchName,
        ownedHeadSha: ownedBranchHeadSha,
        repo,
        issueNumber,
      });
      if (partialBranchCleaned) await clearSubmissionMarker(idempotencyKey);
    }

    try {
      await fail(fixAction.id, err.message);
    } catch (stateErr) {
      logger.warn({ err: stateErr.message || stateErr, actionId: fixAction.id }, "Failed to terminalize issue-fix action after submission error");
    }
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed",
      analysis.complexity, analysis.explanation, "PR creation failed: " + err.message);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u274C **GitWire Fix - PR creation failed**\n\n" +
      "The fix was generated but could not be submitted:\n> " + err.message + "\n\n" +
      "**Assessment:** " + (analysis.explanation || "") + "\n\n" +
      (partialBranchCleaned
        ? "GitWire removed the partial branch and requested release of the legacy submission marker. If an immediate retry is still deduplicated, wait for the marker to expire before retrying.\n\n"
        : (ownedBranchHeadSha && !prCreated
            ? "GitWire could not prove the partial branch was still exclusively owned; inspect `" + branchName + "` before retrying.\n\n"
            : "")) +
      "_A maintainer may need to intervene._"
    );
  }
}

function calibrateConfidence(analysis, filesFetched, fixesGenerated) {
  let confidence = "high";
  if (analysis.complexity === "moderate") confidence = "medium";
  if (analysis.complexity === "complex") confidence = "low";
  const targetFiles = analysis.relevant_files?.length || 0;
  if (filesFetched < targetFiles) confidence = "low";
  if (fixesGenerated === 0) confidence = "low";
  return confidence;
}

function buildPRBodyFullFile(issue, analysis, fixes, issueNumber, confidence, baseSha, triggeredBy) {
  const triggerText = triggeredBy === "api" ? "API request" : "`/gitwire fix`";
  var lines = [
    "## \u{1F527} GitWire Autonomous Fix",
    "",
    "Fixes #" + issueNumber,
    "",
    "**Complexity:** " + (analysis.complexity || "unknown"),
    "**Confidence:** " + (confidence || "unknown"),
    "**Reviewed head:** `" + baseSha + "`",
    "**Strategy:** " + (analysis.fix_strategy || ""),
    "",
    "### Assessment",
    analysis.explanation || "",
    "",
    "### Changes",
    "",
  ];

  for (const f of fixes) {
    lines.push("- **" + f.path + "**" + (f.explanation ? ": " + f.explanation : ""));
  }

  lines.push("");
  lines.push("---");
  lines.push("*This PR was automatically generated by [GitWire](https://gitwire.erlab.uk).*");
  lines.push("*Review carefully before merging. Triggered by " + triggerText + ".*");
  if (confidence === "low") lines.push("*\u26A0\uFE0F Low confidence fix — please verify all changes are correct.*");

  return lines.join("\n");
}
