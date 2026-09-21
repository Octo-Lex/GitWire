// src/services/reviewBundleService.js
// Packages everything an AI reviewer needs into one structured text blob.
//
// Adapted from prior autoreview work autoreview "bundle" pattern:
//   Instead of per-file review calls, build ONE context-rich bundle
//   so the model can reason holistically across files.
//
// PC-01 v2.1 (2026-09-21): the legacy evidence-admission ceilings
// (MAX_DIFF_PER_FILE = 12,000 chars per file and MAX_BUNDLE_CHARS = 180,000
// chars aggregate) are REMOVED. This service now assembles COMPLETE evidence
// and never truncates on its own. Model-context admission moved to the
// review execution layer (aiReviewService + reviewTokenAccounting), which
// counts the exact request against the frozen 958,016-input-token ceiling
// and, on overflow, asks this service to reassemble with a deterministic
// prefix of file sections. Files the allocation omits are reported as
// coverage adjustments with reason "bundle_truncated" so downstream coverage
// and publication decisions stay truthful about incomplete evidence.
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

const MAX_CONTEXT_ITEMS = 5;

/**
 * Build a complete review bundle for a PR. No truncation happens here.
 *
 * @param {object} opts
 * @param {object} opts.files - Pre-fetched diff files from fetchDiff()
 * @param {object} opts.pr - GitHub PR payload
 * @param {object} opts.repository - GitHub repository payload
 * @param {object} [opts.config] - Pre-loaded config (optional, fetched if not provided)
 * @returns {Promise<{
 *   bundle: string, changedFiles: string[], totalChars: number,
 *   coverageAdjustments: Array,
 *   fileSections: Array<{path: string, text: string}>,
 *   reassemble: (admittedCount: number) => {bundle: string, coverageAdjustments: Array}
 * }>}
 *   `fileSections` carries each file's diff section text in existing file
 *   order. `reassemble(n)` rebuilds the bundle with only the first n diff
 *   sections and marks every omitted file bundle_truncated.
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

  const changedFiles = files.map(function (f) { return f.filename; });
  const coverageAdjustments = [];

  // ── 1. PR Metadata + file summary (always preserved by the allocator) ────
  const metaParts = [];
  metaParts.push("## PR Metadata");
  metaParts.push("Repository: " + repoFullName);
  metaParts.push("PR #" + pr.number + ": " + pr.title);
  metaParts.push("Author: @" + pr.user.login);
  metaParts.push("Base: " + pr.base.ref + " ← Head: " + pr.head.ref);
  metaParts.push("Commits: " + (pr.commits || "?") + "  Changed files: " + files.length);
  if (pr.body && pr.body.trim()) {
    metaParts.push("");
    metaParts.push("### Description");
    metaParts.push(pr.body.trim().slice(0, 2000));
  }

  // ── 2. Diff sections — one per file, in existing (GitHub) order ─────────
  metaParts.push("");
  metaParts.push("## Changes");
  metaParts.push("");
  metaParts.push("### File Summary");
  for (const f of files) {
    metaParts.push("  " + f.status.padEnd(10) + " " + f.filename + " (+" + f.additions + " -" + f.removed + ")");
  }

  metaParts.push("");
  metaParts.push("### Diffs");

  const fileSections = files.map(function (f) {
    const header = "#### " + f.filename + " (+" + f.additions + " -" + f.removed + ")";
    const lines = f.patch
      ? ["", header, "```diff", f.patch, "```"]
      : ["", header, "(no diff available — binary or large file)"];
    return { path: f.filename, lines, text: lines.join("\n") };
  });

  // ── 3. Repo Context ────────────────────────────────────────────────────
  const contextParts = [];
  contextParts.push("");
  contextParts.push("## Repository Context");

  // Recent issues
  try {
    const { rows: recentIssues } = await db.query(
      "SELECT number, title, state, labels FROM issues " +
      "WHERE repo_id = $1 AND state = 'open' " +
      "ORDER BY updated_at DESC LIMIT $2",
      [repoId, MAX_CONTEXT_ITEMS]
    );
    if (recentIssues.length > 0) {
      contextParts.push("");
      contextParts.push("### Recent Open Issues");
      for (const issue of recentIssues) {
        const labels = Array.isArray(issue.labels) && issue.labels.length > 0
          ? " [" + issue.labels.join(", ") + "]"
          : "";
        contextParts.push("  #" + issue.number + ": " + issue.title + labels);
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
      contextParts.push("");
      contextParts.push("### Recent CI Runs");
      for (const run of recentCI) {
        const icon = run.conclusion === "success" ? "✅" : run.conclusion === "failure" ? "❌" : "⚪";
        contextParts.push("  " + icon + " " + run.head_branch + " — " + run.conclusion);
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
      contextParts.push("");
      contextParts.push("### Prior AI Reviews");
      for (const rev of priorReviews) {
        contextParts.push("  PR #" + rev.pr_number + ": " + rev.verdict + " (" + rev.confidence + " confidence, " + rev.finding_count + " findings)");
      }
    }
  } catch (_e) {
    logger.debug({ err: _e }, "Prior reviews enrichment failed — non-critical");
  }

  // ── 4. Config Snapshot ─────────────────────────────────────────────────
  contextParts.push("");
  contextParts.push("## Active Configuration");

  const aiReviewCfg = config.pillars?.ai_review || {};
  contextParts.push("AI Review enabled: " + (aiReviewCfg.enabled !== false ? "yes" : "no"));

  // Quality gates summary
  const gates = config.quality_gates || {};
  const gateNames = Object.keys(gates);
  if (gateNames.length > 0) {
    contextParts.push("Quality gates: " + gateNames.join(", "));
    for (const [name, gate] of Object.entries(gates)) {
      if (gate.conditions) {
        const condSummary = gate.conditions.map(function (c) {
          return c.metric + " " + c.operator + " " + c.threshold;
        }).join(", ");
        contextParts.push("  " + name + ": " + condSummary);
      }
    }
  }

  // Architecture context from config
  if (aiReviewCfg.architecture_context) {
    contextParts.push("");
    contextParts.push("## Architecture Context");
    contextParts.push(aiReviewCfg.architecture_context.slice(0, 3000));
  }

  // ── Assemble ─────────────────────────────────────────────────────────────
  function assemble(admittedCount, truncationNote) {
    const parts = [...metaParts];
    for (let i = 0; i < admittedCount; i++) parts.push(...fileSections[i].lines);
    if (truncationNote) parts.push(truncationNote);
    parts.push(...contextParts);
    return parts.join("\n");
  }

  const bundle = assemble(fileSections.length, null);

  /**
   * Deterministic reassembly after token-budget allocation: keep the first
   * `admittedCount` diff sections, omit the rest, and report every omitted
   * file as a bundle_truncated coverage adjustment. Metadata and repository
   * context are always preserved. (The crossing file and everything after it
   * are omitted, mirroring the legacy aggregate-truncation semantics.)
   */
  function reassemble(admittedCount) {
    const clamped = Math.max(0, Math.min(admittedCount, fileSections.length));
    const omitted = fileSections.length - clamped;
    const adjustments = [];
    for (let i = clamped; i < fileSections.length; i++) {
      adjustments.push({ path: fileSections[i].path, coverage: "partial", reason: "bundle_truncated" });
    }
    const note = omitted > 0
      ? "(review input token budget reached — " + omitted + " remaining changed-file diff" + (omitted !== 1 ? "s" : "") + " omitted)"
      : null;
    return { bundle: assemble(clamped, note), coverageAdjustments: adjustments };
  }

  return {
    bundle,
    changedFiles,
    totalChars: bundle.length,
    coverageAdjustments,
    fileSections,
    reassemble,
  };
}
