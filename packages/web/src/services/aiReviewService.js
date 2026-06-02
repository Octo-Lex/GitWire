// src/services/aiReviewService.js
// Pre-merge AI review gate — v2 with bundle-driven review.
//
// Adapted from prior autoreview work autoreview patterns:
//   - Bundle-driven: one structured prompt with full PR context
//   - Strict JSON schema enforcement at AI boundary
//   - Out-of-scope finding rejection
//   - JSON extraction cascade (handles all LLM output formats)
//   - Heartbeat wrapper for long-running reviews
//
// Flow:
//   1. Check repo has AI review enabled
//   2. Create a "pending" GitHub Check Run
//   3. Fetch diff + build review bundle (context-enriched)
//   4. Single-pass structured review via Claude with schema enforcement
//   5. Extract JSON with cascade (handles fenced, JSONL, nested formats)
//   6. Validate schema + scope-filter findings
//   7. Compute verdict from validated report
//   8. Post GitHub PR Review with finding annotations
//   9. Update Check Run to pass/fail
//  10. Write to audit trail
//  11. Persist to ai_reviews table (with new structured columns)

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { Trail }  from "./auditTrailService.js";
import { Events } from "./pipelineEvents.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { minimatch } from "minimatch";
import {
  extractReviewJSON,
  buildReviewSystemPrompt,
  reportToLegacy,
} from "@gitwire/rules";
import { buildReviewBundle } from "./reviewBundleService.js";
import { validateReview } from "./reviewValidator.js";
import { withHeartbeat } from "./reviewHeartbeat.js";
import { runAdversarialChallenge, refineFindings } from "./adversarialReview.js";
import { runDefensePass, refineWithDefense } from "./adversarialDefense.js";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
});

const CHECK_RUN_NAME = "GitWire AI Review";
const DEFAULT_MAX_DURATION_MS = 300000; // 5 minutes
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {object} opts.pr          - GitHub pull_request payload
 * @param {object} opts.repository  - GitHub repository payload
 * @param {object} opts.octokit
 * @param {boolean} [opts.commentFindings=true]
 */
