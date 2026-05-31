// src/lib/webhookHandlers/handleSpamGate.js
// Spam gate: checks if a PR/issue author has too many open items.
// Auto-closes and labels spam. Configurable per-repo via .gitwire.yml.

import { logger } from "../../lib/logger.js";

const DEFAULT_MAX_OPEN_PRS = 10;
const DEFAULT_MAX_OPEN_ISSUES = 15;

/**
 * Check if an item should be blocked by the spam gate.
 * Call from handlePullRequest and handleIssues for "opened" actions.
 *
 * Returns { blocked: boolean, reason?: string }
 */
export async function checkSpamGate(ctx, payload, itemType) {
  // itemType: "pull_request" or "issue"
  const { repository, installation } = payload;
  const owner = repository.owner.login;
  const repo = repository.name;
  const author = itemType === "pull_request"
    ? payload.pull_request.user.login
    : payload.issue.user.login;

  // Check if the repo has spam_gate enabled
  let spamConfig = null;
  try {
    const { getConfigForRepo } = await import("../../services/configService.js");
    const repoConfig = await getConfigForRepo(owner, repo, installation?.id);
    spamConfig = repoConfig?.pillars?.spam_gate;
  } catch (_e) {
    // Config not available — skip spam gate
    return { blocked: false };
  }

  if (!spamConfig || !spamConfig.enabled) {
    return { blocked: false };
  }

  // Get the item to check exempt labels
  const item = itemType === "pull_request" ? payload.pull_request : payload.issue;
  const itemLabels = (item.labels || []).map((l) => l.name || l);
  const exemptLabels = spamConfig.exempt_labels || [];

  if (exemptLabels.some((el) => itemLabels.includes(el))) {
    logger.debug({ owner, repo, author, itemType }, "Spam gate bypassed: exempt label");
    return { blocked: false };
  }

  // Check exempt users
  const exemptUsers = spamConfig.exempt_users || [];
  if (exemptUsers.includes(author)) {
    logger.debug({ owner, repo, author, itemType }, "Spam gate bypassed: exempt user");
    return { blocked: false };
  }

  // Get installation client for API calls
  let octokit;
  try {
    octokit = await ctx.getInstallationClient(installation.id);
    octokit = ctx.wrapOctokit(octokit);
  } catch (err) {
    logger.error({ err, owner, repo }, "Spam gate: failed to get installation client");
    return { blocked: false }; // fail open
  }

  // Check if author is a collaborator with write+ permission — bypass
  try {
    const { data: perm } = await octokit.request("GET /repos/{owner}/{repo}/collaborators/{username}/permission", {
      owner, repo, username: author,
    });
    if (["admin", "maintain", "write"].includes(perm.permission)) {
      logger.debug({ owner, repo, author, perm: perm.permission }, "Spam gate bypassed: collaborator");
      return { blocked: false };
    }
  } catch (_e) {
    // 404 = not a collaborator, proceed with check
  }

  // Count author's open items using search API
  const queryType = itemType === "pull_request" ? "type:pr" : "type:issue";
  const threshold = itemType === "pull_request"
    ? (spamConfig.max_open_prs || DEFAULT_MAX_OPEN_PRS)
    : (spamConfig.max_open_issues || DEFAULT_MAX_OPEN_ISSUES);

  try {
    const { data } = await octokit.request("GET /search/issues", {
      q: "repo:" + owner + "/" + repo + " " + queryType + " is:open author:" + author,
      per_page: 1, // We only need total_count
    });

    const count = data.total_count;

    if (count > threshold) {
      logger.info({ owner, repo, author, itemType, count, threshold }, "Spam gate: blocking item");

      // Close the item
      const itemNumber = item.number;
      const closeMessage = spamConfig.close_message ||
        "Automatically closed: too many open items from this author. Contact maintainers if this is a mistake.";

      try {
        // Close the item
        const closeEndpoint = itemType === "pull_request"
          ? "PATCH /repos/{owner}/{repo}/pulls/{pull_number}"
          : "PATCH /repos/{owner}/{repo}/issues/{issue_number}";
        const closeParams = itemType === "pull_request"
          ? { owner, repo, pull_number: itemNumber, state: "closed" }
          : { owner, repo, issue_number: itemNumber, state: "closed", state_reason: "not_planned" };

        await octokit.request(closeEndpoint, closeParams);

        // Add spam label
        try {
          await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
            owner, repo, issue_number: itemNumber,
            labels: ["spam"],
          });
        } catch (_e) { /* label creation non-critical */ }

        // Post explanation comment
        try {
          await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
            owner, repo, issue_number: itemNumber,
            body: "🚫 **Spam Gate**\n\n" +
              closeMessage + "\n\n" +
              "Open " + queryType.split(":")[1].toUpperCase() + "s by @" + author + ": " + count +
              " (threshold: " + threshold + ")\n\n" +
              "_Automatically detected by [GitWire](https://gitwire.erlab.uk)._",
          });
        } catch (_e) { /* comment non-critical */ }

        // Log the event
        ctx.logger.info({
          owner, repo, author, itemNumber, itemType,
          count, threshold,
          action: "spam_gate_close",
        }, "Spam gate closed item");

        return { blocked: true, reason: "spam_gate", count, threshold };
      } catch (closeErr) {
        logger.error({ err: closeErr, owner, repo, itemNumber }, "Spam gate: failed to close item");
        return { blocked: false }; // fail open on close error
      }
    }

    // Under threshold — allow
    return { blocked: false };
  } catch (searchErr) {
    // On API error (rate limit, etc.), fail open
    logger.warn({ err: searchErr, owner, repo, author }, "Spam gate: search API error, allowing through");
    return { blocked: false };
  }
}
