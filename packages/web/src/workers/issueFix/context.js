// src/workers/issueFix/context.js
// Stage 1: Initialize fix context — config + server-resolved repository binding.
//
// D0-02: repository/installation authority is resolved by issueFixWorker from
// current server-owned state. This stage does not accept a client-selected
// installation id or perform a second weaker lookup by repository name.

import { getConfigForRepo } from "../../services/configService.js";
import { isPillarEnabled, isDryRun } from "@gitwire/rules";
import { getInstallationClient } from "../../lib/github.js";
import { wrapOctokit } from "../../lib/githubWrapper.js";
import { logger } from "../../lib/logger.js";

function dryRunGuard(octokit, dryRun) {
  if (!dryRun) return octokit;

  // Mechanical dry-run boundary for this capability. Expose only the explicit
  // request(method + route) surface so every permitted read is classifiable as
  // GET/HEAD. Alternate Octokit call surfaces (rest.*, graphql, paginate, etc.)
  // are deliberately absent: future code cannot silently bypass this guard by
  // switching client styles.
  const request = async (route, params) => {
    const match = /^\s*(GET|HEAD)\s+/i.exec(String(route ?? ""));
    if (match) return octokit.request(route, params);
    logger.info({ route }, "DRY RUN: blocked issue-fix GitHub mutation");
    return { data: { dry_run: true } };
  };

  return Object.freeze({ request });
}

/**
 * Returns the fix context object, or null if the pipeline should stop.
 * CC target: ~6
 */
export async function initFixContext({
  repository,
  issueNumber,
  triggeredBy,
  requestedByLogin = null,
  requestedByPrincipalId = null,
  principalId = null,
}) {
  const repo = repository?.full_name;
  logger.info({ repo, issueNumber, triggeredBy }, "Issue fix pipeline started");

  if (!repository?.github_id || !repository?.installation_id || !repo) {
    throw new Error("Issue-fix execution context is missing trusted repository binding");
  }

  const installationId = Number(repository.installation_id);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new Error("Issue-fix installation id cannot be represented safely by the current GitHub runtime");
  }

  const repoConfig = await getConfigForRepo(repo);
  if (!isPillarEnabled("issue_fix", repoConfig)) {
    logger.info({ repo, issueNumber }, "Issue fix disabled for repo — skipping");
    return null;
  }
  const dryRun = isDryRun(repoConfig);

  // Exact-head and pre-effect authority checks must never consume the shared
  // GitHub GET cache. The issue-fix pipeline deliberately uses one cache-bypassed
  // wrapper throughout so its tree, file and freshness evidence all refer to
  // live GitHub state or immutable refs, while rate-limit tracking is preserved.
  const wrappedOctokit = wrapOctokit(
    await getInstallationClient(installationId),
    { skipCache: true },
  );
  const octokit = dryRunGuard(wrappedOctokit, dryRun);
  const branchName = "gitwire/fix-" + issueNumber;

  return {
    repository,
    repo,
    owner: repository.owner,
    repoName: repository.name,
    repoId: repository.github_id,
    installationId,
    issueNumber,
    triggeredBy,
    requestedByLogin,
    requestedByPrincipalId,
    principalId,
    branchName,
    octokit,
    repoConfig,
    dryRun,
  };
}
