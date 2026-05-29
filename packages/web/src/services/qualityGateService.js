// src/services/qualityGateService.js
// Fetches metric values from the database and evaluates quality gates.
//
// Architecture:
//   1. fetchMetrics(repoId) — queries DB tables to compute metric values
//   2. evaluateGateForPR() — evaluates gates, posts GitHub check, persists results
//   3. evaluateGateForRepo() — evaluates gates for dashboard/API

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getConfigForRepo } from "./configService.js";
import {
  evaluateAllGates,
  getRequiredMetrics,
  formatGateSummary,
} from "@gitwire/rules";

// ════════════════════════════════════════════════════════════════════════════
// Metric Fetchers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all quality gate metrics for a repo from the database.
 * Returns a flat { metric_name: value } object.
 *
 * @param {number} repoId - repositories.github_id
 * @returns {Promise<object>}
 */
export async function fetchMetrics(repoId) {
  const m = {};

  // CI failure rate (7d)
  const ci7 = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE conclusion = 'failure')::int AS failed
     FROM ci_runs
     WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [repoId]
  );
  const ci7Total = ci7.rows[0]?.total || 0;
  const ci7Failed = ci7.rows[0]?.failed || 0;
  m.ci_failure_rate_7d = ci7Total > 0 ? ci7Failed / ci7Total : 0;

  // CI failure rate (30d)
  const ci30 = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE conclusion = 'failure')::int AS failed
     FROM ci_runs
     WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
    [repoId]
  );
  const ci30Total = ci30.rows[0]?.total || 0;
  const ci30Failed = ci30.rows[0]?.failed || 0;
  m.ci_failure_rate_30d = ci30Total > 0 ? ci30Failed / ci30Total : 0;

  // Triage coverage
  const triage = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE triage_type IS NOT NULL)::int AS triaged
     FROM issues WHERE repo_id = $1`,
    [repoId]
  );
  const issueTotal = triage.rows[0]?.total || 0;
  const issueTriaged = triage.rows[0]?.triaged || 0;
  m.triage_coverage = issueTotal > 0 ? issueTriaged / issueTotal : 0;

  // Open issues
  const openIssues = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM issues WHERE repo_id = $1 AND state = 'open'`,
    [repoId]
  );
  m.open_issues = openIssues.rows[0]?.cnt || 0;

  // Open security issues
  const secIssues = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM issues
     WHERE repo_id = $1 AND state = 'open' AND $2 = ANY(labels)`,
    [repoId, "security"]
  );
  m.open_security_issues = secIssues.rows[0]?.cnt || 0;

  // Stale issues (>7 days, no activity)
  const stale7 = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM issues
     WHERE repo_id = $1 AND state = 'open'
       AND updated_at < NOW() - INTERVAL '7 days'`,
    [repoId]
  );
  m.stale_issues_7d = stale7.rows[0]?.cnt || 0;

  // Heal success rate (7d)
  const heal7 = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'merged')::int AS merged
     FROM heal_prs
     WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [repoId]
  );
  const heal7Total = heal7.rows[0]?.total || 0;
  const heal7Merged = heal7.rows[0]?.merged || 0;
  m.heal_success_rate_7d = heal7Total > 0 ? heal7Merged / heal7Total : 0;

  // Heal success rate (30d)
  const heal30 = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'merged')::int AS merged
     FROM heal_prs
     WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '30 days'`,
    [repoId]
  );
  const heal30Total = heal30.rows[0]?.total || 0;
  const heal30Merged = heal30.rows[0]?.merged || 0;
  m.heal_success_rate_30d = heal30Total > 0 ? heal30Merged / heal30Total : 0;

  // Fix success rate (7d)
  const fix7 = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'success')::int AS success
     FROM fix_attempts
     WHERE repo_id = $1 AND created_at > NOW() - INTERVAL '7 days'`,
    [repoId]
  );
  const fix7Total = fix7.rows[0]?.total || 0;
  const fix7Success = fix7.rows[0]?.success || 0;
  m.fix_success_rate_7d = fix7Total > 0 ? fix7Success / fix7Total : 0;

  // Duplicate rate
  const dupRate = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE duplicate_of IS NOT NULL)::int AS dups
     FROM issues WHERE repo_id = $1`,
    [repoId]
  );
  const dupTotal = dupRate.rows[0]?.total || 0;
  const dupCount = dupRate.rows[0]?.dups || 0;
  m.duplicate_rate = dupTotal > 0 ? dupCount / dupTotal : 0;

  // Average triage time (hours)
  const triageTime = await db.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (triaged_at - created_at)) / 3600)::float AS avg_hours
     FROM issues
     WHERE repo_id = $1 AND triaged_at IS NOT NULL`,
    [repoId]
  );
  m.avg_triage_time_hours = triageTime.rows[0]?.avg_hours || 0;

  // Average heal time (hours)
  const healTime = await db.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (ci_runs.healed_at - ci_runs.created_at)) / 3600)::float AS avg_hours
     FROM heal_prs
     JOIN ci_runs ON heal_prs.ci_run_id = ci_runs.id
     WHERE heal_prs.repo_id = $1 AND ci_runs.healed_at IS NOT NULL`,
    [repoId]
  );
  m.avg_heal_time_hours = healTime.rows[0]?.avg_hours || 0;

  // Readiness score (computed)
  try {
    const readinessResult = await db.query(
      `SELECT github_id FROM repositories WHERE github_id = $1`,
      [repoId]
    );
    // We compute a simplified readiness score inline
    // Full readiness uses the route; here we compute from the same data
    const checks = await computeReadinessScore(repoId);
    m.readiness_score = checks.score;
  } catch (_e) {
    m.readiness_score = 0;
  }

  // Webhook events (7d)
  const webhook7 = await db.query(
    `SELECT COUNT(*)::int AS cnt
     FROM (
       SELECT 1 FROM webhook_deliveries
       WHERE repo = (SELECT full_name FROM repositories WHERE github_id = $1)
       AND received_at > NOW() - INTERVAL '7 days'
       LIMIT 10000
     ) sub`,
    [repoId]
  );
  m.webhook_events_7d = webhook7.rows[0]?.cnt || 0;

  // AI review pass rate (30d)
  const reviewRate = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE verdict = 'approved')::int AS approved
     FROM ai_reviews
     WHERE repo_id = $1 AND completed_at > NOW() - INTERVAL '30 days'`,
    [repoId]
  );
  const reviewTotal = reviewRate.rows[0]?.total || 0;
  const reviewApproved = reviewRate.rows[0]?.approved || 0;
  m.ai_review_pass_rate_30d = reviewTotal > 0 ? reviewApproved / reviewTotal : 0;

  // Average review duration (ms)
  const reviewDur = await db.query(
    `SELECT AVG(duration_ms)::float AS avg_ms
     FROM ai_reviews
     WHERE repo_id = $1 AND duration_ms IS NOT NULL AND completed_at > NOW() - INTERVAL '30 days'`,
    [repoId]
  );
  m.avg_review_duration_ms = reviewDur.rows[0]?.avg_ms || 0;

  return m;
}

