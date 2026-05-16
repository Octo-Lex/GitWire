// src/services/maintainerService.js
// GitWire Maintainer v2: settings, actions, org governance.
// Syncs org members, repo collaborators, and branch protection rules
// from GitHub into local Postgres tables.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

export const maintainerService = {
  // ── Settings ──────────────────────────────────────────────────────────────

  async getSettings(repoId) {
    const { rows } = await db.query(
      "SELECT * FROM maintainer_settings WHERE repo_id = $1",
      [repoId]
    );
    return rows[0] || null;
  },

  async upsertSettings(repoId, patch) {
    const setClauses = [];
    const values = [];
    let idx = 1;

    for (const [key, val] of Object.entries(patch)) {
      if (["stale_issue_days", "stale_pr_days", "stale_warn_days", "cleanup_branches", "enabled"].includes(key)) {
        setClauses.push(key + " = $" + idx);
        values.push(val);
        idx++;
      }
    }

    if (setClauses.length === 0) return null;

    setClauses.push("updated_at = NOW()");
    values.push(repoId);

    await db.query(
      `INSERT INTO maintainer_settings (repo_id, updated_at)
       VALUES ($${idx}, NOW())
       ON CONFLICT (repo_id) DO UPDATE SET ${setClauses.join(", ")}`,
      values
    );

    return maintainerService.getSettings(repoId);
  },

  // ── Action recording (idempotency) ────────────────────────────────────────

  async recordAction(repoId, { actionType, targetType, targetNumber, idempotencyKey, status, result }) {
    await db.query(
      `INSERT INTO maintainer_actions
         (repo_id, action_type, target_type, target_number, idempotency_key, status, result, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${status === "applied" ? "NOW()" : "NULL"})
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [repoId, actionType, targetType, targetNumber, idempotencyKey, status || "pending", result || null]
    );
  },

  async actionExists(idempotencyKey) {
    const { rows } = await db.query(
      "SELECT 1 FROM maintainer_actions WHERE idempotency_key = $1",
      [idempotencyKey]
    );
    return rows.length > 0;
  },

  // ── Action history ────────────────────────────────────────────────────────

  async listActions(repoId, { limit = 50, offset = 0 } = {}) {
    const { rows } = await db.query(
      `SELECT * FROM maintainer_actions
       WHERE repo_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [repoId, limit, offset]
    );
    return rows;
  },

  async getActionStats(repoId) {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'applied')   AS applied,
         COUNT(*) FILTER (WHERE status = 'skipped')   AS skipped,
         COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
         COUNT(*) FILTER (WHERE status = 'pending')   AS pending,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS last_7_days
       FROM maintainer_actions
       WHERE repo_id = $1`,
      [repoId]
    );
    return rows[0];
  },
};

// ── Org governance: Members ───────────────────────────────────────────────────

/**
 * Sync all org members for an installation from GitHub.
 */
export async function syncMembers(octokit, installationId, org) {
  logger.info({ org }, "Syncing org members");

  let members = [];
  try {
    let page = 1;
    while (true) {
      const { data } = await octokit.request('GET /orgs/{org}/members', { org, per_page: 100, page });
      if (!data.length) break;
      members = members.concat(data);
      page++;
    }
  } catch (err) {
    logger.warn({ org, err: err.message }, "Could not list org members — may lack org:read scope");
    return;
  }

  for (const m of members) {
    let role = "member";
    try {
      const { data: membership } = await octokit.request('GET /orgs/{org}/memberships/{username}', {
        org, username: m.login,
      });
      role = membership.role === "admin" ? "owner" : "member";
    } catch { /* non-member or no access */ }

    await db.query(
      `INSERT INTO members
         (installation_id, github_login, github_id, avatar_url, role, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (installation_id, github_login) DO UPDATE SET
         github_id  = EXCLUDED.github_id,
         avatar_url = EXCLUDED.avatar_url,
         role       = EXCLUDED.role,
         updated_at = NOW()`,
      [installationId, m.login, m.id, m.avatar_url, role]
    );
  }

  logger.info({ org, count: members.length }, "Members synced");
}

// ── Org governance: Repo collaborators ────────────────────────────────────────

/**
 * Sync collaborators for a single repo.
 */
export async function syncCollaborators(octokit, owner, repo, repoGithubId) {
  let collabs = [];
  try {
    let page = 1;
    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/collaborators', {
        owner, repo, per_page: 100, page,
      });
      if (!data.length) break;
      collabs = collabs.concat(data);
      page++;
    }
  } catch (err) {
    logger.warn({ repo: owner + "/" + repo, err: err.message }, "Could not list collaborators");
    return;
  }

  for (const c of collabs) {
    const perms = c.permissions ?? {};
    const level =
      perms.admin    ? "admin"    :
      perms.maintain ? "maintain" :
      perms.push     ? "push"     :
      perms.triage   ? "triage"   : "pull";

    await db.query(
      `INSERT INTO repo_collaborators
         (repo_id, github_login, github_id, avatar_url, permission, role_name, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (repo_id, github_login) DO UPDATE SET
         permission = EXCLUDED.permission,
         role_name  = EXCLUDED.role_name,
         avatar_url = EXCLUDED.avatar_url,
         updated_at = NOW()`,
      [repoGithubId, c.login, c.id, c.avatar_url, level, c.role_name ?? null]
    );
  }

  logger.debug({ repo: `${owner}/${repo}`, count: collabs.length }, "Collaborators synced");
}

// ── Org governance: Branch protection rules ───────────────────────────────────

/**
 * Sync branch protection rules for a repo.
 */
export async function syncBranchRules(octokit, owner, repo, repoGithubId) {
  let branches = [];
  try {
    let page = 1;
    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches', {
        owner, repo, protected: true, per_page: 100, page,
      });
      if (!data.length) break;
      branches = branches.concat(data);
      page++;
    }
  } catch (err) {
    if (err.status === 404) return;
    throw err;
  }

  for (const branch of branches) {
    try {
      const { data: rule } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
        owner, repo, branch: branch.name,
      });

      const pr = rule.required_pull_request_reviews;
      const sc = rule.required_status_checks;

      await db.query(
        `INSERT INTO branch_rules
           (repo_id, pattern,
            required_reviews, dismiss_stale_reviews, require_code_owner_reviews,
            require_status_checks, required_status_checks, require_up_to_date_branch,
            enforce_admins, allow_force_pushes, allow_deletions,
            github_rule_id, synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
         ON CONFLICT (repo_id, pattern) DO UPDATE SET
           required_reviews             = EXCLUDED.required_reviews,
           dismiss_stale_reviews        = EXCLUDED.dismiss_stale_reviews,
           require_code_owner_reviews   = EXCLUDED.require_code_owner_reviews,
           require_status_checks        = EXCLUDED.require_status_checks,
           required_status_checks       = EXCLUDED.required_status_checks,
           require_up_to_date_branch    = EXCLUDED.require_up_to_date_branch,
           enforce_admins               = EXCLUDED.enforce_admins,
           allow_force_pushes           = EXCLUDED.allow_force_pushes,
           allow_deletions              = EXCLUDED.allow_deletions,
           synced_at                    = NOW(),
           updated_at                   = NOW()`,
        [
          repoGithubId,
          branch.name,
          pr?.required_approving_review_count ?? 0,
          pr?.dismiss_stale_reviews            ?? false,
          pr?.require_code_owner_reviews        ?? false,
          !!sc,
          sc?.contexts ?? [],
          sc?.strict    ?? false,
          rule.enforce_admins?.enabled ?? false,
          rule.allow_force_pushes?.enabled ?? false,
          rule.allow_deletions?.enabled    ?? false,
          null,
        ]
      );
    } catch (err) {
      if (err.status !== 404) {
        logger.warn({ branch: branch.name, repo: `${owner}/${repo}`, err: err.message }, "Could not fetch branch protection");
      }
    }
  }

  logger.debug({ repo: `${owner}/${repo}`, count: branches.length }, "Branch rules synced");
}

// ── Audit log helper ─────────────────────────────────────────────────────────

/**
 * Write an entry to the audit_log table.
 */
export async function audit({ actor, action, targetType, targetId, payload, success = true, error = null }) {
  await db.query(
    `INSERT INTO audit_log (actor, action, target_type, target_id, payload, success, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor, action, targetType, targetId, payload ? JSON.stringify(payload) : null, success, error]
  );
}
