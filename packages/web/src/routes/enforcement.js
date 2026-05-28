// src/routes/enforcement.js
// Branch protection enforcement + config validation REST API.
// Adapted for GitWire: parameterized queries, octokit.request(), pagination helper.

import { Router } from "express";
import { db }     from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { runEnforcementForAll, enforceRepo } from "../services/branchEnforcementService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { logger } from "../lib/logger.js";

export const enforcementRouter = Router();
enforcementRouter.use(paginationMiddleware);

// ════════════════════════════════════════════════════════════════════════════
// Stats
// ════════════════════════════════════════════════════════════════════════════

enforcementRouter.get("/stats", async (_req, res, next) => {
  try {
    const [violations, policies, configResults, compliance] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*)                                              AS total_violations,
          COUNT(CASE WHEN status = 'open'        THEN 1 END)   AS open,
          COUNT(CASE WHEN status = 'remediated'  THEN 1 END)   AS remediated,
          COUNT(CASE WHEN status = 'suppressed'  THEN 1 END)   AS suppressed,
          COUNT(CASE WHEN remediated_by = 'auto' THEN 1 END)   AS auto_remediated,
          COUNT(DISTINCT repo_id)                              AS repos_affected
        FROM enforcement_violations
        WHERE detected_at > NOW() - INTERVAL '30 days'
      `),
      db.query(`
        SELECT COUNT(*) AS total, COUNT(CASE WHEN enabled THEN 1 END) AS active
        FROM policy_definitions
      `),
      db.query(`
        SELECT
          COUNT(*)                                          AS total_runs,
          COUNT(CASE WHEN valid = FALSE THEN 1 END)         AS failed,
          COUNT(CASE WHEN valid = TRUE  THEN 1 END)         AS passed,
          COUNT(DISTINCT commit_sha)                        AS commits_checked
        FROM config_validation_results
        WHERE created_at > NOW() - INTERVAL '7 days'
      `),
      db.query(`
        SELECT
          COUNT(DISTINCT r.github_id)                            AS total_repos,
          COUNT(DISTINCT CASE WHEN br.compliant = TRUE  THEN r.github_id END) AS compliant,
          COUNT(DISTINCT CASE WHEN br.compliant = FALSE THEN r.github_id END) AS non_compliant,
          COUNT(DISTINCT CASE WHEN br.compliant IS NULL THEN r.github_id END) AS unchecked
        FROM repositories r
        LEFT JOIN branch_rules br ON br.repo_id = r.github_id
          AND br.pattern = r.default_branch
      `),
    ]);

    res.json({
      violations:   violations.rows[0],
      policies:     policies.rows[0],
      config:       configResults.rows[0],
      compliance:   compliance.rows[0],
    });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Policy definitions CRUD
// ════════════════════════════════════════════════════════════════════════════

enforcementRouter.get("/policies", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT pd.*, i.account_login AS org,
             COUNT(ev.id) AS open_violation_count
      FROM policy_definitions pd
      JOIN installations i ON i.github_id = pd.installation_id
      LEFT JOIN enforcement_violations ev ON ev.policy_id = pd.id AND ev.status = 'open'
      GROUP BY pd.id, i.account_login
      ORDER BY pd.name
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

enforcementRouter.post("/policies", async (req, res, next) => {
  try {
    let {
      installation_id, name, description, repo_filter, branch_pattern,
      min_reviews, require_linear_history, block_force_pushes,
      block_deletions, enforce_admins, require_status_checks,
      required_status_check_contexts, mode,
    } = req.body;
    // Auto-resolve installation_id from repo_filter if not provided
    if (!installation_id && repo_filter) {
      const { rows: [repo] } = await db.query("SELECT installation_id FROM repositories WHERE full_name = $1", [repo_filter]);
      if (repo) installation_id = repo.installation_id;
    }
    if (!installation_id) return res.status(400).json({ error: "installation_id or repo_filter required" });

    const { rows: [policy] } = await db.query(
      `INSERT INTO policy_definitions
         (installation_id, name, description, repo_filter, branch_pattern,
          min_reviews, require_linear_history, block_force_pushes,
          block_deletions, enforce_admins, require_status_checks,
          required_status_check_contexts, mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [installation_id, name, description, repo_filter, branch_pattern ?? "main",
       min_reviews ?? 1, require_linear_history ?? true, block_force_pushes ?? true,
       block_deletions ?? true, enforce_admins ?? true,
       require_status_checks ?? false, required_status_check_contexts ?? [],
       mode ?? "enforce"]
    );
    res.status(201).json(policy);
  } catch (err) { next(err); }
});

enforcementRouter.put("/policies/:id", async (req, res, next) => {
  try {
    const fields = [
      "name", "description", "repo_filter", "branch_pattern", "min_reviews",
      "require_linear_history", "block_force_pushes", "block_deletions",
      "enforce_admins", "require_status_checks", "required_status_check_contexts",
      "mode", "enabled",
    ];
    const sets   = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        sets.push(f + " = $" + params.length);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    sets.push("updated_at = NOW()");
    params.push(req.params.id);

    const { rows: [policy] } = await db.query(
      "UPDATE policy_definitions SET " + sets.join(",") + " WHERE id = $" + params.length + " RETURNING *",
      params
    );
    if (!policy) return res.status(404).json({ error: "Policy not found" });
    res.json(policy);
  } catch (err) { next(err); }
});

