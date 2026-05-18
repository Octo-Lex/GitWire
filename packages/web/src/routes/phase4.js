// src/routes/phase4.js
// Phase 4 REST API.
//
// AI Review Gate:
//   GET  /api/review/config/:owner/:repo     — get review config
//   POST /api/review/config/:owner/:repo     — create / update config
//   GET  /api/review/results                 — all reviews cross-repo
//   GET  /api/review/results/:owner/:repo    — reviews for one repo
//   GET  /api/review/stats                   — summary dashboard numbers
//   POST /api/review/trigger/:owner/:repo/:pr — trigger on-demand review
//
// Audit trail:
//   GET  /api/audit/entries                  — paginated trail entries
//   GET  /api/audit/stats                    — category / framework breakdown
//   GET  /api/audit/verify                   — verify chain integrity
//   POST /api/audit/export                   — trigger nightly export for a date
//
// Compliance reports:
//   GET  /api/audit/reports                  — list generated reports
//   POST /api/audit/reports                  — generate a new report
//   GET  /api/audit/reports/:id              — full report detail

import { Router } from "express";
import { db }     from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { getInstallationClient } from "../lib/github.js";
import { reviewPR }      from "../services/aiReviewService.js";
import { generateReport, verifyChain, exportNightly } from "../services/auditTrailService.js";
import { logger } from "../lib/logger.js";

export const phase4Router = Router();
phase4Router.use(paginationMiddleware);

// ── Shared resolver ───────────────────────────────────────────────────────────
async function resolveRepo(owner, repo) {
  const { rows: [row] } = await db.query(
    "SELECT github_id, full_name, owner, name, default_branch, installation_id " +
    "FROM repositories WHERE full_name = $1",
    [owner + "/" + repo]
  );
  if (!row) return null;
  return { repo: row, octokit: await getInstallationClient(row.installation_id) };
}

// ════════════════════════════════════════════════════════════════════════════
// AI Review Gate
// ════════════════════════════════════════════════════════════════════════════

phase4Router.get("/review/stats", async (_req, res, next) => {
  try {
    const { rows: [summary] } = await db.query(
      "SELECT " +
      "  COUNT(*)                                                          AS total_reviews, " +
      "  COUNT(CASE WHEN verdict = 'approved'          THEN 1 END)         AS approved, " +
      "  COUNT(CASE WHEN verdict = 'needs_discussion'  THEN 1 END)         AS needs_discussion, " +
      "  COUNT(CASE WHEN verdict = 'request_changes'   THEN 1 END)         AS request_changes, " +
      "  COUNT(CASE WHEN completed_at IS NOT NULL THEN 1 END)              AS completed, " +
      "  ROUND(AVG(tokens_used))                                           AS avg_tokens, " +
      "  ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))))      AS avg_duration_s, " +
      "  COUNT(DISTINCT repo_id)                                           AS repos_enabled " +
      "FROM ai_reviews " +
      "WHERE started_at > NOW() - INTERVAL '30 days'"
    );

    const { rows: bySeverity } = await db.query(
      "SELECT " +
      "  finding->>'severity' AS severity, " +
      "  COUNT(*)             AS count " +
      "FROM ai_reviews, " +
      "  LATERAL jsonb_array_elements(findings) AS finding " +
      "WHERE started_at > NOW() - INTERVAL '30 days' " +
      "GROUP BY finding->>'severity' " +
      "ORDER BY count DESC"
    );

    const { rows: verdictTrend } = await db.query(
      "SELECT " +
      "  DATE_TRUNC('day', started_at)                                 AS day, " +
      "  COUNT(CASE WHEN verdict = 'approved'        THEN 1 END)       AS approved, " +
      "  COUNT(CASE WHEN verdict = 'request_changes' THEN 1 END)       AS blocked " +
      "FROM ai_reviews " +
      "WHERE started_at > NOW() - INTERVAL '14 days' " +
      "GROUP BY 1 ORDER BY 1"
    );

    res.json({ summary, by_severity: bySeverity, verdict_trend: verdictTrend });
  } catch (err) { next(err); }
});