export async function reviewPR({ pr, repository, octokit, commentFindings = true }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const repoId = repository.id;
  const startTime = Date.now();

  // ── 0. Skip if PR was created by GitWire bot ───────────────────────────────
  // GitHub rejects reviews from the PR author. Bot-created PRs (heal, fix)
  // will fail with "Cannot approve your own pull request".
  const prAuthor = pr.user?.login || "";
  if (prAuthor.endsWith("[bot]") || prAuthor.includes("gitwire")) {
    logger.info({ repo: repository.full_name, pr: pr.number, author: prAuthor }, "AI review: skipping bot-authored PR");
    return null;
  }

  // ── 1. Load config ─────────────────────────────────────────────────────────
  const cfg = await loadReviewConfig(repoId);
  if (!cfg?.enabled) return null;

  logger.info({ repo: repository.full_name, pr: pr.number }, "AI review: starting (bundle-driven v2)");

  // ── 2. Create pending check run ────────────────────────────────────────────
  let checkRunId = null;
  try {
    const { data: checkRun } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name:       CHECK_RUN_NAME,
      head_sha:   pr.head.sha,
      status:     "in_progress",
      started_at: new Date().toISOString(),
      output: {
        title:   "AI review in progress\u2026",
        summary: "Building review bundle and running structured analysis.",
      },
    });
    checkRunId = checkRun.id;
  } catch (checkErr) {
    logger.warn({ err: checkErr.message, repo: repository.full_name }, "AI review: Check Run creation failed (non-fatal)");
  }

  // ── 3. Persist review record ────────────────────────────────────────────────
  const { rows: [reviewRow] } = await db.query(
    "INSERT INTO ai_reviews (repo_id, pr_number, commit_sha, check_run_id, config_snapshot) " +
    "VALUES ($1,$2,$3,$4,$5) " +
    "ON CONFLICT (repo_id, pr_number, commit_sha) DO UPDATE SET " +
    "  check_run_id = COALESCE(EXCLUDED.check_run_id, ai_reviews.check_run_id), started_at = NOW() " +
    "RETURNING id",
    [repoId, pr.number, pr.head.sha, checkRunId, JSON.stringify(cfg)]
  );

  try {
    // ── 4. Fetch diff ─────────────────────────────────────────────────────────
    const { files, totalAdded, totalRemoved } = await fetchDiff(octokit, owner, repo, pr, cfg);

    if (!files.length) {
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "success", {
          title:   "\u2705 No reviewable files changed",
          summary: "All changed files are excluded by the ignore patterns.",
          text:    "",
        });
      }
      return null;
    }

    // ── 5. Build review bundle ────────────────────────────────────────────────
    const { bundle, changedFiles } = await buildReviewBundle({
      files, pr, repository,
    });

    logger.info(
      { repo: repository.full_name, pr: pr.number, bundleChars: bundle.length, files: changedFiles.length },
      "AI review: bundle built"
    );

    // ── 6. Run structured review with heartbeat ──────────────────────────────
    const maxDurationMs = cfg.max_duration_seconds
      ? cfg.max_duration_seconds * 1000
      : DEFAULT_MAX_DURATION_MS;

    const { rawText, tokensUsed } = await withHeartbeat(
      function () {
        return runStructuredReview(bundle, changedFiles, {
          model: cfg.model || DEFAULT_MODEL,
          includeSecurity: cfg.check_security !== false,
          includeArchitecture: cfg.check_architecture !== false || cfg.check_cost_leaks !== false,
          prTitle: pr.title || "",
          prAuthor: "@" + (pr.user?.login || "unknown"),
          prBranch: (pr.base?.ref || "main") + " ← " + (pr.head?.ref || "unknown"),
          repoName: repository.full_name,
        });
      },
      { label: "claude review", timeoutMs: maxDurationMs }
    );

    // ── 7. Extract JSON with cascade ─────────────────────────────────────────
    const { json, strategy } = extractReviewJSON(rawText);

    logger.info(
      { strategy, pr: pr.number, hasJson: !!json },
      "AI review: JSON extraction"
    );

    if (!json) {
      // Extraction failed completely — return neutral
      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u26A0\uFE0F AI review: could not parse response",
          summary: "Review completed but the response format was unexpected. Strategy: " + strategy,
          text:    rawText.slice(0, 2000),
        });
      }

      await db.query(
        "UPDATE ai_reviews SET verdict = 'error', summary = $1, tokens_used = $2, " +
        "completed_at = NOW(), duration_ms = $3 WHERE id = $4",
        ["JSON extraction failed (strategy: " + strategy + ")", tokensUsed, Date.now() - startTime, reviewRow.id]
      );

      return null;
    }

    // ── 8. Validate + scope-filter ────────────────────────────────────────────
    const validation = validateReview(json, changedFiles);

    if (!validation.valid) {
      logger.warn(
        { errors: validation.schemaErrors, pr: pr.number },
        "AI review: validation failed"
      );

      if (checkRunId) {
        await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
          title:   "\u26A0\uFE0F AI review: validation errors",
          summary: "Review completed but findings could not be validated. Errors: " + validation.schemaErrors.slice(0, 3).join("; "),
          text:    "",
        });
      }

      await db.query(
        "UPDATE ai_reviews SET verdict = 'error', summary = $1, tokens_used = $2, " +
        "completed_at = NOW(), duration_ms = $3 WHERE id = $4",
        ["Validation errors: " + validation.schemaErrors.join("; "), tokensUsed, Date.now() - startTime, reviewRow.id]
      );

      return null;
    }

    // ── 9. Use validated legacy format ────────────────────────────────────────
    let { findings, verdict, confidence, summary, overallCorrectness, overallConfidence } = validation.legacy;

    // ── 9b. Devil's Advocate: adversarial challenge pass ──────────────────────
    let adversarialMeta = null;
    if (cfg.adversarial_review !== false && findings.length > 0) {
      try {
        const challenge = await runAdversarialChallenge(findings, {
          prTitle: pr.title || "",
          repoName: repository.full_name,
          model: cfg.adversarial_model || undefined,
        });

        // ── 9c. Defense pass — dynamic trigger ────────────────────────────────
        //  Turn 3 runs only when Turn 2 reveals disagreement or escalated risk.
        //  Config: adversarial_defense = "auto" | "always" | "never"
        const defenseMode = cfg.adversarial_defense || "auto";
        const triggers = cfg.adversarial_defense_triggers || [
          "dropped_findings",
          "critical_downgraded",
          "new_criticals",
        ];
        const triggerResult = shouldRunDefense(
          defenseMode, triggers, findings, challenge.challenges, challenge.missedRisks
        );

        let defense = null;
        if (triggerResult.run) {
          defense = await runDefensePass(validation.legacy.findings, challenge.challenges, {
            prTitle: pr.title || "",
            repoName: repository.full_name,
            model: cfg.adversarial_defense_model || cfg.adversarial_model || undefined,
          });
          logger.info(
            { pr: pr.number, trigger: triggerResult.reason },
            "AI review: defense pass triggered (turn 3)"
          );
        } else {
          logger.info(
            { pr: pr.number, mode: defenseMode },
            "AI review: defense pass skipped (" + triggerResult.reason + ")"
          );
        }

        // Merge: challenge (+ optional defense) → final refined findings
        const refined = defense
          ? refineWithDefense(
              validation.legacy.findings,
              challenge.challenges,
              defense.defenses,
              challenge.missedRisks,
              defense.additionalMissed
            )
          : refineFindings(
              validation.legacy.findings,
              challenge.challenges,
              challenge.missedRisks
            );

        adversarialMeta = {
          dropped: refined.dropped.length,
          downgraded: findings.length - refined.dropped.length - refined.upheld.length,
          missedRisks: refined.missed.length,
          tokensUsed: challenge.tokensUsed + (defense ? defense.tokensUsed : 0),
          turns: defense ? 3 : 2,
          defenseTrigger: triggerResult.reason,
          defended: defense
            ? (defense.defenses || []).filter(function (d) { return d.action === "defend" || d.action === "upgrade"; }).length
            : 0,
          accepted: defense
            ? (defense.defenses || []).filter(function (d) { return d.action === "accept"; }).length
            : 0,
        };

        // Replace findings with refined set
        findings = refined.refined;

        // Recompute verdict with refined findings
        const recomputed = computeVerdict(findings, cfg);
        verdict = recomputed.verdict;
        confidence = recomputed.confidence;

        logger.info(
          {
            pr: pr.number, adversarialMeta,
            originalFindings: validation.legacy.findings.length,
            refinedFindings: findings.length,
          },
          "AI review: adversarial challenge complete"
        );
      } catch (advErr) {
        logger.warn(
          { err: advErr.message, pr: pr.number },
          "AI review: adversarial pass failed, using original findings"
        );
      }
    }

    // ── 10. Post GitHub PR Review ──────────────────────────────────────────────
    let reviewId = null;
    let githubSummary = "";
    if (commentFindings) {
      const result = await postGitHubReview({
        octokit, owner, repo, pr, findings, verdict, confidence, cfg,
        scopeDroppedCount: validation.scopeDroppedCount,
        adversarialMeta,
      });
      reviewId = result.reviewId;
      githubSummary = result.summary;
    }

    // ── 11. Update check run ──────────────────────────────────────────────────
    const shouldBlock = cfg.block_on_verdict?.includes(verdict) &&
      confidenceLevel(confidence) >= confidenceLevel(cfg.min_confidence_to_block);

    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId,
        shouldBlock ? "failure" : "success",
        buildCheckOutput(findings, verdict, confidence, githubSummary, validation.scopeDroppedCount)
      );
    }

    // ── 12. Persist final review ──────────────────────────────────────────────
    const criticalFindings = findings.filter(function (f) { return f.severity === "critical"; }).length;
    const durationMs = Date.now() - startTime;
    const totalTokens = tokensUsed + (adversarialMeta ? adversarialMeta.tokensUsed : 0);

    await db.query(
      "UPDATE ai_reviews SET " +
      "  verdict = $1, confidence = $2, findings = $3, summary = $4, " +
      "  files_reviewed = $5, lines_added = $6, lines_removed = $7, " +
      "  tokens_used = $8, github_review_id = $9, completed_at = NOW(), " +
      "  overall_correctness = $10, overall_confidence = $11, " +
      "  overall_explanation = $12, ignored_findings = $13, " +
      "  review_engine = $14, duration_ms = $15 " +
      "WHERE id = $16",
      [
        verdict, confidence, JSON.stringify(findings), summary || githubSummary,
        files.length, totalAdded, totalRemoved,
        totalTokens, reviewId,
        overallCorrectness || null, overallConfidence || null,
        summary || null,
        JSON.stringify(validation.ignoredFindings),
        adversarialMeta ? "claude+adversarial" : "claude",
        durationMs,
        reviewRow.id,
      ]
    );

    // ── 13. Audit trail ───────────────────────────────────────────────────────
    await Trail.aiDecision({
      repoFullName:     repository.full_name,
      prNumber:         pr.number,
      commitSha:        pr.head.sha,
      verdict, confidence,
      findingsCount:    findings.length,
      criticalFindings,
      tokensUsed,
      reviewId:         reviewRow.id,
    });

    if (shouldBlock) {
      await Trail.reviewGateBlock({
        repoFullName: repository.full_name,
        prNumber:     pr.number,
        commitSha:    pr.head.sha,
        verdict,
        reason:       criticalFindings + " critical finding" + (criticalFindings !== 1 ? "s" : ""),
        findings:     findings.filter(function (f) { return f.severity === "critical"; }).map(function (f) { return f.title; }),
      });
    }

    await Events.ciRunCompleted(repoId, {
      prNumber: pr.number,
      success:  !shouldBlock,
      metadata: { type: "ai_review", verdict, findings_count: findings.length },
    });

    logger.info(
      {
        repo: repository.full_name, pr: pr.number, verdict, findings: findings.length,
        blocked: shouldBlock, scopeDropped: validation.scopeDroppedCount,
        durationMs, extractionStrategy: strategy,
      },
      "AI review: complete (bundle-driven v2)"
    );

    return { verdict, confidence, findings, blocked: shouldBlock };

  } catch (err) {
    logger.error({ err: err.message, pr: pr.number }, "AI review: failed");
    const durationMs = Date.now() - startTime;

    if (checkRunId) {
      await finaliseCheckRun(octokit, owner, repo, checkRunId, "neutral", {
        title:   "\u26A0\uFE0F AI review unavailable",
        summary: "Review could not be completed: " + err.message,
        text:    "",
      });
    }

    await db.query(
      "UPDATE ai_reviews SET verdict = 'error', summary = $1, " +
      "completed_at = NOW(), duration_ms = $2 WHERE id = $3",
      [err.message.slice(0, 500), durationMs, reviewRow.id]
    );

    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Fetch and filter PR diff
// ════════════════════════════════════════════════════════════════════════════

async function fetchDiff(octokit, owner, repo, pr, cfg) {
  const { data: prFiles } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
    { owner, repo, pull_number: pr.number, per_page: 100 }
  );

  const ignorePatterns = cfg.ignore_patterns ?? [];

  var filtered = prFiles.filter(function (f) {
    if (f.status === "removed") return false;
    if (ignorePatterns.some(function (pat) { return minimatch(f.filename, pat); })) return false;
    return true;
  });

  // Respect limits
  filtered = filtered.slice(0, cfg.max_files_to_review);

  var totalAdded = 0, totalRemoved = 0, totalLines = 0;
  var files = [];

  for (var i = 0; i < filtered.length; i++) {
    var f = filtered[i];
    var added   = f.additions ?? 0;
    var removed = f.deletions ?? 0;
    totalAdded   += added;
    totalRemoved += removed;
    totalLines   += added + removed;

    if (totalLines > cfg.max_lines_to_review) break;

    files.push({
      filename: f.filename,
      status:   f.status,
      added:    added,
      removed:  removed,
      patch:    f.patch ?? "",
      sha:      f.sha,
    });
  }

  return { files, totalAdded, totalRemoved };
}

