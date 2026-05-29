// src/services/errorRecoveryService.js
// Automated rollback engine for Phase 2 error recovery.
// Adapted for GitWire: octokit.request(), no silent catches.

import { db }  from "../lib/db.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { Events } from "./pipelineEvents.js";
import { sendFeedback } from "./feedbackService.js";
import { logger } from "../lib/logger.js";

const ROLLBACK_WINDOW_MINS = 30;

// ════════════════════════════════════════════════════════════════════════════
// Evaluate whether a failed workflow_run should trigger a rollback
// ════════════════════════════════════════════════════════════════════════════

export async function evaluateRollback({ run, repository, installation }) {
  logger.info({ repo: repository.full_name, conclusion: run.conclusion, head_branch: run.head_branch, default_branch: repository.default_branch }, "Rollback evaluation triggered");
  if (run.conclusion !== "failure") return;
  if (run.head_branch !== repository.default_branch) return;
  if (!isDeployWorkflow(run.name, run.path)) return;

  const repoId = repository.id;

  const { rows: [cfg] } = await db.query(
    "SELECT rollback_enabled FROM merge_queue_config WHERE repo_id = $1", [repoId]
  );
  if (!cfg?.rollback_enabled) return;

  const { rows: [recentMerge] } = await db.query(
    `SELECT mq.pr_number, mq.head_sha, mq.merged_at, mq.author_login
     FROM merge_queue_entries mq
     WHERE mq.repo_id = $1 AND mq.status = 'merged'
       AND mq.merged_at > NOW() - INTERVAL '30 minutes'
     ORDER BY mq.merged_at DESC LIMIT 1`,
    [repoId]
  );

  if (!recentMerge) {
    logger.debug({ repo: repository.full_name }, "Rollback: no recent merge in window, skipping");
    return;
  }

  logger.info(
    { repo: repository.full_name, pr: recentMerge.pr_number, run: run.id },
    "Rollback: deploy failure detected within merge window"
  );

  const octokit = wrapOctokit(await getInstallationClient(installation.id));
  await initiateRollback({ recentMerge, run, repository, octokit, repoId });
}

// ════════════════════════════════════════════════════════════════════════════
// Execute the rollback
// ════════════════════════════════════════════════════════════════════════════

async function initiateRollback({ recentMerge, run, repository, octokit, repoId }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const branch = repository.default_branch;

  const { rows: [rollback] } = await db.query(
    `INSERT INTO rollback_events (repo_id, pr_number, merge_commit, trigger_reason, trigger_details, status)
     VALUES ($1, $2, $3, 'deploy_check_failed', $4, 'pending') RETURNING id`,
    [repoId, recentMerge.pr_number, recentMerge.head_sha,
     "Deploy workflow '" + run.name + "' failed after merge"]
  );

  await Events.rollbackTriggered(repoId, {
    prNumber: recentMerge.pr_number, ref: branch, actor: "gitwire[bot]",
    metadata: { run_id: run.id, workflow: run.name },
  });

  try {
    // Get the merge commit parent
    const { data: mergeCommit } = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
      owner, repo, ref: recentMerge.head_sha,
    });

    const parentSha = mergeCommit.parents?.[0]?.sha;
    if (!parentSha) throw new Error("Could not determine parent commit for revert");

    const { data: parentCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner, repo, commit_sha: parentSha,
    });

    const { data: currentHead } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner, repo, ref: "heads/" + branch,
    });

    const revertMessage =
      "revert: auto-rollback of PR #" + recentMerge.pr_number + "\n\n" +
      "Reverts merge commit " + recentMerge.head_sha.slice(0, 7) + " due to deploy failure.\n" +
      "Deploy workflow '" + run.name + "' failed immediately after merge.\n\n" +
      "Original author: @" + recentMerge.author_login;

    const { data: revertCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner, repo,
      message: revertMessage,
      tree:    parentCommit.tree.sha,
      parents: [currentHead.object.sha],
    });

    const revertBranch = "gitwire-rollback/pr-" + recentMerge.pr_number + "-" + Date.now();
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner, repo, ref: "refs/heads/" + revertBranch, sha: revertCommit.sha,
    });

    const { data: revertPR } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner, repo,
      title: "Auto-rollback: Revert PR #" + recentMerge.pr_number,
      head:  revertBranch, base: branch,
      body:  buildRevertPRBody(recentMerge, run, repository),
    });

    try {
      await octokit.request("POST /repos/{owner}/{repo}/labels", {
        owner, repo, name: "auto-rollback", color: "e11d48",
        description: "Automatically created rollback PR by GitWire",
      });
    } catch { /* already exists */ }

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
      owner, repo, issue_number: revertPR.number, labels: ["auto-rollback"],
    }).catch(err => logger.warn({ err: err.message }, "Rollback: could not apply label"));

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: recentMerge.pr_number,
      body: buildOriginalPRComment(revertPR, run),
    }).catch(err => logger.warn({ err: err.message }, "Rollback: could not comment on original PR"));

    await db.query(
      "UPDATE rollback_events SET status = 'reverted', revert_commit = $1, revert_pr_number = $2, completed_at = NOW() WHERE id = $3",
      [revertCommit.sha, revertPR.number, rollback.id]
    );

    await Events.rollbackCompleted(repoId, {
      prNumber: recentMerge.pr_number, ref: branch, success: true,
      metadata: { revert_pr: revertPR.number, revert_sha: revertCommit.sha },
    });

    await sendFeedback({
      eventType: "pr_blocked", repoId, repository, prNumber: recentMerge.pr_number, octokit,
      data: { reason: "Deploy failure triggered auto-rollback", run_url: run.html_url, heal_pr_url: revertPR.html_url },
    });

    logger.info({ repo: repository.full_name, revertPR: revertPR.number }, "Rollback: revert PR opened");

  } catch (err) {
    logger.error({ err: err.message, repo: repository.full_name }, "Rollback: failed");

    await db.query("UPDATE rollback_events SET status = 'failed', completed_at = NOW() WHERE id = $1", [rollback.id]);

    await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner, repo, issue_number: recentMerge.pr_number,
      body: "Auto-rollback failed\n\n" + err.message + "\n\nPlease revert manually.\n\n_GitWire Error Recovery_",
    }).catch(err2 => logger.warn({ err: err2.message }, "Rollback: could not post failure comment"));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function isDeployWorkflow(name, path) {
  const keywords = ["deploy", "release", "publish", "production", "prod", "ship"];
  const target   = (name ?? "") + " " + (path ?? "");
  return keywords.some(k => target.toLowerCase().includes(k));
}

function buildRevertPRBody(merge, run, repository) {
  return [
    "## Automatic rollback", "",
    "**Reason:** Deploy workflow failed shortly after PR #" + merge.pr_number + " was merged.",
    "**Original PR:** #" + merge.pr_number,
    "**Merge commit:** " + merge.head_sha.slice(0, 7),
    "**Deploy run:** [View log](" + run.html_url + ")", "",
    "### Action required", "",
    "This PR reverts the merge commit. **Review urgently.**", "",
    "---",
    "_Auto-generated by **GitWire** error recovery_",
  ].join("\n");
}

function buildOriginalPRComment(revertPR, run) {
  return [
    "## Auto-rollback initiated", "",
    "Deploy workflow **" + run.name + "** failed shortly after this PR was merged.", "",
    "Rollback PR: **#" + revertPR.number + "** — [View](" + revertPR.html_url + ")", "",
    "---",
    "_GitWire Error Recovery_",
  ].join("\n");
}
