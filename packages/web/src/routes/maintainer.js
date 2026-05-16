// src/routes/maintainer.js
// GitWire Maintainer v2: Org governance + stale management.
//
// ── Existing (stale management) ──────────────────────────────────────────────
// GET    /api/maintainer/:owner/:repo/settings      — get maintainer settings
// PATCH  /api/maintainer/:owner/:repo/settings      — update settings
// GET    /api/maintainer/:owner/:repo/actions        — action history
// GET    /api/maintainer/:owner/:repo/stats          — action stats
// POST   /api/maintainer/:owner/:repo/stale-scan     — trigger stale scan
// POST   /api/maintainer/:owner/:repo/branch-cleanup — trigger branch cleanup
//
// ── New (org governance) ─────────────────────────────────────────────────────
// GET    /api/maintainer/members                     — list org members
// GET    /api/maintainer/members/:login              — single member detail
// POST   /api/maintainer/members/sync                — trigger member resync
// GET    /api/maintainer/collaborators               — cross-repo collaborator list
// GET    /api/maintainer/collaborators/:owner/:repo  — collaborators for one repo
// PUT    /api/maintainer/collaborators/:owner/:repo/:login — update permission
// DELETE /api/maintainer/collaborators/:owner/:repo/:login — remove collaborator
// GET    /api/maintainer/branch-rules                — all branch rules
// GET    /api/maintainer/branch-rules/:owner/:repo   — rules for one repo
// PUT    /api/maintainer/branch-rules/:owner/:repo/:pattern — update rule
// GET    /api/maintainer/audit                       — audit log

import { Router } from "express";
import { db } from "../lib/db.js";
import { maintainerService } from "../services/maintainerService.js";
import { syncMembers, syncCollaborators, syncBranchRules, audit } from "../services/maintainerService.js";
import { maintainerQueue } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { logger } from "../lib/logger.js";