phase4Router.get("/review/results", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { verdict, repo } = req.query;

    const conditions = ["ar.completed_at IS NOT NULL"];
    const params     = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (verdict) conditions.push("ar.verdict = " + p(verdict));
    if (repo)    conditions.push("r.full_name = " + p(repo));

    const where = "WHERE " + conditions.join(" AND ");

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM ai_reviews ar " +
      "JOIN repositories r ON r.github_id = ar.repo_id " + where,
      params
    );

    const { rows } = await db.query(
      "SELECT " +
      "  ar.id, ar.pr_number, ar.commit_sha, " +
      "  ar.verdict, ar.confidence, ar.summary, " +
      "  ar.files_reviewed, ar.lines_added, ar.lines_removed, " +
      "  ar.tokens_used, ar.started_at, ar.completed_at, " +
      "  ar.github_review_id, " +
      "  jsonb_array_length(ar.findings) AS finding_count, " +
      "  r.full_name AS repo_full_name, r.owner, r.name AS repo_name " +
      "FROM ai_reviews ar " +
      "JOIN repositories r ON r.github_id = ar.repo_id " +
      where + " " +
      "ORDER BY ar.started_at DESC " +
      "LIMIT " + p(perPage) + " OFFSET " + p(offset),
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase4Router.get("/review/results/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = req.params.owner + "/" + req.params.repo;

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM ai_reviews ar " +
      "JOIN repositories r ON r.github_id = ar.repo_id WHERE r.full_name = $1",
      [fullName]
    );

    const { rows } = await db.query(
      "SELECT ar.* " +
      "FROM ai_reviews ar " +
      "JOIN repositories r ON r.github_id = ar.repo_id " +
      "WHERE r.full_name = $1 " +
      "ORDER BY ar.started_at DESC " +
      "LIMIT $2 OFFSET $3",
      [fullName, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase4Router.get("/review/config/:owner/:repo", async (req, res, next) => {
  try {
    const ctx = await resolveRepo(req.params.owner, req.params.repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    const { rows: [cfg] } = await db.query(
      "SELECT * FROM ai_review_config WHERE repo_id = $1", [ctx.repo.github_id]
    );
    res.json(cfg ?? { repo_id: ctx.repo.github_id, enabled: false });
  } catch (err) { next(err); }
});

phase4Router.post("/review/config/:owner/:repo", async (req, res, next) => {
  try {
    const ctx = await resolveRepo(req.params.owner, req.params.repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    const {
      enabled, check_logic, check_security, check_architecture, check_cost_leaks,
      check_tests, check_docs, block_on_verdict, min_confidence_to_block,
      max_files_to_review, max_lines_to_review, architecture_context, ignore_patterns,
    } = req.body;

    const { rows: [cfg] } = await db.query(
      "INSERT INTO ai_review_config " +
      "  (repo_id, enabled, check_logic, check_security, check_architecture, " +
      "   check_cost_leaks, check_tests, check_docs, block_on_verdict, " +
      "   min_confidence_to_block, max_files_to_review, max_lines_to_review, " +
      "   architecture_context, ignore_patterns) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) " +
      "ON CONFLICT (repo_id) DO UPDATE SET " +
      "  enabled                = COALESCE($2,  ai_review_config.enabled), " +
      "  check_logic            = COALESCE($3,  ai_review_config.check_logic), " +
      "  check_security         = COALESCE($4,  ai_review_config.check_security), " +
      "  check_architecture     = COALESCE($5,  ai_review_config.check_architecture), " +
      "  check_cost_leaks       = COALESCE($6,  ai_review_config.check_cost_leaks), " +
      "  check_tests            = COALESCE($7,  ai_review_config.check_tests), " +
      "  check_docs             = COALESCE($8,  ai_review_config.check_docs), " +
      "  block_on_verdict       = COALESCE($9,  ai_review_config.block_on_verdict), " +
      "  min_confidence_to_block= COALESCE($10, ai_review_config.min_confidence_to_block), " +
      "  max_files_to_review    = COALESCE($11, ai_review_config.max_files_to_review), " +
      "  max_lines_to_review    = COALESCE($12, ai_review_config.max_lines_to_review), " +
      "  architecture_context   = COALESCE($13, ai_review_config.architecture_context), " +
      "  ignore_patterns        = COALESCE($14, ai_review_config.ignore_patterns), " +
      "  updated_at             = NOW() " +
      "RETURNING *",
      [
        ctx.repo.github_id,
        enabled ?? false, check_logic ?? true, check_security ?? true,
        check_architecture ?? true, check_cost_leaks ?? true, check_tests ?? true,
        check_docs ?? false, block_on_verdict ?? ["request_changes"],
        min_confidence_to_block ?? "medium", max_files_to_review ?? 30,
        max_lines_to_review ?? 2000, architecture_context ?? null,
        ignore_patterns ?? ["*.lock","package-lock.json","yarn.lock","*.min.js","dist/**","build/**"],
      ]
    );
    res.json(cfg);
  } catch (err) { next(err); }
});

phase4Router.post("/review/trigger/:owner/:repo/:pr", async (req, res, next) => {
  try {
    const ctx = await resolveRepo(req.params.owner, req.params.repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });

    const prNumber = parseInt(req.params.pr);
    res.json({ started: true, pr: prNumber });

    const { data: pr } = await ctx.octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner: ctx.repo.owner, repo: ctx.repo.name, pull_number: prNumber }
    );

    reviewPR({
      pr,
      repository: { ...ctx.repo, id: ctx.repo.github_id, owner: { login: ctx.repo.owner } },
      octokit:    ctx.octokit,
    }).catch(err => logger.error({ err }, "Review trigger failed"));
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Audit trail
// ════════════════════════════════════════════════════════════════════════════

phase4Router.get("/audit/stats", async (req, res, next) => {
  try {
    const days = parseInt(req.query.days ?? "30");

    const { rows: byCategory } = await db.query(
      "SELECT category, COUNT(*) AS count " +
      "FROM audit_trail_entries " +
      "WHERE occurred_at > NOW() - ($1 || ' days')::interval " +
      "GROUP BY category ORDER BY count DESC",
      [days]
    );

    const { rows: byFramework } = await db.query(
      "SELECT f.framework, COUNT(*) AS count " +
      "FROM audit_trail_entries, " +
      "  LATERAL unnest(framework) AS f(framework) " +
      "WHERE occurred_at > NOW() - ($1 || ' days')::interval " +
      "GROUP BY f.framework ORDER BY count DESC",
      [days]
    );

    const { rows: [totals] } = await db.query(
      "SELECT " +
      "  COUNT(*)                              AS total_entries, " +
      "  COUNT(DISTINCT actor)                 AS unique_actors, " +
      "  COUNT(DISTINCT repo_full_name)        AS repos_covered, " +
      "  MAX(seq)                              AS latest_seq " +
      "FROM audit_trail_entries " +
      "WHERE occurred_at > NOW() - ($1 || ' days')::interval",
      [days]
    );

    const { rows: dailyVolume } = await db.query(
      "SELECT " +
      "  DATE_TRUNC('day', occurred_at) AS day, " +
      "  COUNT(*) AS entries " +
      "FROM audit_trail_entries " +
      "WHERE occurred_at > NOW() - ($1 || ' days')::interval " +
      "GROUP BY 1 ORDER BY 1",
      [days]
    );

    const { rows: exports_ } = await db.query(
      "SELECT date_covered, entry_count, signed, file_hash " +
      "FROM audit_exports " +
      "ORDER BY date_covered DESC LIMIT 7"
    );

    res.json({
      totals, by_category: byCategory, by_framework: byFramework,
      daily_volume: dailyVolume, recent_exports: exports_,
    });
  } catch (err) { next(err); }
});

phase4Router.get("/audit/entries", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { category, actor, repo, framework, since } = req.query;

    const conditions = [];
    const params     = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (category)  conditions.push("ate.category = " + p(category));
    if (actor)     conditions.push("ate.actor = " + p(actor));
    if (repo)      conditions.push("ate.repo_full_name = " + p(repo));
    if (framework) conditions.push(p(framework) + " = ANY(ate.framework)");
    if (since)     conditions.push("ate.occurred_at > " + p(new Date(since).toISOString()));

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM audit_trail_entries ate " + where,
      params
    );

    const { rows } = await db.query(
      "SELECT " +
      "  ate.id, ate.seq, ate.category, ate.event_type, " +
      "  ate.actor, ate.actor_type, " +
      "  ate.repo_full_name, ate.pr_number, ate.commit_sha, " +
      "  ate.payload, ate.framework, ate.control_id, " +
      "  ate.payload_hash, ate.occurred_at " +
      "FROM audit_trail_entries ate " +
      where + " " +
      "ORDER BY ate.seq DESC " +
      "LIMIT " + p(perPage) + " OFFSET " + p(offset),
      params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase4Router.get("/audit/verify", async (req, res, next) => {
  try {
    const from = parseInt(req.query.from ?? "1");
    const to   = req.query.to ? parseInt(req.query.to) : null;
    const result = await verifyChain(from, to);
    res.json(result);
  } catch (err) { next(err); }
});

phase4Router.post("/audit/export", async (req, res, next) => {
  try {
    const date   = req.body.date ? new Date(req.body.date) : new Date();
    const result = await exportNightly(date);
    res.json(result ?? { message: "No entries for this date" });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Compliance reports
// ════════════════════════════════════════════════════════════════════════════

phase4Router.get("/audit/reports", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { rows: [{ count }] } = await db.query("SELECT COUNT(*) FROM compliance_reports");
    const { rows } = await db.query(
      "SELECT id, report_type, period_start, period_end, generated_by, " +
      "  entry_count, report_hash, export_url, created_at " +
      "FROM compliance_reports " +
      "ORDER BY created_at DESC " +
      "LIMIT $1 OFFSET $2",
      [perPage, offset]
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase4Router.post("/audit/reports", async (req, res, next) => {
  try {
    const {
      report_type = "soc2",
      from        = new Date(Date.now() - 30 * 86400 * 1000).toISOString(),
      to          = new Date().toISOString(),
      generated_by = "dashboard",
    } = req.body;

    res.json({ generating: true, report_type });

    generateReport({
      reportType:  report_type,
      from:        new Date(from),
      to:          new Date(to),
      generatedBy: generated_by,
    }).then(r => logger.info({ reportId: r.reportId }, "Report generated"))
      .catch(err => logger.error({ err }, "Report generation failed"));
  } catch (err) { next(err); }
});

phase4Router.get("/audit/reports/:id", async (req, res, next) => {
  try {
    const { rows: [report] } = await db.query(
      "SELECT * FROM compliance_reports WHERE id = $1", [req.params.id]
    );
    if (!report) return res.status(404).json({ error: "Report not found" });
    res.json(report);
  } catch (err) { next(err); }
});