// ════════════════════════════════════════════════════════════════════════════
// Structured review via Claude (single-pass with schema enforcement)
// ════════════════════════════════════════════════════════════════════════════

async function runStructuredReview(bundle, changedFiles, opts) {
  var systemPrompt = buildReviewSystemPrompt({
    changedFiles: changedFiles,
    includeSecurity: opts.includeSecurity,
    includeArchitecture: opts.includeArchitecture,
  });

  // Build a rich user prompt with PR metadata for context
  // The bundle already contains structured sections (metadata, diff, files, repo context)
  // but the framing prompt helps the model understand intent
  var prTitle = opts.prTitle || "";
  var prAuthor = opts.prAuthor || "";
  var prBranch = opts.prBranch || "";
  var repoName = opts.repoName || "";
  var fileCount = changedFiles.length;

  var headerLines = [
    "You are reviewing a pull request for " + repoName + ".",
    "",
    "PR: " + prTitle,
    "Author: " + prAuthor,
    "Branch: " + prBranch,
    "Changed files: " + fileCount,
    "",
    "Focus on correctness, security, and regressions.",
    "Prioritize concrete issues visible in the diff.",
    "A clean patch with no findings is a valid and welcome result.",
    "",
    "--- BEGIN REVIEW BUNDLE ---",
    "",
  ];

  var userPrompt = headerLines.join("\n") + bundle;

  try {
    const message = await anthropic.messages.create({
      model:      opts.model || DEFAULT_MODEL,
      max_tokens: 4096,
      system:     systemPrompt,
      messages:   [{ role: "user", content: userPrompt }],
    });

    var text = "";
    if (Array.isArray(message.content)) {
      // Extract text blocks
      text = message.content
        .filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; })
        .join("\n");
    } else if (typeof message.content === "string") {
      text = message.content;
    }

    var tokens = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    return { rawText: text.trim(), tokensUsed: tokens };
  } catch (err) {
    logger.warn({ err: err.message }, "AI review: Claude call failed");
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Verdict computation (unchanged — kept for backward compat)
// ════════════════════════════════════════════════════════════════════════════

export function computeVerdict(findings, cfg) {
  var critical = findings.filter(function (f) { return f.severity === "critical"; }).length;
  var high     = findings.filter(function (f) { return f.severity === "high"; }).length;

  var verdict    = "approved";
  var confidence = "high";

  if (critical > 0) {
    verdict    = "request_changes";
    confidence = "high";
  } else if (high >= 3) {
    verdict    = "request_changes";
    confidence = "medium";
  } else if (high >= 1) {
    verdict    = "needs_discussion";
    confidence = "medium";
  } else if (findings.length >= 5) {
    verdict    = "needs_discussion";
    confidence = "low";
  }

  return { verdict, confidence };
}

// ════════════════════════════════════════════════════════════════════════════
// GitHub PR Review posting
// ════════════════════════════════════════════════════════════════════════════

async function postGitHubReview({ octokit, owner, repo, pr, findings, verdict, confidence, cfg, scopeDroppedCount, adversarialMeta }) {
  var VERDICT_LABEL = {
    approved:          "\u2705 Approved",
    needs_discussion:  "\uD83D\uDCAC Needs discussion",
    request_changes:   "\u274C Changes requested",
  };

  var critical = findings.filter(function (f) { return f.severity === "critical"; });
  var high     = findings.filter(function (f) { return f.severity === "high"; });
  var others   = findings.filter(function (f) { return ["critical", "high"].indexOf(f.severity) === -1; });

  // Separate adversarial-discovered findings
  var adversarialFindings = findings.filter(function (f) { return f.adversarial_status === "missed_risk"; });
  var upheldFindings = findings.filter(function (f) { return f.adversarial_status === "upheld"; });

  var summaryLines = [
    "## \uD83E\uDD16 AI Code Review \u2014 " + VERDICT_LABEL[verdict],
    "",
    "**Confidence:** " + confidence + " \u00B7 **Findings:** " + findings.length,
    critical.length ? "\n**" + critical.length + " critical issue" + (critical.length > 1 ? "s" : "") + " require attention before merging.**" : "",
    scopeDroppedCount > 0 ? "\n*" + scopeDroppedCount + " out-of-scope finding" + (scopeDroppedCount !== 1 ? "s" : "") + " filtered out.*" : "",
    "",
  ];

  if (critical.length || high.length) {
    summaryLines.push("### Key issues");
    for (var i = 0; i < Math.min(5, critical.length + high.length); i++) {
      var f = (critical.concat(high))[i];
      var badge = f.adversarial_status === "upheld" ? " 🔮" : (f.adversarial_status === "missed_risk" ? " 🔍" : "");
      summaryLines.push("- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " (`" + f.file + "`)" : "") + badge);
    }
    summaryLines.push("");
  }

  if (others.length) {
    summaryLines.push("### Other findings (" + others.length + ")");
    for (var j = 0; j < Math.min(5, others.length); j++) {
      summaryLines.push("- **[" + others[j].severity + "]** " + others[j].title);
    }
    summaryLines.push("");
  }

  // Devil's Advocate summary
  if (adversarialMeta) {
    var advParts = [];
    if (adversarialMeta.dropped > 0) advParts.push(adversarialMeta.dropped + " false positive" + (adversarialMeta.dropped !== 1 ? "s" : "") + " dropped");
    if (adversarialMeta.downgraded > 0) advParts.push(adversarialMeta.downgraded + " downgraded");
    if (adversarialMeta.missedRisks > 0) advParts.push(adversarialMeta.missedRisks + " missed risk" + (adversarialMeta.missedRisks !== 1 ? "s" : "") + " found");
    if (upheldFindings.length > 0) advParts.push(upheldFindings.length + " upheld");
    if (advParts.length > 0) {
      var turnLabel = adversarialMeta.turns === 3 ? "3 turns" : "2 turns";
      summaryLines.push("> 🔮 **Devil's Advocate** (" + turnLabel + "): " + advParts.join(" · "));
      summaryLines.push("");
    }
  }

  // Dropped findings section
  if (adversarialMeta && adversarialMeta.dropped > 0) {
    summaryLines.push("<details><summary>❌ " + adversarialMeta.dropped + " finding" + (adversarialMeta.dropped !== 1 ? "s" : "") + " overruled by Devil's Advocate</summary>");
    summaryLines.push("<em>False positives eliminated by adversarial challenge pass.</em>");
    summaryLines.push("</details>");
    summaryLines.push("");
  }

  summaryLines.push(
    "---",
    "_GitWire AI Review Gate (bundle-driven v2) · Structured schema · Scope-validated" +
    (adversarialMeta ? " · Devil's Advocate" : "") + "_"
  );

  var body    = summaryLines.filter(function (l) { return l !== ""; }).join("\n");
  var summary = summaryLines.slice(0, 3).join(" ");

  // Build inline comments for findings that have file + line
  var comments = findings
    .filter(function (f) { return f.file && f.line; })
    .slice(0, 10)
    .map(function (f) {
      return {
        path:     f.file,
        position: f.line,
        body:     "**[" + f.severity.toUpperCase() + "] " + f.title + "**\n\n" + f.description + "\n\n> **Suggestion:** " + f.suggestion,
      };
    });

  var ghVerdict =
    verdict === "request_changes" ? "REQUEST_CHANGES" :
    verdict === "approved"        ? "APPROVE"         : "COMMENT";

  var { data: review } = await octokit.request(
    "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
    {
      owner,
      repo,
      pull_number: pr.number,
      commit_id:   pr.head.sha,
      body,
      event:       ghVerdict,
      comments,
    }
  );

  return { reviewId: review.id, summary };
}

// ════════════════════════════════════════════════════════════════════════════
// Check run helpers
// ════════════════════════════════════════════════════════════════════════════

async function finaliseCheckRun(octokit, owner, repo, checkRunId, conclusion, output) {
  await octokit.request(
    "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
    {
      owner,
      repo,
      check_run_id: checkRunId,
      status:       "completed",
      conclusion,
      completed_at: new Date().toISOString(),
      output,
    }
  ).catch(function (err) {
    logger.warn({ err: err.message, checkRunId: checkRunId }, "Failed to finalise check run");
  });
}

function buildCheckOutput(findings, verdict, confidence, summary, scopeDroppedCount) {
  var ICONS = { approved: "\u2705", needs_discussion: "\uD83D\uDCAC", request_changes: "\u274C" };
  var title = (ICONS[verdict] ?? "\uD83E\uDD16") + " AI Review \u2014 " + verdict.replace(/_/g, " ") + " (" + confidence + " confidence)";

  var details = findings.map(function (f) {
    return "- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " \u2014 `" + f.file + "`" : "") + "\n  " + f.description;
  }).join("\n");

  var scopeNote = scopeDroppedCount > 0
    ? "\n\n*" + scopeDroppedCount + " out-of-scope findings filtered.*"
    : "";

  return {
    title: title,
    summary: (summary || findings.length + " finding" + (findings.length !== 1 ? "s" : "")) + scopeNote,
    text:    details || "No specific findings.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Dynamic defense-pass trigger (turn 3 gating)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Evaluate whether Turn 3 (defense pass) should run based on config mode
 * and the outcomes of Turn 2 (adversarial challenge).
 *
 * Modes:
 *   "always"  — unconditionally run Turn 3
 *   "never"   — never run Turn 3
 *   "auto"    — run only if a trigger condition fires
 *
 * Trigger conditions (all on by default):
 *   dropped_findings     — any finding was disproven (suggested_action=drop)
 *   critical_downgraded  — a critical or high finding was challenged with downgrade
 *   new_criticals        — advocate discovered new critical or high risks
 *
 * @param {string} mode
 * @param {string[]} triggers
 * @param {Array} findings - Original findings
 * @param {Array} challenges - Challenge results from Turn 2
 * @param {Array} missedRisks - Missed risks from Turn 2
 * @returns {{ run: boolean, reason: string }}
 */
export function shouldRunDefense(mode, triggers, findings, challenges, missedRisks) {
  if (mode === "always") {
    return { run: true, reason: "mode=always" };
  }
  if (mode === "never") {
    return { run: false, reason: "mode=never" };
  }

  // mode === "auto"
  var enabledTriggers = Array.isArray(triggers) && triggers.length > 0
    ? triggers
    : ["dropped_findings", "critical_downgraded", "new_criticals"];

  // Check: dropped findings
  if (enabledTriggers.indexOf("dropped_findings") !== -1) {
    var dropped = (challenges || []).some(function (c) { return c.suggested_action === "drop"; });
    if (dropped) {
      return { run: true, reason: "dropped_findings" };
    }
  }

  // Check: critical/high findings downgraded
  if (enabledTriggers.indexOf("critical_downgraded") !== -1) {
    var downgraded = (challenges || []).some(function (c) {
      if (c.suggested_action !== "downgrade") return false;
      var original = findings[c.finding_index];
      return original && (original.severity === "critical" || original.severity === "high");
    });
    if (downgraded) {
      return { run: true, reason: "critical_downgraded" };
    }
  }

  // Check: new criticals from advocate
  if (enabledTriggers.indexOf("new_criticals") !== -1) {
    var newCrits = (missedRisks || []).some(function (r) {
      return r.severity === "critical" || r.severity === "high";
    });
    if (newCrits) {
      return { run: true, reason: "new_criticals" };
    }
  }

  return { run: false, reason: "no_triggers_matched" };
}

// ════════════════════════════════════════════════════════════════════════════
// Config loader
// ════════════════════════════════════════════════════════════════════════════

async function loadReviewConfig(repoId) {
  var { rows } = await db.query(
    "SELECT * FROM ai_review_config WHERE repo_id = $1", [repoId]
  );
  return rows[0] ?? null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
export function confidenceLevel(c) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}