export const maintainerRouter = Router();
maintainerRouter.use(paginationMiddleware);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findRepo(fullName) {
  const { rows } = await db.query(
    "SELECT github_id, installation_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  return rows[0] || null;
}

async function getRepoAndOctokit(owner, repo) {
  const { rows } = await db.query(
    `SELECT github_id, installation_id, owner, name, full_name
     FROM repositories WHERE full_name = $1`,
    [`${owner}/${repo}`]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const octokit = await getInstallationClient(r.installation_id);
  return { repo: r, octokit };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOVERNANCE ROUTES (must come before :owner/:repo to avoid param capture)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Members ───────────────────────────────────────────────────────────────────

// GET /api/maintainer/members
maintainerRouter.get("/members", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { role, search } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return "$" + params.length; };

    if (role)   conditions.push("m.role = " + addParam(role));
    if (search) conditions.push("m.github_login ILIKE " + addParam("%" + search + "%") + "::text");

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM members m " + where, params
    );

    params.push(perPage, offset);
    const pIdx = params.length - 1;

    const { rows } = await db.query(
      `SELECT
         m.github_login, m.github_id, m.avatar_url, m.role, m.site_admin,
         m.created_at, m.updated_at,
         i.account_login AS org,
         COUNT(DISTINCT rc.repo_id) AS repo_count,
         MAX(CASE rc.permission
           WHEN 'admin'    THEN 5
           WHEN 'maintain' THEN 4
           WHEN 'push'     THEN 3
           WHEN 'triage'   THEN 2
           ELSE 1
         END) AS max_permission_rank
       FROM members m
       JOIN installations i ON i.github_id = m.installation_id
       LEFT JOIN repo_collaborators rc ON rc.github_login = m.github_login
       ${where}
       GROUP BY m.id, i.account_login
       ORDER BY m.role DESC, m.github_login
       LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// POST /api/maintainer/members/sync — must come before /:login
maintainerRouter.post("/members/sync", async (req, res, next) => {
  try {
    const { rows: installations } = await db.query(
      "SELECT github_id, account_login FROM installations WHERE deleted_at IS NULL"
    );

    let synced = 0;
    for (const inst of installations) {
      try {
        const octokit = await getInstallationClient(inst.github_id);
        await syncMembers(octokit, inst.github_id, inst.account_login);
        synced++;
      } catch (err) {
        logger.warn({ org: inst.account_login, err: err.message }, "Member sync failed for org");
      }
    }

    res.json({ synced_orgs: synced });
  } catch (err) { next(err); }
});

// GET /api/maintainer/members/:login
maintainerRouter.get("/members/:login", async (req, res, next) => {
  try {
    const { login } = req.params;

    const { rows: [member] } = await db.query(
      `SELECT m.*, i.account_login AS org
       FROM members m
       JOIN installations i ON i.github_id = m.installation_id
       WHERE m.github_login = $1`,
      [login]
    );
    if (!member) return res.status(404).json({ error: "Member not found" });

    const { rows: repoAccess } = await db.query(
      `SELECT r.full_name, r.name, r.owner, rc.permission, rc.role_name
       FROM repo_collaborators rc
       JOIN repositories r ON r.github_id = rc.repo_id
       WHERE rc.github_login = $1
       ORDER BY rc.permission DESC, r.full_name`,
      [login]
    );

    res.json({ ...member, repo_access: repoAccess });
  } catch (err) { next(err); }
});

// ── Collaborators ─────────────────────────────────────────────────────────────

// GET /api/maintainer/collaborators — cross-repo list
maintainerRouter.get("/collaborators", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { permission, login, repo } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return "$" + params.length; };

    if (permission) conditions.push("rc.permission = " + addParam(permission));
    if (login)      conditions.push("rc.github_login ILIKE " + addParam("%" + login + "%") + "::text");
    if (repo)       conditions.push("r.full_name = " + addParam(repo));

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM repo_collaborators rc JOIN repositories r ON r.github_id = rc.repo_id " + where,
      params
    );

    params.push(perPage, offset);
    const pIdx = params.length - 1;

    const { rows } = await db.query(
      `SELECT rc.github_login, rc.github_id, rc.avatar_url,
              rc.permission, rc.role_name, rc.updated_at,
              r.full_name AS repo_full_name, r.owner AS repo_owner, r.name AS repo_name
       FROM repo_collaborators rc
       JOIN repositories r ON r.github_id = rc.repo_id
       ${where}
       ORDER BY
         CASE rc.permission
           WHEN 'admin'    THEN 1
           WHEN 'maintain' THEN 2
           WHEN 'push'     THEN 3
           WHEN 'triage'   THEN 4
           ELSE 5
         END,
         rc.github_login
       LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// GET /api/maintainer/collaborators/:owner/:repo
maintainerRouter.get("/collaborators/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows } = await db.query(
      `SELECT rc.*
       FROM repo_collaborators rc
       JOIN repositories r ON r.github_id = rc.repo_id
       WHERE r.full_name = $1
       ORDER BY
         CASE rc.permission
           WHEN 'admin' THEN 1 WHEN 'maintain' THEN 2 WHEN 'push' THEN 3
           WHEN 'triage' THEN 4 ELSE 5
         END, rc.github_login`,
      [fullName]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/maintainer/collaborators/:owner/:repo/:login — set permission
maintainerRouter.put("/collaborators/:owner/:repo/:login", async (req, res, next) => {
  try {
    const { owner, repo, login } = req.params;
    const { permission } = req.body;
    const actor = req.headers["x-actor-login"] || "api";

    const VALID_PERMISSIONS = ["pull", "triage", "push", "maintain", "admin"];
    if (!VALID_PERMISSIONS.includes(permission)) {
      return res.status(400).json({ error: "permission must be one of: " + VALID_PERMISSIONS.join(", ") });
    }

    const ctx = await getRepoAndOctokit(owner, repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    const { rows: [old] } = await db.query(
      "SELECT permission FROM repo_collaborators WHERE repo_id = $1 AND github_login = $2",
      [ctx.repo.github_id, login]
    );

    await ctx.octokit.rest.repos.addCollaborator({ owner, repo, username: login, permission });

    await syncCollaborators(ctx.octokit, owner, repo, ctx.repo.github_id);

    await audit({
      actor,
      action:     "collaborator.update",
      targetType: "repo",
      targetId:   owner + "/" + repo,
      payload:    { login, old_permission: old?.permission, new_permission: permission },
    });

    res.json({ updated: true, login, permission });
  } catch (err) { next(err); }
});

// DELETE /api/maintainer/collaborators/:owner/:repo/:login
maintainerRouter.delete("/collaborators/:owner/:repo/:login", async (req, res, next) => {
  try {
    const { owner, repo, login } = req.params;
    const actor = req.headers["x-actor-login"] || "api";

    const ctx = await getRepoAndOctokit(owner, repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    await ctx.octokit.rest.repos.removeCollaborator({ owner, repo, username: login });

    await db.query(
      "DELETE FROM repo_collaborators WHERE repo_id = $1 AND github_login = $2",
      [ctx.repo.github_id, login]
    );

    await audit({
      actor,
      action:     "collaborator.remove",
      targetType: "repo",
      targetId:   owner + "/" + repo,
      payload:    { login },
    });

    res.json({ removed: true, login });
  } catch (err) { next(err); }
});

// ── Branch protection rules ───────────────────────────────────────────────────

// GET /api/maintainer/branch-rules
maintainerRouter.get("/branch-rules", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { repo, pattern } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return "$" + params.length; };

    if (repo)    conditions.push("r.full_name = " + addParam(repo));
    if (pattern) conditions.push("br.pattern ILIKE " + addParam("%" + pattern + "%") + "::text");

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM branch_rules br JOIN repositories r ON r.github_id = br.repo_id " + where,
      params
    );

    params.push(perPage, offset);
    const pIdx = params.length - 1;

    const { rows } = await db.query(
      `SELECT br.*, r.full_name AS repo_full_name, r.owner AS repo_owner, r.name AS repo_name
       FROM branch_rules br
       JOIN repositories r ON r.github_id = br.repo_id
       ${where}
       ORDER BY r.full_name, br.pattern
       LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// GET /api/maintainer/branch-rules/:owner/:repo
maintainerRouter.get("/branch-rules/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows } = await db.query(
      `SELECT br.*
       FROM branch_rules br
       JOIN repositories r ON r.github_id = br.repo_id
       WHERE r.full_name = $1
       ORDER BY br.pattern`,
      [fullName]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PUT /api/maintainer/branch-rules/:owner/:repo/:pattern — create or update
maintainerRouter.put("/branch-rules/:owner/:repo/:pattern", async (req, res, next) => {
  try {
    const { owner, repo } = req.params;
    const pattern = decodeURIComponent(req.params.pattern);
    const actor   = req.headers["x-actor-login"] || "api";
    const body    = req.body;

    const ctx = await getRepoAndOctokit(owner, repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    const ghPayload = {
      owner, repo, branch: pattern,
      required_status_checks: body.require_status_checks
        ? { strict: body.require_up_to_date_branch ?? false, contexts: body.required_status_checks ?? [] }
        : null,
      enforce_admins: body.enforce_admins ?? false,
      required_pull_request_reviews: body.required_reviews > 0 ? {
        required_approving_review_count: body.required_reviews ?? 1,
        dismiss_stale_reviews:           body.dismiss_stale_reviews ?? false,
        require_code_owner_reviews:      body.require_code_owner_reviews ?? false,
      } : null,
      restrictions: body.restrict_pushes && body.push_allowlist?.length > 0
        ? { users: body.push_allowlist, teams: [], apps: [] }
        : null,
      allow_force_pushes: body.allow_force_pushes ?? false,
      allow_deletions:    body.allow_deletions    ?? false,
    };

    await ctx.octokit.rest.repos.updateBranchProtection(ghPayload);

    await syncBranchRules(ctx.octokit, owner, repo, ctx.repo.github_id);

    await audit({
      actor,
      action:     "branch_rule.update",
      targetType: "repo",
      targetId:   owner + "/" + repo,
      payload:    { pattern, ...body },
    });

    const { rows: [rule] } = await db.query(
      `SELECT br.* FROM branch_rules br
       JOIN repositories r ON r.github_id = br.repo_id
       WHERE r.full_name = $1 AND br.pattern = $2`,
      [owner + "/" + repo, pattern]
    );

    res.json(rule ?? { updated: true, pattern });
  } catch (err) { next(err); }
});

// ── Audit log ─────────────────────────────────────────────────────────────────

// GET /api/maintainer/audit
maintainerRouter.get("/audit", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { actor, action, target } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return "$" + params.length; };

    if (actor)  conditions.push("a.actor = " + addParam(actor));
    if (action) conditions.push("a.action ILIKE " + addParam("%" + action + "%") + "::text");
    if (target) conditions.push("a.target_id ILIKE " + addParam("%" + target + "%") + "::text");

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM audit_log a " + where, params
    );

    params.push(perPage, offset);
    const pIdx = params.length - 1;

    const { rows } = await db.query(
      `SELECT a.*
       FROM audit_log a
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${pIdx + 1} OFFSET $${pIdx + 2}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXISTING ROUTES (stale management — :owner/:repo params)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Settings ─────────────────────────────────────────────────────────────────

maintainerRouter.get("/:owner/:repo/settings", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const settings = await maintainerService.getSettings(repoRow.github_id);
    res.json(settings || {
      repo_id: repoRow.github_id,
      stale_issue_days: 60,
      stale_pr_days: 30,
      stale_warn_days: 7,
      cleanup_branches: true,
      enabled: true,
    });
  } catch (err) { next(err); }
});

maintainerRouter.patch("/:owner/:repo/settings", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const settings = await maintainerService.upsertSettings(repoRow.github_id, req.body);
    res.json(settings);
  } catch (err) { next(err); }
});

// ── Actions ──────────────────────────────────────────────────────────────────

maintainerRouter.get("/:owner/:repo/actions", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const { perPage, offset } = res.locals;
    const actions = await maintainerService.listActions(repoRow.github_id, { limit: perPage, offset });
    res.json({ actions, repo: fullName });
  } catch (err) { next(err); }
});

maintainerRouter.get("/:owner/:repo/stats", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const stats = await maintainerService.getActionStats(repoRow.github_id);
    res.json(stats);
  } catch (err) { next(err); }
});

// ── Triggers ─────────────────────────────────────────────────────────────────

maintainerRouter.post("/:owner/:repo/stale-scan", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const job = await maintainerQueue.add("stale-scan", {
      installationId: repoRow.installation_id,
      repoFullName: fullName,
    });

    res.status(202).json({ queued: true, jobId: job.id });
  } catch (err) { next(err); }
});

maintainerRouter.post("/:owner/:repo/branch-cleanup", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const repoRow = await findRepo(fullName);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const job = await maintainerQueue.add("branch-cleanup", {
      installationId: repoRow.installation_id,
      repoFullName: fullName,
    });

    res.status(202).json({ queued: true, jobId: job.id });
  } catch (err) { next(err); }
});
