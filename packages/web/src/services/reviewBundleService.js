// src/services/reviewBundleService.js
// Packages everything an AI reviewer needs into one structured text blob.
//
// Adapted from prior autoreview work autoreview "bundle" pattern:
//   Instead of per-file review calls, build ONE context-rich bundle
//   so the model can reason holistically across files.
//
// Bundle structure:
//   1. PR metadata (title, description, author, branches)
//   2. Diff sections (per-file with stats)
//   3. File list summary (for scope validation)
//   4. Repo context (recent issues, CI runs, prior reviews)
//   5. Config snapshot (enabled pillars, quality gates)
//   6. Architecture context (from config)

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { getConfigForRepo } from "./configService.js";

const MAX_BUNDLE_CHARS = 180000; // ~45K tokens, well within Claude context
const MAX_DIFF_PER_FILE = 4000;
const MAX_CONTEXT_ITEMS = 5;

/**
 * Build a complete review bundle for a PR.
 *
 * @param {object} opts
 * @param {object} opts.files - Pre-fetched diff files from fetchDiff()
 * @param {object} opts.pr - GitHub PR payload
 * @param {object} opts.repository - GitHub repository payload
 * @param {object} [opts.config] - Pre-loaded config (optional, fetched if not provided)
 * @returns {Promise<{ bundle: string, changedFiles: string[], totalChars: number }>}
 */
