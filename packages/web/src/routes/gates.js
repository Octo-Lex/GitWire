// src/routes/gates.js
// Quality gate API — CRUD gate definitions, evaluate, view history.
//
// Endpoints:
//   GET    /api/gates                       — Fleet-wide summary
//   GET    /api/gates/:owner/:repo          — Repo gates + latest results
//   POST   /api/gates/:owner/:repo          — Create/update a gate
//   DELETE /api/gates/:owner/:repo/:name    — Delete a gate
//   POST   /api/gates/:owner/:repo/evaluate — Trigger evaluation
//   GET    /api/gates/:owner/:repo/history  — Evaluation history

import { Router } from "express";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import {
  saveGate,
  deleteGate,
  getGatesForRepo,
  getLatestEvaluations,
  getEvaluationHistory,
  evaluateGatesForRepo,
  evaluateGatesForPR,
  getFleetSummary,
  fetchMetrics,
} from "../services/qualityGateService.js";
import { getInstallationClient } from "../lib/github.js";

const router = Router();

// ── GET /api/gates — Fleet-wide gate summary ───────────────────────────────
router.get("/", async (req, res) => {
  try {
    const summary = await getFleetSummary();
    res.json(summary);
  } catch (err) {
    logger.error({ err }, "Failed to get fleet gate summary");
    res.status(500).json({ error: "Failed to get gate summary" });
  }
});

// ── GET /api/gates/:owner/:repo — Repo gates + latest results ──────────────
router.get("/:owner/:repo", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const gates = await getGatesForRepo(repo.github_id);
    const latest = await getLatestEvaluations(repo.github_id);

    // Merge gates with their latest results
    const gateResults = gates.map((g) => {
      const eval_ = latest.find((e) => e.gate_name === g.name);
      return {
        id: g.id,
        name: g.name,
        is_default: g.is_default,
        conditions: typeof g.conditions === "string" ? JSON.parse(g.conditions) : g.conditions,
        block_on_fail: g.block_on_fail,
        created_at: g.created_at,
        updated_at: g.updated_at,
        latest_evaluation: eval_ ? {
          result: eval_.result,
          score: eval_.score,
          passed_count: eval_.passed_count,
          failed_count: eval_.failed_count,
          total_count: eval_.total_count,
          conditions: typeof eval_.conditions === "string" ? JSON.parse(eval_.conditions) : eval_.conditions,
          evaluated_at: eval_.evaluated_at,
        } : null,
      };
    });

    const allPassed = gateResults.every(
      (g) => !g.latest_evaluation || g.latest_evaluation.result === "passed"
    );

    res.json({
      repo: fullName,
      overall: allPassed ? "passed" : "failed",
      gates: gateResults,
      total: gateResults.length,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get repo gates");
    res.status(500).json({ error: "Failed to get gates" });
  }
});

// ── POST /api/gates/:owner/:repo — Create/update a gate ────────────────────
router.post("/:owner/:repo", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const { name, conditions, is_default, block_on_fail } = req.body;
    if (!name || typeof name !== "string") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return res.status(400).json({ error: "conditions must be a non-empty array" });
    }

    // Validate conditions
    const validOps = ["<", "<=", ">", ">=", "==", "!="];
    for (const c of conditions) {
      if (!c.metric || typeof c.metric !== "string") {
        return res.status(400).json({ error: "Each condition needs a 'metric' string" });
      }
      if (!validOps.includes(c.operator)) {
        return res.status(400).json({ error: "operator must be one of: " + validOps.join(", ") });
      }
      if (typeof c.threshold !== "number") {
        return res.status(400).json({ error: "threshold must be a number" });
      }
    }

    const gate = await saveGate(repo.github_id, name, conditions, {
      isDefault: is_default || false,
      blockOnFail: block_on_fail !== false,
    });

    res.status(201).json(gate);
  } catch (err) {
    logger.error({ err }, "Failed to save gate");
    res.status(500).json({ error: "Failed to save gate" });
  }
});

// ── DELETE /api/gates/:owner/:repo/:name — Delete a gate ───────────────────
router.delete("/:owner/:repo/:name", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const deleted = await deleteGate(repo.github_id, req.params.name);
    if (!deleted) return res.status(404).json({ error: "Gate not found" });

    res.json({ deleted: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete gate");
    res.status(500).json({ error: "Failed to delete gate" });
  }
});

// ── POST /api/gates/:owner/:repo/evaluate — Trigger evaluation ─────────────
router.post("/:owner/:repo/evaluate", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id, owner, name FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const { head_sha, pr_number } = req.body;

    // If head_sha provided, try to post GitHub check
    let octokit;
    if (head_sha) {
      try {
        octokit = await getInstallationClient(null); // may not have installation context
      } catch (_e) {
        // No GitHub client — just evaluate without posting check
      }
    }

    if (head_sha && pr_number && octokit) {
      const results = await evaluateGatesForPR({
        repoId: repo.github_id,
        repoFullName: fullName,
        headSha: head_sha,
        prNumber: pr_number,
        octokit,
        owner: repo.owner,
        repo: repo.name,
      });
      return res.json({ repo: fullName, results });
    }

    const results = await evaluateGatesForRepo(repo.github_id, fullName, {
      headSha: head_sha,
      prNumber: pr_number,
    });

    res.json({ repo: fullName, results });
  } catch (err) {
    logger.error({ err }, "Failed to evaluate gates");
    res.status(500).json({ error: "Failed to evaluate gates" });
  }
});

// ── GET /api/gates/:owner/:repo/history — Evaluation history ───────────────
router.get("/:owner/:repo/history", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const prNumber = req.query.pr ? parseInt(req.query.pr) : undefined;

    const history = await getEvaluationHistory(repo.github_id, { limit, prNumber });

    res.json({
      repo: fullName,
      total: history.length,
      evaluations: history.map((e) => ({
        id: e.id,
        gate_name: e.gate_name,
        result: e.result,
        score: e.score,
        passed_count: e.passed_count,
        failed_count: e.failed_count,
        total_count: e.total_count,
        head_sha: e.head_sha,
        pr_number: e.pr_number,
        block_on_fail: e.block_on_fail,
        conditions: typeof e.conditions === "string" ? JSON.parse(e.conditions) : e.conditions,
        evaluated_at: e.evaluated_at,
        duration_ms: e.duration_ms,
      })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to get evaluation history");
    res.status(500).json({ error: "Failed to get history" });
  }
});

// ── GET /api/gates/:owner/:repo/metrics — Raw metric values ────────────────
router.get("/:owner/:repo/metrics", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const { rows: [repo] } = await db.query(
      "SELECT github_id FROM repositories WHERE full_name = $1",
      [fullName]
    );
    if (!repo) return res.status(404).json({ error: "Repository not found" });

    const metrics = await fetchMetrics(repo.github_id);
    res.json({ repo: fullName, metrics });
  } catch (err) {
    logger.error({ err }, "Failed to fetch metrics");
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

export default router;
