// src/routes/phase2.js
// Phase 2 REST API: merge queue, feedback rules, telemetry, rollbacks.
// Adapted for GitWire: ALL queries parameterized (no string interpolation), octokit.request().

import { Router } from "express";
import { db } from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { admitToQueue, removeFromQueue } from "../services/mergeQueueService.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { logger } from "../lib/logger.js";

export const phase2Router = Router();
phase2Router.use(paginationMiddleware);

// ════════════════════════════════════════════════════════════════════════════
// Merge queue
// ════════════════════════════════════════════════════════════════════════════

phase2Router.get("/queue", async (req, res, next) => {
  try {
    const { status, repo } = req.query;
    const { perPage, offset, paginated } = res.locals;

    const conditions = [];
    const params = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (status) conditions.push("mq.status = " + p(status));
    if (repo)   conditions.push("r.full_name = " + p(repo));
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM merge_queue_entries mq JOIN repositories r ON r.github_id = mq.repo_id " + where, params
    );

    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT mq.*, r.full_name AS repo_full_name, r.owner, r.name AS repo_name
       FROM merge_queue_entries mq JOIN repositories r ON r.github_id = mq.repo_id
       ${where} ORDER BY mq.position ASC, mq.admitted_at ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase2Router.get("/queue/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows } = await db.query(
      "SELECT mq.* FROM merge_queue_entries mq JOIN repositories r ON r.github_id = mq.repo_id WHERE r.full_name = $1 ORDER BY mq.position ASC",
      [fullName]
    );
    const { rows: [cfg] } = await db.query(
      "SELECT mqc.* FROM merge_queue_config mqc JOIN repositories r ON r.github_id = mqc.repo_id WHERE r.full_name = $1", [fullName]
    );
    res.json({ entries: rows, config: cfg ?? null });
  } catch (err) { next(err); }
});

phase2Router.post("/queue/:owner/:repo/config", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query("SELECT github_id FROM repositories WHERE full_name = $1", [fullName]);
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const { enabled, merge_method, delete_branch, required_checks, max_queue_depth, check_timeout_mins, base_branch } = req.body;

    const { rows: [cfg] } = await db.query(
      `INSERT INTO merge_queue_config (repo_id, enabled, merge_method, delete_branch, required_checks, max_queue_depth, check_timeout_mins, base_branch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (repo_id) DO UPDATE SET
         enabled = COALESCE($2, merge_queue_config.enabled),
         merge_method = COALESCE($3, merge_queue_config.merge_method),
         delete_branch = COALESCE($4, merge_queue_config.delete_branch),
         required_checks = COALESCE($5, merge_queue_config.required_checks),
         max_queue_depth = COALESCE($6, merge_queue_config.max_queue_depth),
         check_timeout_mins = COALESCE($7, merge_queue_config.check_timeout_mins),
         base_branch = COALESCE($8, merge_queue_config.base_branch),
         updated_at = NOW()
       RETURNING *`,
      [repo.github_id, enabled ?? false, merge_method ?? "squash",
       delete_branch ?? true, required_checks ?? [], max_queue_depth ?? 20, check_timeout_mins ?? 60, base_branch ?? "main"]
    );
    res.json(cfg);
  } catch (err) { next(err); }
});

phase2Router.post("/queue/:owner/:repo/:pr/admit", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query("SELECT github_id, full_name, owner, name, installation_id FROM repositories WHERE full_name = $1", [fullName]);
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const octokit = wrapOctokit(await getInstallationClient(repo.installation_id));
    const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: repo.owner, repo: repo.name, pull_number: parseInt(req.params.pr),
    });
    const result = await admitToQueue({ pr, repository: { ...repo, id: repo.github_id, owner: { login: repo.owner } }, octokit });
    res.json({ admitted: !!result, entry: result });
  } catch (err) { next(err); }
});

phase2Router.post("/queue/:owner/:repo/:pr/remove", async (req, res, next) => {
  try {
    const { rows: [repo] } = await db.query("SELECT github_id FROM repositories WHERE full_name = $1", [req.params.owner + "/" + req.params.repo]);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    await removeFromQueue({ repoId: repo.github_id, prNumber: parseInt(req.params.pr) });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Feedback rules
// ════════════════════════════════════════════════════════════════════════════

phase2Router.get("/feedback", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      "SELECT fr.*, i.account_login AS org FROM feedback_rules fr JOIN installations i ON i.github_id = fr.installation_id ORDER BY fr.event_type, fr.name"
    );
    res.json(rows);
  } catch (err) { next(err); }
});