/**
 * Compute a simplified readiness score (mirrors the readiness route logic).
 * Weights sum to 100.
 */
async function computeReadinessScore(repoId) {
  let earned = 0;

  // Check: webhook_active (15 pts)
  const wh = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM webhook_deliveries wd
     JOIN repositories r ON r.github_id = $1
     WHERE wd.repo = r.full_name AND wd.received_at > NOW() - INTERVAL '7 days'`,
    [repoId]
  );
  if ((wh.rows[0]?.cnt || 0) > 0) earned += 15;

  // Check: repo_synced (10 pts)
  const sync = await db.query(
    `SELECT last_synced_at FROM repositories WHERE github_id = $1`, [repoId]
  );
  if (sync.rows[0]?.last_synced_at) earned += 10;

  // Check: issues_triaged (10 pts)
  const tr = await db.query(
    `SELECT COUNT(*) FILTER (WHERE triage_type IS NOT NULL)::int AS triaged FROM issues WHERE repo_id = $1`,
    [repoId]
  );
  if ((tr.rows[0]?.triaged || 0) > 0) earned += 10;

  // Check: ci_runs_received (10 pts)
  const ci = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM ci_runs WHERE repo_id = $1`, [repoId]
  );
  if ((ci.rows[0]?.cnt || 0) > 0) earned += 10;

  // Check: config_versioned (10 pts)
  const cfg = await db.query(
    `SELECT COUNT(*)::int AS cnt FROM config_history WHERE repo_id = $1`, [repoId]
  );
  if ((cfg.rows[0]?.cnt || 0) > 0) earned += 10;

  // Remaining 45 pts: config_overrides, gitwire_yml, stale_policy, branch_protection, etc.
  // Simplified — give partial credit for DB config
  const cfgOverride = await db.query(
    `SELECT id FROM repo_config WHERE repo_id = $1 LIMIT 1`, [repoId]
  );
  if (cfgOverride.rows.length > 0) earned += 10;

  const stale = await db.query(
    `SELECT id FROM maintainer_settings WHERE repo_id = $1 LIMIT 1`, [repoId]
  );
  if (stale.rows.length > 0) earned += 10;

  return { score: earned };
}

// ════════════════════════════════════════════════════════════════════════════
// Gate Persistence
// ════════════════════════════════════════════════════════════════════════════

/**
 * Save a gate definition to the DB.
 */
