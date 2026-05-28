// src/routes/phase3.js
// Phase 3 REST API: flaky tests, policy reconciler, dependency lifecycle.
// Adapted for GitWire: ALL queries parameterized, octokit.request(), no silent catches.

import { Router } from "express";
import { db }     from "../lib/db.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { checkGraduation }  from "../services/flakyTestService.js";
import { runFleetReconciliation, reconcileRepo } from "../services/policyReconcilerService.js";
import { scanRepo, openBatchUpdatePR } from "../services/dependencyService.js";
import { logger } from "../lib/logger.js";

export const phase3Router = Router();
phase3Router.use(paginationMiddleware);

// Helper
async function resolveRepo(owner, repo) {
  const fullName = owner + "/" + repo;
  const { rows: [row] } = await db.query(
    "SELECT github_id, full_name, owner, name, default_branch, installation_id FROM repositories WHERE full_name = $1",
    [fullName]
  );
  if (!row) return null;
  const octokit = wrapOctokit(await getInstallationClient(row.installation_id));
  return { repo: row, octokit };
}

// ════════════════════════════════════════════════════════════════════════════
// PILLAR 1: Flaky tests
// ════════════════════════════════════════════════════════════════════════════

phase3Router.get("/flaky/stats", async (_req, res, next) => {
  try {
    const { rows: [summary] } = await db.query(
      "SELECT COUNT(*) AS total_tracked, COUNT(CASE WHEN quarantined = TRUE THEN 1 END) AS quarantined, COUNT(CASE WHEN graduated_at IS NOT NULL THEN 1 END) AS graduated, COUNT(CASE WHEN flakiness_score >= 0.5 THEN 1 END) AS high_flakiness, COUNT(DISTINCT repo_id) AS repos_affected, ROUND(AVG(flakiness_score)::numeric * 100, 1) AS avg_flakiness_pct FROM flaky_tests WHERE graduated_at IS NULL"
    );
    const { rows: topFlaky } = await db.query(
      "SELECT ft.test_suite, ft.test_name, ROUND(ft.flakiness_score * 100) AS failure_pct, ft.run_count, ft.quarantined, r.full_name AS repo_full_name FROM flaky_tests ft JOIN repositories r ON r.github_id = ft.repo_id WHERE ft.graduated_at IS NULL ORDER BY ft.flakiness_score DESC LIMIT 5"
    );
    const { rows: trend } = await db.query(
      "SELECT DATE_TRUNC('day', created_at) AS day, COUNT(CASE WHEN status='failed' THEN 1 END) AS failures, COUNT(*) AS total FROM test_results WHERE created_at > NOW() - INTERVAL '14 days' AND status != 'skipped' GROUP BY 1 ORDER BY 1"
    );
    res.json({ summary, top_flaky: topFlaky, trend });
  } catch (err) { next(err); }
});