enforcementRouter.delete("/policies/:id", async (req, res, next) => {
  try {
    await db.query("DELETE FROM policy_definitions WHERE id = $1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Violations
// ════════════════════════════════════════════════════════════════════════════

enforcementRouter.get("/violations", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { status = "open", repo } = req.query;

    const conditions = ["ev.status = $1"];
    const params     = [status];
    if (repo) { params.push(repo); conditions.push("r.full_name = $" + params.length); }

    const where = "WHERE " + conditions.join(" AND ");

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM enforcement_violations ev JOIN repositories r ON r.github_id = ev.repo_id " + where, params
    );

    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT ev.id, ev.branch, ev.violations, ev.status,
              ev.detected_at, ev.remediated_at, ev.remediated_by,
              r.full_name AS repo_full_name, r.owner, r.name AS repo_name,
              pd.name AS policy_name, pd.mode AS policy_mode
       FROM enforcement_violations ev
       JOIN repositories r     ON r.github_id = ev.repo_id
       JOIN policy_definitions pd ON pd.id    = ev.policy_id
       ${where}
       ORDER BY ev.detected_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

enforcementRouter.get("/violations/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows } = await db.query(
      `SELECT ev.*, pd.name AS policy_name, pd.mode AS policy_mode
       FROM enforcement_violations ev
       JOIN repositories r ON r.github_id = ev.repo_id
       JOIN policy_definitions pd ON pd.id = ev.policy_id
       WHERE r.full_name = $1 AND ev.status = 'open'
       ORDER BY ev.detected_at DESC`,
      [fullName]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

enforcementRouter.post("/violations/:id/suppress", async (req, res, next) => {
  try {
    const { rows: [v] } = await db.query(
      "UPDATE enforcement_violations SET status = 'suppressed', updated_at = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!v) return res.status(404).json({ error: "Violation not found" });
    res.json({ suppressed: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// On-demand enforcement run
// ════════════════════════════════════════════════════════════════════════════

enforcementRouter.post("/run", async (req, res, next) => {
  try {
    const { repo } = req.body;

    if (repo) {
      const { rows: [repoRow] } = await db.query(
        "SELECT github_id, full_name, owner, name, default_branch, installation_id FROM repositories WHERE full_name = $1",
        [repo]
      );
      if (!repoRow) return res.status(404).json({ error: "Repository not found" });

      res.json({ started: true, scope: repo });

      const { rows: policies } = await db.query(
        "SELECT * FROM policy_definitions WHERE installation_id = $1 AND enabled = TRUE",
        [repoRow.installation_id]
      );
      const octokit = wrapOctokit(await getInstallationClient(repoRow.installation_id));
      enforceRepo({ octokit, repo: repoRow, policies, installation: { id: repoRow.installation_id } })
        .catch(err => logger.error({ err }, "Enforcement: on-demand run failed"));
    } else {
      res.json({ started: true, scope: "all" });
      runEnforcementForAll()
        .catch(err => logger.error({ err }, "Enforcement: fleet run failed"));
    }
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Config validation results
// ════════════════════════════════════════════════════════════════════════════

enforcementRouter.get("/config-results", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { valid, repo, file_type } = req.query;

    const conditions = [];
    const params     = [];
    const p = (v) => { params.push(v); return "$" + params.length; };

    if (valid !== undefined)  conditions.push("cv.valid = " + p(valid === "true"));
    if (repo)                 conditions.push("r.full_name = " + p(repo));
    if (file_type)            conditions.push("cv.file_type = " + p(file_type));

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM config_validation_results cv JOIN repositories r ON r.github_id = cv.repo_id " + where, params
    );

    params.push(perPage, offset);
    const pLimit  = "$" + (params.length - 1);
    const pOffset = "$" + params.length;

    const { rows } = await db.query(
      `SELECT cv.id, cv.commit_sha, cv.file_path, cv.file_type,
              cv.valid, cv.errors, cv.warnings, cv.created_at,
              r.full_name AS repo_full_name, r.owner, r.name AS repo_name
       FROM config_validation_results cv
       JOIN repositories r ON r.github_id = cv.repo_id
       ${where}
       ORDER BY cv.created_at DESC
       LIMIT ${pLimit} OFFSET ${pOffset}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

enforcementRouter.get("/config-results/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = req.params.owner + "/" + req.params.repo;

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM config_validation_results cv JOIN repositories r ON r.github_id = cv.repo_id WHERE r.full_name = $1",
      [fullName]
    );

    const { rows } = await db.query(
      `SELECT cv.* FROM config_validation_results cv
       JOIN repositories r ON r.github_id = cv.repo_id
       WHERE r.full_name = $1 ORDER BY cv.created_at DESC LIMIT $2 OFFSET $3`,
      [fullName, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});