export async function saveGate(repoId, name, conditions, { isDefault = false, blockOnFail = true } = {}) {
  const { rows } = await db.query(
    `INSERT INTO quality_gates (repo_id, name, is_default, conditions, block_on_fail)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (repo_id, name) DO UPDATE
       SET conditions = EXCLUDED.conditions,
           is_default = EXCLUDED.is_default,
           block_on_fail = EXCLUDED.block_on_fail,
           updated_at = NOW()
     RETURNING *`,
    [repoId, name, isDefault, JSON.stringify(conditions), blockOnFail]
  );
  return rows[0];
}

/**
 * Delete a gate definition from the DB.
 */
export async function deleteGate(repoId, name) {
  const { rowCount } = await db.query(
    `DELETE FROM quality_gates WHERE repo_id = $1 AND name = $2`,
    [repoId, name]
  );
  return rowCount > 0;
}

/**
 * Get all gate definitions for a repo.
 */
export async function getGatesForRepo(repoId) {
  const { rows } = await db.query(
    `SELECT * FROM quality_gates WHERE repo_id = $1 ORDER BY is_default DESC, name`,
    [repoId]
  );
  return rows;
}

/**
 * Get a single gate by name.
 */
export async function getGate(repoId, name) {
  const { rows } = await db.query(
    `SELECT * FROM quality_gates WHERE repo_id = $1 AND name = $2`,
    [repoId, name]
  );
  return rows[0] || null;
}

/**
 * Save evaluation result to DB.
 */
export async function saveEvaluation(gateId, repoId, evaluation, { headSha, prNumber, durationMs } = {}) {
  const { rows } = await db.query(
    `INSERT INTO gate_evaluations
       (gate_id, repo_id, head_sha, pr_number, result, conditions, score, passed_count, failed_count, total_count, duration_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      gateId,
      repoId,
      headSha || null,
      prNumber || null,
      evaluation.result,
      JSON.stringify(evaluation.conditions),
      evaluation.score,
      evaluation.passed,
      evaluation.failed,
      evaluation.total,
      durationMs || null,
    ]
  );
  return rows[0];
}

/**
 * Get evaluation history for a repo.
 */
export async function getEvaluationHistory(repoId, { limit = 20, prNumber } = {}) {
  const params = [repoId, limit];
  let filter = "repo_id = $1";
  if (prNumber) {
    filter += " AND pr_number = $3";
    params.push(prNumber);
  }
  const { rows } = await db.query(
    `SELECT ge.*, qg.name AS gate_name, qg.block_on_fail
     FROM gate_evaluations ge
     JOIN quality_gates qg ON qg.id = ge.gate_id
     WHERE ${filter}
     ORDER BY ge.evaluated_at DESC
     LIMIT $2`,
    params
  );
  return rows;
}

/**
 * Get the latest evaluation for each gate on a repo.
 */
export async function getLatestEvaluations(repoId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (ge.gate_id)
       ge.*, qg.name AS gate_name, qg.block_on_fail, qg.is_default
     FROM gate_evaluations ge
     JOIN quality_gates qg ON qg.id = ge.gate_id
     WHERE ge.repo_id = $1
     ORDER BY ge.gate_id, ge.evaluated_at DESC`,
    [repoId]
  );
  return rows;
}

// ════════════════════════════════════════════════════════════════════════════
// Evaluation Orchestrator
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate quality gates for a repo (used by API/dashboard).
 * Merges config gates with DB-stored gates, evaluates all, persists results.
 *
 * @param {number} repoId
 * @param {string} repoFullName
 * @param {{ headSha?: string, prNumber?: number }} options
 * @returns {Promise<Array<{ name, result, conditions, score, block_on_fail }>>}
 */