phase3Router.get("/flaky", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { quarantined, min_score, repo } = req.query;

    const conditions = ["ft.graduated_at IS NULL"];
    const params = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (quarantined !== undefined) conditions.push("ft.quarantined = " + p(quarantined === "true"));
    if (min_score)                conditions.push("ft.flakiness_score >= " + p(parseFloat(min_score)));
    if (repo)                     conditions.push("r.full_name = " + p(repo));

    const where = "WHERE " + conditions.join(" AND ");

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM flaky_tests ft JOIN repositories r ON r.github_id = ft.repo_id " + where, params
    );

    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT ft.id, ft.test_suite, ft.test_name, ROUND(ft.flakiness_score * 100) AS failure_pct,
              ft.run_count, ft.pass_count, ft.fail_count, ft.quarantined, ft.quarantined_at,
              ft.quarantine_pr_number, ft.graduated_at, ft.last_failed_at, ft.first_seen_at,
              r.full_name AS repo_full_name, r.owner, r.name AS repo_name
       FROM flaky_tests ft JOIN repositories r ON r.github_id = ft.repo_id
       ${where} ORDER BY ft.flakiness_score DESC, ft.run_count DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );

    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase3Router.get("/flaky/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = req.params.owner + "/" + req.params.repo;

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM flaky_tests ft JOIN repositories r ON r.github_id = ft.repo_id WHERE r.full_name = $1 AND ft.graduated_at IS NULL",
      [fullName]
    );
    const { rows } = await db.query(
      "SELECT ft.*, ROUND(ft.flakiness_score * 100) AS failure_pct FROM flaky_tests ft JOIN repositories r ON r.github_id = ft.repo_id WHERE r.full_name = $1 AND ft.graduated_at IS NULL ORDER BY ft.flakiness_score DESC LIMIT $2 OFFSET $3",
      [fullName, perPage, offset]
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase3Router.post("/flaky/:id/graduate", async (req, res, next) => {
  try {
    const { rows: [ft] } = await db.query(
      "UPDATE flaky_tests SET graduated_at = NOW(), quarantined = FALSE WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!ft) return res.status(404).json({ error: "Flaky test not found" });
    res.json({ graduated: true, test: ft.test_name });
  } catch (err) { next(err); }
});

phase3Router.post("/flaky/:id/dismiss", async (req, res, next) => {
  try {
    const { rows: [ft] } = await db.query(
      "UPDATE flaky_tests SET graduated_at = NOW(), quarantined = FALSE WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!ft) return res.status(404).json({ error: "Not found" });
    res.json({ dismissed: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// PILLAR 2: Policy reconciler
// ════════════════════════════════════════════════════════════════════════════

phase3Router.get("/reconciler/runs", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { rows: [{ count }] } = await db.query("SELECT COUNT(*) FROM reconciliation_runs");
    const { rows } = await db.query(
      "SELECT * FROM reconciliation_runs ORDER BY started_at DESC LIMIT $1 OFFSET $2", [perPage, offset]
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase3Router.get("/reconciler/repos", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { in_sync, repo } = req.query;

    const conditions = [];
    const params = [];
    const p = v => { params.push(v); return "$" + params.length; };

    if (in_sync !== undefined) conditions.push("prc.in_sync = " + p(in_sync === "true"));
    if (repo)                  conditions.push("r.full_name = " + p(repo));
    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM policy_repo_configs prc JOIN repositories r ON r.github_id = prc.repo_id " + where, params
    );

    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT prc.in_sync, prc.drift_fields, prc.reconcile_skip, prc.last_reconciled_at, prc.next_reconcile_at,
              r.full_name AS repo_full_name, r.owner, r.name AS repo_name, r.default_branch
       FROM policy_repo_configs prc JOIN repositories r ON r.github_id = prc.repo_id
       ${where} ORDER BY prc.in_sync ASC NULLS FIRST, r.full_name
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase3Router.post("/reconciler/run", async (req, res, next) => {
  try {
    const { repo } = req.body;
    res.json({ started: true, scope: repo ?? "fleet" });

    if (repo) {
      const parts = repo.split("/");
      const ctx = await resolveRepo(parts[0], parts[1]);
      if (ctx) {
        const { rows: policies } = await db.query(
          "SELECT * FROM policy_definitions WHERE installation_id = $1 AND enabled = TRUE",
          [ctx.repo.installation_id]
        );
        reconcileRepo({ octokit: ctx.octokit, repo: ctx.repo, policies })
          .catch(err => logger.error({ err }, "Reconciler: on-demand run failed"));
      }
    } else {
      runFleetReconciliation("manual")
        .catch(err => logger.error({ err }, "Reconciler: fleet run failed"));
    }
  } catch (err) { next(err); }
});

phase3Router.put("/reconciler/repos/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repoRow] } = await db.query("SELECT github_id FROM repositories WHERE full_name = $1", [fullName]);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const { reconcile_skip } = req.body;
    const { rows: [cfg] } = await db.query(
      "UPDATE policy_repo_configs SET reconcile_skip = COALESCE($1, reconcile_skip), updated_at = NOW() WHERE repo_id = $2 RETURNING *",
      [reconcile_skip ?? null, repoRow.github_id]
    );
    res.json(cfg ?? { updated: false });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// PILLAR 3: Dependency lifecycle
// ════════════════════════════════════════════════════════════════════════════

phase3Router.get("/dependencies/stats", async (_req, res, next) => {
  try {
    const { rows: [vulnSummary] } = await db.query(
      "SELECT COUNT(*) AS total_open, COUNT(CASE WHEN severity='critical' THEN 1 END) AS critical, COUNT(CASE WHEN severity='high' THEN 1 END) AS high, COUNT(CASE WHEN severity='medium' THEN 1 END) AS medium, COUNT(CASE WHEN severity='low' THEN 1 END) AS low, COUNT(CASE WHEN status='pr_opened' THEN 1 END) AS prs_opened, COUNT(DISTINCT repo_id) AS repos_affected FROM vulnerability_advisories WHERE status='open'"
    );
    const { rows: byEco } = await db.query(
      "SELECT ecosystem, COUNT(*) AS count FROM vulnerability_advisories WHERE status='open' GROUP BY ecosystem ORDER BY count DESC"
    );
    const { rows: recentBatches } = await db.query(
      "SELECT dub.*, r.full_name AS repo_full_name FROM dependency_update_batches dub JOIN repositories r ON r.github_id = dub.repo_id ORDER BY dub.created_at DESC LIMIT 5"
    );
    res.json({ vulnerabilities: vulnSummary, by_ecosystem: byEco, recent_batches: recentBatches });
  } catch (err) { next(err); }
});

phase3Router.get("/dependencies/vulnerabilities", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { severity, status = "open", repo, ecosystem } = req.query;

    const conditions = ["va.status = $1"];
    const params = [status];
    const p = v => { params.push(v); return "$" + params.length; };

    if (severity)  conditions.push("va.severity = " + p(severity));
    if (repo)      conditions.push("r.full_name = " + p(repo));
    if (ecosystem) conditions.push("va.ecosystem = " + p(ecosystem));

    const where = "WHERE " + conditions.join(" AND ");

    const { rows: [{ count }] } = await db.query(
      "SELECT COUNT(*) FROM vulnerability_advisories va JOIN repositories r ON r.github_id = va.repo_id " + where, params
    );

    params.push(perPage, offset);
    const { rows } = await db.query(
      `SELECT va.id, va.ghsa_id, va.cve_id, va.ecosystem, va.package_name, va.affected_range,
              va.patched_version, va.installed_version, va.severity, va.cvss_score, va.summary,
              va.status, va.fix_pr_number, va.fix_pr_url, va.detected_at, va.published_at,
              r.full_name AS repo_full_name, r.owner, r.name AS repo_name
       FROM vulnerability_advisories va JOIN repositories r ON r.github_id = va.repo_id
       ${where}
       ORDER BY CASE va.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END, va.cvss_score DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    res.json(paginated(rows, count));
  } catch (err) { next(err); }
});

phase3Router.get("/dependencies/:owner/:repo", async (req, res, next) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repoRow] } = await db.query("SELECT github_id FROM repositories WHERE full_name = $1", [fullName]);
    if (!repoRow) return res.status(404).json({ error: "Repository not found" });

    const [{ rows: manifests }, { rows: vulns }] = await Promise.all([
      db.query("SELECT id, file_path, ecosystem, dep_count, scanned_at FROM dependency_manifests WHERE repo_id = $1 ORDER BY ecosystem", [repoRow.github_id]),
      db.query("SELECT id, package_name, ecosystem, severity, cvss_score, affected_range, patched_version, status, fix_pr_url, ghsa_id FROM vulnerability_advisories WHERE repo_id = $1 AND status IN ('open','pr_opened') ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END", [repoRow.github_id]),
    ]);
    res.json({ manifests, vulnerabilities: vulns });
  } catch (err) { next(err); }
});

phase3Router.post("/dependencies/:owner/:repo/scan", async (req, res, next) => {
  try {
    const ctx = await resolveRepo(req.params.owner, req.params.repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });
    res.json({ started: true, repo: ctx.repo.full_name });
    scanRepo({ repository: { ...ctx.repo, id: ctx.repo.github_id, owner: { login: ctx.repo.owner } }, octokit: ctx.octokit })
      .catch(err => logger.error({ err }, "Dependency scan failed"));
  } catch (err) { next(err); }
});

phase3Router.post("/dependencies/:owner/:repo/batch-pr", async (req, res, next) => {
  try {
    const ctx = await resolveRepo(req.params.owner, req.params.repo);
    if (!ctx) return res.status(404).json({ error: "Repository not found" });
    const { ecosystem = "npm" } = req.body;
    res.json({ started: true, repo: ctx.repo.full_name, ecosystem });
    openBatchUpdatePR({
      repository: { ...ctx.repo, id: ctx.repo.github_id, owner: { login: ctx.repo.owner } },
      octokit: ctx.octokit, repoId: ctx.repo.github_id, ecosystem,
    }).catch(err => logger.error({ err }, "Batch PR failed"));
  } catch (err) { next(err); }
});

phase3Router.post("/dependencies/vuln/:id/dismiss", async (req, res, next) => {
  try {
    const { reason } = req.body;
    const { rows: [v] } = await db.query(
      "UPDATE vulnerability_advisories SET status = 'dismissed', dismissed_reason = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [reason ?? null, req.params.id]
    );
    if (!v) return res.status(404).json({ error: "Vulnerability not found" });
    res.json({ dismissed: true });
  } catch (err) { next(err); }
});
