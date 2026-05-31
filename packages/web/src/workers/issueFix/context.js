// src/workers/issueFix/context.js
// Stage 1: Initialize fix context — idempotency, config, rate limit, DB lookup.

import { checkAndMark } from "../../services/idempotencyService.js";
import { getConfigForRepo } from "../../services/configService.js";
import { isPillarEnabled } from "@gitwire/rules";
import { getInstallationClient } from "../../lib/github.js";
import { wrapOctokit } from "../../lib/githubWrapper.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";

/**
 * Returns the fix context object, or null if the pipeline should stop.
 * CC target: ~6
 */
export async function initFixContext({ repo, issueNumber, installationId, triggeredBy }) {
  logger.info({ repo, issueNumber, triggeredBy }, "Issue fix pipeline started");

  // ── Idempotency ──────────────────────────────────────────────────────────
  if (!(await checkAndMark("issue_fix", "issue-" + issueNumber))) {
    return null;
  }

  // ── Pillar config ────────────────────────────────────────────────────────
  const repoConfig = await getConfigForRepo(repo);
  if (!isPillarEnabled("issue_fix", repoConfig)) {
    logger.info({ repo, issueNumber }, "Issue fix disabled for repo — skipping");
    return null;
  }

  // ── DB repo lookup ───────────────────────────────────────────────────────
  const { rows: repoRows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1", [repo]
  );
  if (!repoRows.length) {
    logger.error({ repo }, "Repo not found in DB");
    return null;
  }
  const repoId = repoRows[0].github_id;

  // ── GitHub client ────────────────────────────────────────────────────────
  const octokit = wrapOctokit(await getInstallationClient(installationId));
  const branchName = "gitwire/fix-" + issueNumber;
  const owner = repo.split("/")[0];
  const repoName = repo.split("/")[1];

  return {
    repo,
    owner,
    repoName,
    repoId,
    issueNumber,
    installationId,
    triggeredBy,
    branchName,
    octokit,
    repoConfig,
  };
}