export async function evaluateGatesForRepo(repoId, repoFullName, options = {}) {
  const startTime = Date.now();
  const config = await getConfigForRepo(repoFullName);
  const metrics = await fetchMetrics(repoId);

  // ── Gate source resolution ──────────────────────────────────────────────
  // Gates come from three sources, in priority order:
  //   1. DB gates — explicitly created via dashboard API
  //   2. Config file gates — user wrote quality_gates in .gitwire.yml
  //   3. DEFAULT_CONFIG gates — never opt-in, must NOT be evaluated
  //
  // parseConfig() attaches _explicitKeys listing which top-level keys the
  // user actually wrote. configService attaches _meta.layers tracking which
  // config layers were found. Together they let us distinguish real config
  // from DEFAULT_CONFIG fallback.

  const dbGates = await getGatesForRepo(repoId);
  const hasRepoConfig = config._meta?.layers?.repo === true;
  const hasOrgConfig = config._meta?.layers?.org === true;
  const hasExplicitGates = config._explicitKeys?.includes("quality_gates");

  // Config file gates: only if user explicitly wrote quality_gates in YAML.
  // DEFAULT_CONFIG always includes a "default" gate, so checking for its
  // presence is useless — we must check provenance.
  const configGates = ((hasRepoConfig || hasOrgConfig) && hasExplicitGates)
    ? (config.quality_gates || {})
    : {};

  // Skip entirely if repo has no gates from any source
  if (dbGates.length === 0 && Object.keys(configGates).length === 0) {
    return [];
  }

  // Build merged gate set: DB gates override config gates by name
  const mergedGates = { ...configGates };
  for (const dbg of dbGates) {
    mergedGates[dbg.name] = {
      conditions: typeof dbg.conditions === "string" ? JSON.parse(dbg.conditions) : dbg.conditions,
      block_on_fail: dbg.block_on_fail,
    };
  }

  const mergedConfig = { ...config, quality_gates: mergedGates };
  const results = evaluateAllGates(mergedConfig, metrics);
  const durationMs = Date.now() - startTime;

  // Persist each result
  for (const r of results) {
    // Find or create gate in DB
    let gate = await getGate(repoId, r.name);
    if (!gate) {
      // Auto-create from config
      const cond = (mergedGates[r.name]?.conditions || []);
      gate = await saveGate(repoId, r.name, cond, {
        isDefault: r.name === "default",
        blockOnFail: mergedGates[r.name]?.block_on_fail !== false,
      });
    }

    await saveEvaluation(gate.id, repoId, r, {
      headSha: options.headSha,
      prNumber: options.prNumber,
      durationMs,
    });
  }

  return results;
}

/**
 * Evaluate quality gates specifically for a PR and post a GitHub check.
 * Called from the webhook pipeline.
 *
 * @param {object} params
 * @param {number} params.repoId
 * @param {string} params.repoFullName
 * @param {string} params.headSha
 * @param {number} params.prNumber
 * @param {object} params.octokit
 * @param {string} params.owner
 * @param {string} params.repo
 * @returns {Promise<Array>} evaluation results
 */
export async function evaluateGatesForPR({ repoId, repoFullName, headSha, prNumber, octokit, owner, repo }) {
  const results = await evaluateGatesForRepo(repoId, repoFullName, {
    headSha,
    prNumber,
  });

  if (results.length === 0) return [];

  // Determine overall result: fail if ANY blocking gate fails
  const blockingFailures = results.filter((r) => r.result === "failed" && r.block_on_fail);
  const overallPassed = blockingFailures.length === 0;

  // Build check summary
  const summaryParts = results.map((r) => formatGateSummary(r, r.name));
  const summary = summaryParts.join("\n\n---\n\n");

  const title = overallPassed
    ? "✅ All quality gates passed"
    : "❌ " + blockingFailures.length + " gate(s) failed";

  // Post GitHub check
  if (octokit && headSha) {
    try {
      // Find existing check or create new
      const { data: checks } = await octokit.request(
        "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        { owner, repo, ref: headSha, per_page: 100 }
      );

      const existingCheck = checks.check_runs?.find(
        (cr) => cr.name === "gitwire/quality-gate"
      );

      if (existingCheck) {
        await octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          {
            owner,
            repo,
            check_run_id: existingCheck.id,
            status: "completed",
            conclusion: overallPassed ? "success" : "failure",
            output: { title, summary },
          }
        );
      } else {
        await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
          owner,
          repo,
          name: "gitwire/quality-gate",
          head_sha: headSha,
          status: "completed",
          conclusion: overallPassed ? "success" : "failure",
          output: { title, summary },
        });
      }
    } catch (err) {
      logger.warn({ err: err.message, owner, repo, headSha }, "Failed to post quality-gate check (non-fatal)");
    }
  }

  return results;
}

/**
 * Get fleet-wide gate summary for all repos.
 */
export async function getFleetSummary() {
  const { rows: repos } = await db.query(
    `SELECT github_id, full_name FROM repositories ORDER BY full_name`
  );

  const summary = [];
  for (const repo of repos) {
    const latest = await getLatestEvaluations(repo.github_id);
    if (latest.length === 0) continue;

    const allPassed = latest.every((e) => e.result === "passed");
    const hasFailure = latest.some((e) => e.result === "failed" && e.block_on_fail);

    summary.push({
      repo: repo.full_name,
      repoId: repo.github_id,
      gates: latest.map((e) => ({
        name: e.gate_name,
        result: e.result,
        score: e.score,
        block_on_fail: e.block_on_fail,
        evaluated_at: e.evaluated_at,
      })),
      overall: allPassed ? "passed" : (hasFailure ? "failed" : "warning"),
    });
  }

  const passedCount = summary.filter((s) => s.overall === "passed").length;
  const failedCount = summary.filter((s) => s.overall === "failed").length;

  return {
    total_repos: summary.length,
    passed: passedCount,
    failed: failedCount,
    repos: summary,
  };
}
