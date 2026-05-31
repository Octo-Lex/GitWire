// src/lib/webhookHandlers/handleRelease.js
// Handler for "release" webhook events.
//
// On release.published:
//   1. Find fix_attempts with merged PRs that haven't been tagged with a release yet
//   2. For each, post "Fixed in vX.Y.Z" comment on the original issue
//   3. Close the issue with "gitwire:fixed-in-release" label
//   4. Record a managed action

import { logger } from "../../lib/logger.js";
import { db } from "../../lib/db.js";
import { succeed } from "../../services/actionStateMachine.js";

/**
 * Handle release webhook events.
 */
export async function handleRelease(payload, deliveryId, ctx) {
  const { action, release, repository } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const fullName = repository.full_name;

  // Only act on published releases
  if (action !== "published" || !release) return;

  logger.info({ owner, repo, tag: release.tag_name, releaseId: release.id }, "Processing release event");

  let octokit;
  try {
    octokit = await ctx.getInstallationClient(payload.installation.id);
    octokit = ctx.wrapOctokit(octokit);
  } catch (err) {
    logger.error({ err, owner, repo }, "Failed to get installation client for release handler");
    return;
  }

  const tag = release.tag_name;

  // Find fix_attempts with merged PRs that reference issues in this repo
  // and haven't been marked as released yet
  try {
    const result = await db.query(`
      SELECT fa.id, fa.issue_number, fa.pr_number, fa.repo_id, a.id as action_id
      FROM fix_attempts fa
      LEFT JOIN actions a ON a.key = ('issue_fix:' || fa.repo_id || ':' || fa.issue_number)
      WHERE fa.repo_id = (SELECT id FROM repos WHERE full_name = $1)
        AND fa.status = 'submitted'
        AND fa.pr_number IS NOT NULL
        AND fa.released_at IS NULL
      ORDER BY fa.created_at DESC
    `, [fullName]);

    if (result.rows.length === 0) {
      logger.info({ owner, repo, tag }, "No unreleased fix attempts found");
      return;
    }

    logger.info({ owner, repo, tag, count: result.rows.length }, "Processing unreleased fix attempts");

    for (const row of result.rows) {
      try {
        const { issue_number, pr_number, action_id } = row;

        // Verify the PR was actually merged (not just submitted)
        try {
          const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            owner, repo, pull_number: pr_number,
          });

          if (!pr.merged) {
            logger.debug({ prNumber: pr_number, owner, repo }, "PR not merged yet, skipping");
            continue;
          }
        } catch (prErr) {
          logger.debug({ err: prErr, prNumber: pr_number }, "Could not verify PR merge status, skipping");
          continue;
        }

        // Check if the issue is still open
        let issueOpen = false;
        try {
          const { data: issue } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
            owner, repo, issue_number,
          });
          issueOpen = issue.state === "open";
        } catch (_e) {
          // Issue may have been deleted or not accessible
          logger.debug({ issueNumber: issue_number }, "Could not fetch issue state");
        }

        // Post comment on the issue
        if (issueOpen) {
          try {
            await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
              owner, repo, issue_number,
              body: "✅ **Fixed in release " + tag + "**\n\n" +
                "The fix from PR #" + pr_number + " is now included in [" + tag + "](" + release.html_url + ").\n\n" +
                "_Automatically posted by [GitWire](https://gitwire.erlab.uk)._",
            });
          } catch (commentErr) {
            logger.debug({ err: commentErr, issueNumber: issue_number }, "Could not post release comment");
          }

          // Close the issue
          try {
            await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
              owner, repo, issue_number,
              state: "closed",
              state_reason: "completed",
            });

            // Add label
            try {
              await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
                owner, repo, issue_number,
                labels: ["gitwire:fixed-in-release"],
              });
            } catch (_e) { /* label creation non-critical */ }

            logger.info({ issueNumber: issue_number, tag, prNumber: pr_number }, "Issue closed with release tag");
          } catch (closeErr) {
            logger.debug({ err: closeErr, issueNumber: issue_number }, "Could not close issue");
          }
        }

        // Mark fix_attempt as released
        await db.query(
          "UPDATE fix_attempts SET released_at = NOW(), release_tag = $1 WHERE id = $2",
          [tag, row.id]
        );

        // Update action state if exists
        if (action_id) {
          await succeed(action_id, { released_tag: tag, released_at: new Date().toISOString() }).catch(() => {});
        }

      } catch (rowErr) {
        logger.error({ err: rowErr, fixAttemptId: row.id }, "Error processing fix attempt in release");
      }
    }
  } catch (err) {
    logger.error({ err, owner, repo, tag }, "Release handler query failed");
  }
}