phase2Router.post("/feedback", async (req, res, next) => {
  try {
    let { installation_id, name, event_type, repo_filter, post_pr_comment, slack_webhook, teams_webhook, include_log_link, include_diff_preview } = req.body;
    // Auto-resolve installation_id from repo_filter if not provided
    if (!installation_id && repo_filter) {
      const { rows: [repo] } = await db.query("SELECT installation_id FROM repositories WHERE full_name = $1", [repo_filter]);
      if (repo) installation_id = repo.installation_id;
    }
    if (!installation_id) return res.status(400).json({ error: "installation_id or repo_filter required" });
    const { rows: [rule] } = await db.query(
      `INSERT INTO feedback_rules (installation_id, name, event_type, repo_filter, post_pr_comment, slack_webhook, teams_webhook, include_log_link, include_diff_preview)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [installation_id, name, event_type, repo_filter ?? null, post_pr_comment ?? true,
       slack_webhook ?? null, teams_webhook ?? null, include_log_link ?? true, include_diff_preview ?? false]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

phase2Router.put("/feedback/:id", async (req, res, next) => {
  try {
    const FIELDS = ["name","event_type","repo_filter","post_pr_comment","slack_webhook","teams_webhook","include_log_link","enabled"];
    const sets = [], params = [];
    for (const f of FIELDS) {
      if (req.body[f] !== undefined) { params.push(req.body[f]); sets.push(f + "=$" + params.length); }
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    sets.push("updated_at=NOW()");
    params.push(req.params.id);
    const { rows:[rule] } = await db.query(
      "UPDATE feedback_rules SET " + sets.join(",") + " WHERE id=$" + params.length + " RETURNING *", params
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

phase2Router.delete("/feedback/:id", async (req, res, next) => {
  try {
    await db.query("DELETE FROM feedback_rules WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Telemetry
// ════════════════════════════════════════════════════════════════════════════

phase2Router.get("/telemetry/summary", async (_req, res, next) => {
  try {
    const [merges, blocks, heals, feedbacks, rollbacks, ciPass] = await Promise.all([
      db.query("SELECT COUNT(*) AS total, AVG(duration_ms) AS avg_duration_ms FROM pipeline_events WHERE event_type='pr_merged' AND occurred_at > NOW()-INTERVAL '7 days'"),
      db.query("SELECT COUNT(*) AS total FROM pipeline_events WHERE event_type='pr_blocked' AND occurred_at > NOW()-INTERVAL '7 days'"),
      db.query("SELECT COUNT(*) AS total FROM pipeline_events WHERE event_type='heal_succeeded' AND occurred_at > NOW()-INTERVAL '7 days'"),
      db.query("SELECT COUNT(*) AS total FROM pipeline_events WHERE event_type='feedback_sent' AND occurred_at > NOW()-INTERVAL '7 days'"),
      db.query("SELECT COUNT(*) AS total FROM rollback_events WHERE created_at > NOW()-INTERVAL '7 days'"),
      db.query("SELECT ROUND(100.0*COUNT(CASE WHEN conclusion='success' THEN 1 END)/NULLIF(COUNT(*),0)) AS pass_rate FROM ci_runs WHERE created_at > NOW()-INTERVAL '7 days'"),
    ]);
    res.json({
      window: "7 days",
      merges:    { ...merges.rows[0], avg_duration_s: Math.round((merges.rows[0].avg_duration_ms ?? 0) / 1000) },
      blocks:    blocks.rows[0],
      heals:     heals.rows[0],
      feedbacks: feedbacks.rows[0],
      rollbacks: rollbacks.rows[0],
      ci_pass_rate: ciPass.rows[0].pass_rate,
    });
  } catch (err) { next(err); }
});

phase2Router.get("/telemetry/events", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { event_type, repo, since } = req.query;

    const conditions = [];
    const params = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (event_type) conditions.push("pe.event_type = " + p(event_type));
    if (repo)       conditions.push("r.full_name = " + p(repo));
    if (since)      conditions.push("pe.occurred_at > " + p(new Date(since).toISOString()));
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows:[{count}] } = await db.query(
      "SELECT COUNT(*) FROM pipeline_events pe LEFT JOIN repositories r ON r.github_id = pe.repo_id " + where, params
    );
    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT pe.*, r.full_name AS repo_full_name FROM pipeline_events pe
       LEFT JOIN repositories r ON r.github_id = pe.repo_id ${where}
       ORDER BY pe.occurred_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`, params
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase2Router.get("/telemetry/throughput", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DATE_TRUNC('day', occurred_at) AS day, COUNT(*) AS merges, ROUND(AVG(duration_ms)/1000) AS avg_duration_s
       FROM pipeline_events WHERE event_type = 'pr_merged' AND occurred_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

phase2Router.get("/telemetry/ci-health", async (_req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT DATE_TRUNC('day', created_at) AS day,
              ROUND(100.0 * COUNT(CASE WHEN conclusion='success' THEN 1 END) / NULLIF(COUNT(*),0)) AS pass_rate,
              COUNT(*) AS total_runs FROM ci_runs WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Rollbacks
// ════════════════════════════════════════════════════════════════════════════

phase2Router.get("/rollbacks", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { rows:[{count}] } = await db.query("SELECT COUNT(*) FROM rollback_events");
    const { rows } = await db.query(
      "SELECT rb.*, r.full_name AS repo_full_name FROM rollback_events rb JOIN repositories r ON r.github_id = rb.repo_id ORDER BY rb.created_at DESC LIMIT $1 OFFSET $2",
      [perPage, offset]
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});
