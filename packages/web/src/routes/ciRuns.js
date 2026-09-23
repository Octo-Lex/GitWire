// src/routes/ciRuns.js
// GET /api/ci                    — recent runs across all repos with heal status
// GET /api/ci/:owner/:repo       — runs for a specific repo
// GET /api/ci/stats              — pass rate, heal rate, failure breakdown
// POST /api/ci/:runId/retry      — manually trigger a re-run
// POST /api/ci/:runId/heal       — manually request healing (GitWire CI row id or GitHub run id)

import { Router } from "express";
import { db } from "../lib/db.js";
import { ciHealQueue } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { paginationMiddleware } from "../middleware/pagination.js";
import { buildCIHealJobFromManualRun, enqueueCIHealJob } from "../services/ciHealJobService.js";
import { resolveStoredCIRunIdentifier } from "../services/ciRunResolver.js";

export const ciRouter = Router();
ciRouter.use(paginationMiddleware);

// ── GET /api/ci/stats ─────────────────────────────────────────────────────────
ciRouter.get("/stats", async (_req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)                                                   AS total_runs,
        COUNT(CASE WHEN conclusion = 'success'  THEN 1 END)        AS passed,
        COUNT(CASE WHEN conclusion = 'failure'  THEN 1 END)        AS failed,
        COUNT(CASE WHEN conclusion = 'cancelled' THEN 1 END)       AS cancelled,
        ROUND(
          100.0 * COUNT(CASE WHEN conclusion = 'success' THEN 1 END)
          / NULLIF(COUNT(*), 0)
        )                                                          AS pass_rate,
        -- Healing stats
        COUNT(CASE WHEN heal_status = 'healed'   THEN 1 END)       AS auto_healed,
        COUNT(CASE WHEN heal_status = 'attempted' THEN 1 END)      AS heal_attempted,
        COUNT(CASE WHEN heal_status = 'failed'    THEN 1 END)      AS heal_failed
      FROM ci_runs
      WHERE created_at > NOW() - INTERVAL '7 days'
    `);

    // Failure breakdown by type (from AI diagnosis)
    const { rows: byType } = await db.query(`
      SELECT
        COALESCE(heal_failure_type, 'unknown') AS failure_type,
        COUNT(*) AS count
      FROM ci_runs
      WHERE conclusion = 'failure'
        AND created_at > NOW() - INTERVAL '7 days'
      GROUP BY heal_failure_type
      ORDER BY count DESC
      LIMIT 10
    `);

    // Daily pass rate for sparkline (last 14 days)
    const { rows: trend } = await db.query(`
      SELECT
        DATE_TRUNC('day', created_at) AS day,
        ROUND(
          100.0 * COUNT(CASE WHEN conclusion = 'success' THEN 1 END)
          / NULLIF(COUNT(*), 0)
        ) AS pass_rate,
        COUNT(*) AS total
      FROM ci_runs
      WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1
      ORDER BY 1
    `);

    res.json({ summary: rows[0], by_failure_type: byType, trend });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ci — cross-repo run list ─────────────────────────────────────────
ciRouter.get("/", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const { conclusion, heal_status, repo, branch } = req.query;

    const conditions = [];
    const params     = [];
    const addParam   = (v) => { params.push(v); return `$${params.length}`; };

    if (conclusion)  conditions.push(`cr.conclusion = ${addParam(conclusion)}`);
    if (heal_status) conditions.push(`cr.heal_status = ${addParam(heal_status)}`);
    if (repo)        conditions.push(`r.full_name = ${addParam(repo)}`);
    if (branch)      conditions.push(`cr.branch = ${addParam(branch)}`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id ${where}`,
      params
    );

    const { rows } = await db.query(
      `SELECT
         cr.id, cr.github_run_id, cr.workflow_name, cr.branch,
         cr.head_sha, cr.conclusion,
         cr.heal_status, cr.heal_failure_type, cr.heal_root_cause,
         cr.heal_fix_applied, cr.heal_confidence, cr.healed_at,
         cr.created_at, cr.updated_at,
         r.full_name AS repo_full_name,
         r.owner     AS repo_owner,
         r.name      AS repo_name,
         r.installation_id
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       ${where}
       ORDER BY cr.created_at DESC
       LIMIT ${addParam(perPage)} OFFSET ${addParam(offset)}`,
      params
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ci/:owner/:repo — repo-scoped run list ───────────────────────────
ciRouter.get("/:owner/:repo", async (req, res, next) => {
  try {
    const { perPage, offset, paginated } = res.locals;
    const fullName = `${req.params.owner}/${req.params.repo}`;

    const { rows: [{ count }] } = await db.query(
      `SELECT COUNT(*) FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       WHERE r.full_name = $1`,
      [fullName]
    );

    const { rows } = await db.query(
      `SELECT cr.*
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       WHERE r.full_name = $1
       ORDER BY cr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [fullName, perPage, offset]
    );

    res.json(paginated(rows, count));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ci/:runId/retry — manually re-trigger a run ─────────────────────
ciRouter.post("/:runId/retry", async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT cr.github_run_id, r.owner, r.name, r.installation_id
       FROM ci_runs cr
       JOIN repositories r ON r.github_id = cr.repo_id
       WHERE cr.id = $1`,
      [req.params.runId]
    );

    if (!rows.length) return res.status(404).json({ error: "Run not found" });

    const { github_run_id, owner, name, installation_id } = rows[0];
    const octokit = wrapOctokit(await getInstallationClient(installation_id));

    await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
      owner, repo: name, run_id: github_run_id,
    });

    res.json({ retriggered: true, run_id: github_run_id });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/ci/:runId/heal — trigger CI heal for a run ─────────────────────
// D0-01 compatibility contract:
// - `runId` may be the GitWire ci_runs.id or GitHub workflow run id.
// - repository + installation identity are always resolved from GitWire DB.
// - any legacy `installation_id` query parameter is ignored as authority.
// - the current workflow_run is re-read from GitHub before queueing.
ciRouter.post("/:runId/heal", async (req, res, next) => {
  try {
    const resolution = await resolveStoredCIRunIdentifier(req.params.runId);
    if (resolution.status === "invalid") {
      return res.status(400).json({ error: "runId must be numeric" });
    }
    if (resolution.status === "not_found") {
      return res.status(404).json({ error: "Run not found" });
    }
    if (resolution.status === "ambiguous") {
      return res.status(409).json({
        error: "Ambiguous run identifier",
        detail: "Use a run identifier that resolves to exactly one stored CI run.",
      });
    }

    const stored = resolution.run;
    const octokit = wrapOctokit(await getInstallationClient(stored.installation_id));

    let workflowRun;
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}", {
        owner: stored.owner,
        repo: stored.name,
        run_id: stored.github_run_id,
      });
      workflowRun = data;
    } catch (err) {
      if (err?.status === 404) {
        return res.status(409).json({
          error: "Workflow run is no longer available from GitHub",
          github_run_id: stored.github_run_id,
        });
      }
      throw err;
    }

    if (workflowRun.status !== "completed") {
      return res.status(409).json({
        error: "Workflow run is not completed",
        github_run_id: stored.github_run_id,
        status: workflowRun.status,
      });
    }
    if (workflowRun.conclusion !== "failure") {
      return res.status(409).json({
        error: "Only failed workflow runs can be healed",
        github_run_id: stored.github_run_id,
        conclusion: workflowRun.conclusion,
      });
    }

    const healJob = buildCIHealJobFromManualRun({
      workflowRun,
      repository: {
        id: stored.repo_github_id,
        full_name: stored.full_name,
        name: stored.name,
        owner: { login: stored.owner },
      },
      installationId: stored.installation_id,
      triggerKind: "manual_api",
    });

    const job = await enqueueCIHealJob(ciHealQueue, healJob, { priority: 1 });

    res.status(202).json({
      status: "queued",
      ci_run_id: stored.ci_run_id,
      github_run_id: stored.github_run_id,
      // Compatibility alias for existing clients.
      run_id: stored.github_run_id,
      job_id: job.id,
    });
  } catch (err) {
    next(err);
  }
});
