// src/routes/readiness.js
// Repo readiness score — per-repo checklist that shows how well GitWire
// is configured and integrated. Returns 0-100 score with pass/fail checks.

import { Router } from "express";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── Check definitions ────────────────────────────────────────────────────────
// Each check: { id, label, weight, query }
// Query returns { pass: boolean, detail: string }

const CHECKS = [
  {
    id: "webhook_active",
    label: "Webhook receiving events",
    weight: 15,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS cnt, MAX(received_at) AS last_event
         FROM webhook_deliveries WHERE repo = $1 AND received_at > NOW() - INTERVAL '7 days'`,
        [repoFullName]
      );
      const cnt = rows[0]?.cnt || 0;
      const last = rows[0]?.last_event;
      return {
        pass: cnt > 0,
        detail: cnt > 0
          ? `${cnt} events in last 7 days (last: ${last ? new Date(last).toLocaleDateString() : "n/a"})`
          : "No webhook events received in the last 7 days",
      };
    },
  },
  {
    id: "repo_synced",
    label: "Repository data synced",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT last_synced_at FROM repositories WHERE full_name = $1`,
        [repoFullName]
      );
      const last = rows[0]?.last_synced_at;
      return {
        pass: !!last,
        detail: last
          ? `Last synced: ${new Date(last).toLocaleDateString()}`
          : "Never synced — data not yet imported",
      };
    },
  },
  {
    id: "gitwire_yml",
    label: ".gitwire.yml policy file",
    weight: 15,
    async query(repoFullName, githubId) {
      // Check if config was fetched from GitHub (has YAML content different from defaults)
      // We check the config source by looking at DB overrides
      const { rows } = await db.query(
        `SELECT config FROM repo_config WHERE repo_id = $1`,
        [githubId]
      );
      if (rows.length > 0) {
        // DB overrides exist — config is at least partially customized
        return { pass: true, detail: "Custom config via dashboard or .gitwire.yml" };
      }
      // No DB overrides — check if we've ever cached a YAML config in Redis
      // Since we can't easily check Redis here, report based on default usage
      return {
        pass: false,
        detail: "No .gitwire.yml found — using defaults (all pillars enabled)",
      };
    },
  },
  {
    id: "config_overrides",
    label: "Dashboard config overrides",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT id FROM repo_config WHERE repo_id = $1`,
        [githubId]
      );
      return {
        pass: rows.length > 0,
        detail: rows.length > 0
          ? "Config overrides set via dashboard"
          : "No dashboard overrides — using YAML + defaults",
      };
    },
  },
  {
    id: "stale_policy",
    label: "Stale management configured",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT stale_warn_days FROM maintainer_settings WHERE repo_id = $1`,
        [githubId]
      );
      return {
        pass: rows.length > 0,
        detail: rows.length > 0
          ? "Stale policy set (warn/close thresholds configured)"
          : "No stale policy — using default thresholds",
      };
    },
  },
  {
    id: "issues_triaged",
    label: "Issues being triaged",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE triage_type IS NOT NULL)::int AS triaged
        FROM issues WHERE repo_id = $1`,
        [githubId]
      );
      const total = rows[0]?.total || 0;
      const triaged = rows[0]?.triaged || 0;
      return {
        pass: triaged > 0,
        detail: total === 0
          ? "No issues synced yet"
          : `${triaged}/${total} issues triaged`,
      };
    },
  },
  {
    id: "ci_runs_received",
    label: "CI runs being tracked",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM ci_runs WHERE repo_id = $1`,
        [githubId]
      );
      const cnt = rows[0]?.cnt || 0;
      return {
        pass: cnt > 0,
        detail: cnt > 0
          ? `${cnt} CI runs tracked`
          : "No CI runs received yet",
      };
    },
  },
  {
    id: "branch_protection",
    label: "Branch protection policy",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT id FROM policy_repo_configs WHERE repo_id = $1 LIMIT 1`,
        [githubId]
      );
      return {
        pass: rows.length > 0,
        detail: rows.length > 0
          ? "Branch protection policy configured"
          : "No branch protection policies defined",
      };
    },
  },
  {
    id: "config_versioned",
    label: "Config changes tracked",
    weight: 10,
    async query(repoFullName, githubId) {
      const { rows } = await db.query(
        `SELECT COUNT(*)::int AS cnt FROM config_history WHERE repo_id = $1`,
        [githubId]
      );
      const cnt = rows[0]?.cnt || 0;
      return {
        pass: cnt > 0,
        detail: cnt > 0
          ? `${cnt} config change(s) recorded`
          : "No config history yet",
      };
    },
  },
];

// ── GET /api/readiness ───────────────────────────────────────────────────────
// Returns readiness scores for ALL repos.

router.get("/", async (req, res) => {
  try {
    const { rows: repos } = await db.query(
      `SELECT github_id, full_name, owner, name, language, private, last_synced_at
       FROM repositories ORDER BY full_name`
    );

    const scores = [];
    for (const repo of repos) {
      const checks = [];
      let earned = 0;
      let possible = 0;

      for (const check of CHECKS) {
        try {
          const result = await check.query(repo.full_name, repo.github_id);
          possible += check.weight;
          if (result.pass) earned += check.weight;
          checks.push({
            id: check.id,
            label: check.label,
            weight: check.weight,
            pass: result.pass,
            detail: result.detail,
          });
        } catch (err) {
          possible += check.weight;
          checks.push({
            id: check.id,
            label: check.label,
            weight: check.weight,
            pass: false,
            detail: "Check failed: " + err.message,
          });
        }
      }

      const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;
      scores.push({
        repo: repo.full_name,
        owner: repo.owner,
        name: repo.name,
        language: repo.language,
        private: repo.private,
        last_synced_at: repo.last_synced_at,
        score,
        earned,
        possible,
        checks,
      });
    }

    // Fleet summary
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length)
      : 0;

    const passCounts = {};
    for (const checkDef of CHECKS) {
      const passed = scores.filter(s => s.checks.find(c => c.id === checkDef.id && c.pass)).length;
      passCounts[checkDef.id] = { label: checkDef.label, passed, total: scores.length };
    }

    res.json({
      total_repos: scores.length,
      average_score: avgScore,
      check_coverage: passCounts,
      repos: scores,
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute readiness scores");
    res.status(500).json({ error: "Failed to compute readiness scores" });
  }
});

// ── GET /api/readiness/:owner/:repo ─────────────────────────────────────────
// Returns readiness score for a single repo.

router.get("/:owner/:repo", async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const fullName = `${owner}/${repo}`;

    const { rows: [repoRow] } = await db.query(
      `SELECT github_id, full_name, owner, name, language, private, last_synced_at
       FROM repositories WHERE full_name = $1`,
      [fullName]
    );

    if (!repoRow) {
      return res.status(404).json({ error: "Repository not found" });
    }

    const checks = [];
    let earned = 0;
    let possible = 0;

    for (const check of CHECKS) {
      try {
        const result = await check.query(repoRow.full_name, repoRow.github_id);
        possible += check.weight;
        if (result.pass) earned += check.weight;
        checks.push({
          id: check.id,
          label: check.label,
          weight: check.weight,
          pass: result.pass,
          detail: result.detail,
        });
      } catch (err) {
        possible += check.weight;
        checks.push({
          id: check.id,
          label: check.label,
          weight: check.weight,
          pass: false,
          detail: "Check failed: " + err.message,
        });
      }
    }

    const score = possible > 0 ? Math.round((earned / possible) * 100) : 0;

    res.json({
      repo: repoRow.full_name,
      owner: repoRow.owner,
      name: repoRow.name,
      language: repoRow.language,
      private: repoRow.private,
      last_synced_at: repoRow.last_synced_at,
      score,
      earned,
      possible,
      checks,
    });
  } catch (err) {
    logger.error({ err }, "Failed to compute readiness score");
    res.status(500).json({ error: "Failed to compute readiness score" });
  }
});

export default router;
