// src/workers/issueFix/submit.js
// Stage 6: pre-effect authority/head/idempotency fence → branch → commit fixes → open PR.

import { succeed, fail, cancel } from "../../services/actionStateMachine.js";
import { checkAndMark } from "../../services/idempotencyService.js";
import { notifyIssueFix } from "../../services/telegramNotifyService.js";
import { detectConvention, formatPRTitle, extractScope } from "../../services/conventionDetector.js";
import {
  resolveIssueFixRepositoryById,
  sameIssueFixRepositoryBinding,
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

/** Creates the branch, commits fixes, opens PR. */
export async function submitFix(ctx, analysis, validated) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repo, repository } = ctx;
  const { fixes, fileContents, fixAction } = validated;
  const baseSha = ctx._scope?.baseSha;
  const defaultBranch = ctx._scope?.defaultBranch;

  try {
    if (!baseSha || !defaultBranch) {
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

    // Legacy idempotency remains for this bounded change, but the marker is
    // resource-scoped and written only after every no-effect freshness fence.
    // Wave 3 will replace it with durable command/effect idempotency.
    const idempotencyKey = "repo-" + repoId + ":issue-" + issueNumber;
    if (!(await checkAndMark("issue_fix", idempotencyKey))) {
      await cancel(fixAction.id, "Duplicate issue-fix submission");
      logger.info({ repo, issueNumber, idempotencyKey }, "Issue fix submission already marked — skipping duplicate");
      return;
    }

    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo: repoName,
        ref: "refs/heads/" + branchName,
        sha: baseSha,
      });
    } catch (refErr) {
      if (refErr.status === 422) {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner,
          repo: repoName,
          ref: "heads/" + branchName,
          sha: baseSha,
          force: true,
        });
        logger.info({ branch: branchName, baseSha }, "Force-updated existing issue-fix branch to reviewed head");
      } else {
        throw refErr;
      }
    }

    for (const fix of fixes) {
      const origFile = fileContents.find((f) => f.path === fix.path);
      if (!origFile) throw new Error("Original content not found for " + fix.path);

      if (fix.fixed_content === origFile.content) {
        logger.warn({ path: fix.path }, "AI returned identical content — skipping");
        continue;
      }

      const fixedB64 = Buffer.from(fix.fixed_content).toString("base64");
      await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner,
        repo: repoName,
        path: fix.path,
        message: fix.commit_message || ("fix: " + truncate(fix.explanation || fix.path, 72)),
        content: fixedB64,
        sha: origFile.sha,
        branch: branchName,
      });

      logger.info({ path: fix.path, explanation: fix.explanation }, "Fix committed");
    }

    const confidence = calibrateConfidence(analysis, fileContents.length, fixes.length);
    const convention = await detectConvention(octokit, owner, repoName);
    const mainFile = fixes[0]?.path || "";
    const scope = extractScope(mainFile);
    var prTitle = formatPRTitle(convention, "fix", scope, truncate(ctx._scope.issue.title, 60), issueNumber);
    var prBody = buildPRBodyFullFile(ctx._scope.issue, analysis, fixes, issueNumber, confidence, baseSha);

    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo: repoName,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    });

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

function buildPRBodyFullFile(issue, analysis, fixes, issueNumber, confidence, baseSha) {
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
  lines.push("*Review carefully before merging. Triggered by `/gitwire fix`.*");
  if (confidence === "low") lines.push("*\u26A0\uFE0F Low confidence fix — please verify all changes are correct.*");

  return lines.join("\n");
}
