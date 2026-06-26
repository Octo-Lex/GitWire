// src/lib/reconcileRepository.js
// Repository identity reconciliation (PR #33).
//
// The durable repository identity is GitHub's numeric repository ID, not
// owner/name. When a repo is renamed or transferred, full_name/owner/name
// change but github_id stays constant.
//
// This module upserts the repository row by github_id on every webhook event,
// ensuring downstream handlers find the repo by its CURRENT identity — not a
// stale full_name from when the repo was first registered.
//
// Bug: previously, handleRepoSync (the only reconciliation path) was called
// ONLY on push events. workflow_run / check_run / pull_request events carried
// the current full_name but the DB row stayed stale, causing CI evidence to
// be silently dropped for renamed/transferred repos.

import { db } from "./db.js";
import { logger } from "./logger.js";

/**
 * Reconcile a repository's identity from any webhook payload.
 * Upserts by github_id, updating full_name/owner/name/default_branch/private.
 *
 * @param {object} payload - webhook payload with payload.repository and payload.installation
 * @returns {Promise<object|null>} the reconciled repo row ({ id, github_id, full_name }), or null on error/missing data
 */
export async function reconcileRepositoryFromWebhook(payload) {
  const repo = payload?.repository;
  if (!repo || !repo.id) return null;

  const installationId = payload?.installation?.id || null;

  try {
    const { rows } = await db.query(
      `INSERT INTO repositories
         (github_id, installation_id, full_name, owner, name, private, default_branch, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (github_id) DO UPDATE SET
         full_name      = EXCLUDED.full_name,
         owner          = EXCLUDED.owner,
         name           = EXCLUDED.name,
         default_branch = EXCLUDED.default_branch,
         private        = EXCLUDED.private,
         installation_id = COALESCE(EXCLUDED.installation_id, repositories.installation_id),
         updated_at     = NOW()
       RETURNING id, github_id, full_name`,
      [
        repo.id,
        installationId,
        repo.full_name,
        repo.owner?.login || repo.full_name?.split("/")[0] || null,
        repo.name || repo.full_name?.split("/")[1] || null,
        repo.private ?? false,
        repo.default_branch || "main",
      ]
    );

    if (rows.length > 0) {
      logger.debug(
        { repoId: rows[0].id, githubId: repo.id, fullName: rows[0].full_name },
        "Repository reconciled from webhook"
      );
      return rows[0];
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: err.message, githubId: repo.id, fullName: repo.full_name },
      "Failed to reconcile repository from webhook (non-fatal)"
    );
    return null;
  }
}
