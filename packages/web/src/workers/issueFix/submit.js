// src/workers/issueFix/submit.js
// Stage 6: Create branch → commit fixes → open PR → post comments.

import { getMinFixConfidence } from "@gitwire/rules";
import { succeed, fail } from "../../services/actionStateMachine.js";
import { notifyIssueFix } from "../../services/telegramNotifyService.js";
import { detectConvention, formatPRTitle, extractScope } from "../../services/conventionDetector.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment, truncate } from "./helpers.js";

/**
 * Creates the branch, commits fixes, opens PR.
 * CC target: ~8
 */
export async function submitFix(ctx, analysis, validated) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo } = ctx;
  const { fixes, fileContents, preConfidence, fixAction } = validated;

  try {
    const { data: repoInfo } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo: repoName });
    const defaultBranch = repoInfo.default_branch;

    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner, repo: repoName, branch: defaultBranch,
    });

    // Create or force-update branch
    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner, repo: repoName,
        ref: "refs/heads/" + branchName,
        sha: ref.object.sha,
      });
    } catch (refErr) {
      if (refErr.status === 422) {
        await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner, repo: repoName,
          ref: "heads/" + branchName,
          sha: ref.object.sha,
          force: true,
        });
        logger.info({ branch: branchName }, "Force-updated existing branch");
      } else {
        throw refErr;
      }
    }

    // Commit fixes
    for (const fix of fixes) {
      const origFile = fileContents.find((f) => f.path === fix.path);
      if (!origFile) {
        throw new Error("Original content not found for " + fix.path);
      }

      if (fix.fixed_content === origFile.content) {
        logger.warn({ path: fix.path }, "AI returned identical content — skipping");
        continue;
      }

      const fixedB64 = Buffer.from(fix.fixed_content).toString("base64");
      await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
        owner, repo: repoName,
        path: fix.path,
        message: fix.commit_message || ("fix: " + truncate(fix.explanation || fix.path, 72)),
        content: fixedB64,
        sha: origFile.sha,
        branch: branchName,
      });

      logger.info({ path: fix.path, explanation: fix.explanation }, "Fix committed");
    }

    // Calibrate confidence
    const confidence = calibrateConfidence(analysis, fileContents.length, fixes.length);

    // Detect repo commit convention and format PR title accordingly
    const convention = await detectConvention(octokit, owner, repoName);
    const mainFile = fixes[0]?.path || "";
    const scope = extractScope(mainFile);
    var prTitle = formatPRTitle(convention, "fix", scope, truncate(ctx._scope.issue.title, 60), issueNumber);
    var prBody = buildPRBodyFullFile(ctx._scope.issue, analysis, fixes, issueNumber, confidence);

    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner, repo: repoName,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: defaultBranch,
    });

    logger.info({ repo, issueNumber, prNumber: pr.number, prUrl: pr.html_url, confidence }, "Fix PR created");

    // Mark action as succeeded
    await succeed(fixAction.id, { pr_number: pr.number, pr_url: pr.html_url, branch: branchName });

    // Notify Telegram subscribers (non-blocking but caught)
    notifyIssueFix(repo, {
      issue_number: issueNumber,
      status: "fix_pr_created",
    }).catch((err) => {
      logger.warn({ err: err.message, repo }, "Telegram issue-fix notification failed (non-fatal)");
    });

    // Add labels to PR
    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner, repo: repoName, issue_number: pr.number,
        labels: ["gitwire-fix", analysis.complexity || "unknown-complexity"],
      });
    } catch (_) { /* non-critical */ }

    // Comment on issue linking to PR
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F527} **GitWire Fix - PR submitted**\n\n" +
      "**PR:** [#" + pr.number + "](" + pr.html_url + ")\n" +
      "**Complexity:** " + (analysis.complexity || "unknown") + "\n" +
      "**Confidence:** " + confidence + "\n" +
      "**Changes:** " + fixes.length + " file" + (fixes.length > 1 ? "s" : "") + "\n\n" +
      "**Assessment:** " + (analysis.explanation || "") + "\n\n" +
      (confidence === "low" ? "\u26A0\uFE0F Low confidence \u2014 please review carefully.\n\n" : "") +
      "_Please review before merging._"
    );

    // Record success
    await upsertFixAttempt(repoId, issueNumber, branchName, "submitted",
      analysis.complexity, analysis.explanation, null, pr.number);

  } catch (err) {
    logger.error({ err, repo, issueNumber }, "Fix PR creation failed");
    await fail(fixAction.id, err.message).catch(() => {});
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

// ── Confidence calibration ────────────────────────────────────────────────

function calibrateConfidence(analysis, filesFetched, fixesGenerated) {
  let confidence = "high";

  if (analysis.complexity === "moderate") confidence = "medium";
  if (analysis.complexity === "complex") confidence = "low";

  const targetFiles = analysis.relevant_files?.length || 0;
  if (filesFetched < targetFiles) confidence = "low";

  if (fixesGenerated === 0) confidence = "low";

  return confidence;
}

// ── Build PR body ──────────────────────────────────────────────────────────

function buildPRBodyFullFile(issue, analysis, fixes, issueNumber, confidence) {
  var lines = [
    "## \u{1F527} GitWire Autonomous Fix",
    "",
    "Fixes #" + issueNumber,
    "",
    "**Complexity:** " + (analysis.complexity || "unknown"),
    "**Confidence:** " + (confidence || "unknown"),
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
  if (confidence === "low") {
    lines.push("*\u26A0\uFE0F Low confidence fix \u2014 please verify all changes are correct.*");
  }

  return lines.join("\n");
}