export async function buildReviewBundle({ files, pr, repository, config }) {
  const repoFullName = repository.full_name;
  const repoId = repository.id;

  // Load config if not provided
  if (!config) {
    try {
      config = await getConfigForRepo(repoFullName);
    } catch (_e) {
      logger.debug({ repoFullName, err: _e }, "Config load failed in review bundle — defaulting to empty");
      config = {};
    }
  }

  const parts = [];
  const changedFiles = files.map(function (f) { return f.filename; });

  // ── 1. PR Metadata ─────────────────────────────────────────────────────
  parts.push("## PR Metadata");
  parts.push("Repository: " + repoFullName);
  parts.push("PR #" + pr.number + ": " + pr.title);
  parts.push("Author: @" + pr.user.login);
  parts.push("Base: " + pr.base.ref + " ← Head: " + pr.head.ref);
  parts.push("Commits: " + (pr.commits || "?") + "  Changed files: " + files.length);
  if (pr.body && pr.body.trim()) {
    parts.push("");
    parts.push("### Description");
    parts.push(pr.body.trim().slice(0, 2000));
  }

  // ── 2. Diff Sections ───────────────────────────────────────────────────
  parts.push("");
  parts.push("## Changes");
  parts.push("");
  parts.push("### File Summary");
  for (const f of files) {
    parts.push("  " + f.status.padEnd(10) + " " + f.filename + " (+" + f.added + " -" + f.removed + ")");
  }

  parts.push("");
  parts.push("### Diffs");
  for (const f of files) {
    parts.push("");
    parts.push("#### " + f.filename + " (+" + f.added + " -" + f.removed + ")");
    if (f.patch) {
      const patch = f.patch.length > MAX_DIFF_PER_FILE
        ? f.patch.slice(0, MAX_DIFF_PER_FILE) + "\n... (truncated)"
        : f.patch;
      parts.push("```diff");
      parts.push(patch);
      parts.push("```");
    } else {
      parts.push("(no diff available — binary or large file)");
    }
  }

  // ── 3. Repo Context ────────────────────────────────────────────────────
  parts.push("");
  parts.push("## Repository Context");

  // Recent issues
  try {
    const { rows: recentIssues } = await db.query(
      "SELECT number, title, state, labels FROM issues " +
      "WHERE repo_id = $1 AND state = 'open' " +
      "ORDER BY updated_at DESC LIMIT $2",
      [repoId, MAX_CONTEXT_ITEMS]
    );
    if (recentIssues.length > 0) {
      parts.push("");
      parts.push("### Recent Open Issues");
      for (const issue of recentIssues) {
        const labels = Array.isArray(issue.labels) && issue.labels.length > 0
          ? " [" + issue.labels.join(", ") + "]"
          : "";
        parts.push("  #" + issue.number + ": " + issue.title + labels);
      }
    }
  } catch (_e) {
    logger.debug({ err: _e }, "Issue context enrichment failed — non-critical");
  }

  // Recent CI runs
  try {
    const { rows: recentCI } = await db.query(
      "SELECT head_branch, conclusion, created_at FROM ci_runs " +
      "WHERE repo_id = $1 " +
      "ORDER BY created_at DESC LIMIT $2",
      [repoId, MAX_CONTEXT_ITEMS]
    );
    if (recentCI.length > 0) {
      parts.push("");
      parts.push("### Recent CI Runs");
      for (const run of recentCI) {
        const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⚪";
        parts.push("  " + icon + " " + run.head_branch + " — " + run.conclusion);
      }
    }
  } catch (_e) {
    logger.debug({ err: _e }, "CI run context enrichment failed — non-critical");
  }
  try {
    const { rows: priorReviews } = await db.query(
      "SELECT pr_number, verdict, confidence, " +
      "  jsonb_array_length(findings) AS finding_count " +
      "FROM ai_reviews " +
      "WHERE repo_id = $1 " +
      "ORDER BY completed_at DESC LIMIT $2",
      [repoId, MAX_CONTEXT_ITEMS]
    );
    if (priorReviews.length > 0) {
      parts.push("");
      parts.push("### Prior AI Reviews");
      for (const rev of priorReviews) {
        parts.push("  PR #" + rev.pr_number + ": " + rev.verdict + " (" + rev.confidence + " confidence, " + rev.finding_count + " findings)");
      }
    }
  } catch (_e) {
    logger.debug({ err: _e }, "Prior reviews enrichment failed — non-critical");
  }

  // ── 4. Config Snapshot ─────────────────────────────────────────────────
  parts.push("");
  parts.push("## Active Configuration");

  const aiReviewCfg = config.pillars?.ai_review || {};
  parts.push("AI Review enabled: " + (aiReviewCfg.enabled !== false ? "yes" : "no"));

  // Quality gates summary
  const gates = config.quality_gates || {};
  const gateNames = Object.keys(gates);
  if (gateNames.length > 0) {
    parts.push("Quality gates: " + gateNames.join(", "));
    for (const [name, gate] of Object.entries(gates)) {
      if (gate.conditions) {
        const condSummary = gate.conditions.map(function (c) {
          return c.metric + " " + c.operator + " " + c.threshold;
        }).join(", ");
        parts.push("  " + name + ": " + condSummary);
      }
    }
  }

  // Architecture context from config
  if (aiReviewCfg.architecture_context) {
    parts.push("");
    parts.push("## Architecture Context");
    parts.push(aiReviewCfg.architecture_context.slice(0, 3000));
  }

  // ── Assemble and truncate ──────────────────────────────────────────────
  let bundle = parts.join("\n");

  if (bundle.length > MAX_BUNDLE_CHARS) {
    // Truncate from the diffs (keep metadata + context)
    const metaEnd = bundle.indexOf("## Changes");
    const contextStart = bundle.indexOf("## Repository Context");

    if (metaEnd !== -1 && contextStart !== -1) {
      const meta = bundle.slice(0, metaEnd);
      const context = bundle.slice(contextStart);
      const diffBudget = MAX_BUNDLE_CHARS - meta.length - context.length - 100;

      if (diffBudget > 2000) {
        // Rebuild diffs within budget
        const diffParts = [];
        let diffChars = 0;
        for (const f of files) {
          const fileDiff = "#### " + f.filename + " (+" + f.added + " -" + f.removed + ")\n```diff\n" +
            (f.patch ? f.patch.slice(0, Math.min(MAX_DIFF_PER_FILE, diffBudget - diffChars - 100)) : "(no diff)") +
            "\n```";
          if (diffChars + fileDiff.length > diffBudget) break;
          diffParts.push(fileDiff);
          diffChars += fileDiff.length;
        }
        bundle = meta + "## Changes\n\n### Diffs\n\n" + diffParts.join("\n\n") + "\n\n" + context;
      } else {
        bundle = bundle.slice(0, MAX_BUNDLE_CHARS) + "\n\n... (bundle truncated)";
      }
    } else {
      bundle = bundle.slice(0, MAX_BUNDLE_CHARS) + "\n\n... (bundle truncated)";
    }
  }

  return {
    bundle,
    changedFiles,
    totalChars: bundle.length,
  };
}
