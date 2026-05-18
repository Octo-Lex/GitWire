// src/services/aiReviewService.js
// Pre-merge AI review gate for Phase 4.
//
// Triggered on: pull_request.opened, pull_request.synchronize
//
// Flow:
//   1. Check repo has AI review enabled
//   2. Create a "pending" GitHub Check Run (visible in the PR status bar)
//   3. Fetch the PR diff, file tree, and repo context
//   4. Split the diff into reviewable chunks (respecting max_files / max_lines)
//   5. Run a multi-pass Claude review:
//        Pass A: logic correctness, test coverage, edge cases
//        Pass B: security vulnerabilities, secret exposure, injection risks
//        Pass C: architecture alignment, cost leaks, API misuse
//   6. Synthesise all findings into a verdict (approved / needs_discussion / request_changes)
//   7. Post a structured GitHub PR Review with finding annotations
//   8. Update the Check Run to pass/fail
//   9. Write to audit trail (Trail.aiDecision)
//  10. Persist to ai_reviews table

import Anthropic from "@anthropic-ai/sdk";
import { db }     from "../lib/db.js";
import { Trail }  from "./auditTrailService.js";
import { Events } from "./pipelineEvents.js";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { minimatch } from "minimatch";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
});

const CHECK_RUN_NAME = "GitWire AI Review";

// ════════════════════════════════════════════════════════════════════════════
// Entry point
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {object} opts
 * @param {object} opts.pr          - GitHub pull_request payload
 * @param {object} opts.repository  - GitHub repository payload
 * @param {object} opts.octokit
 */
export async function reviewPR({ pr, repository, octokit }) {
  const owner  = repository.owner.login;
  const repo   = repository.name;
  const repoId = repository.id;

  // ── 1. Load config ─────────────────────────────────────────────────────────
  const cfg = await loadReviewConfig(repoId);
  if (!cfg?.enabled) return null;

  logger.info({ repo: repository.full_name, pr: pr.number }, "AI review: starting");

  // ── 2. Create pending check run ────────────────────────────────────────────
  const { data: checkRun } = await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name:       CHECK_RUN_NAME,
    head_sha:   pr.head.sha,
    status:     "in_progress",
    started_at: new Date().toISOString(),
    output: {
      title:   "AI review in progress\u2026",
      summary: "Analysing code quality, security, and architecture.",
    },
  });

  // ── 3. Persist review record ────────────────────────────────────────────────
  const { rows: [reviewRow] } = await db.query(
    "INSERT INTO ai_reviews (repo_id, pr_number, commit_sha, check_run_id, config_snapshot) " +
    "VALUES ($1,$2,$3,$4,$5) " +
    "ON CONFLICT (repo_id, pr_number, commit_sha) DO UPDATE SET " +
    "  check_run_id = EXCLUDED.check_run_id, started_at = NOW() " +
    "RETURNING id",
    [repoId, pr.number, pr.head.sha, checkRun.id, JSON.stringify(cfg)]
  );

  try {
    // ── 4. Fetch diff ─────────────────────────────────────────────────────────
    const { files, totalAdded, totalRemoved } = await fetchDiff(octokit, owner, repo, pr, cfg);

    if (!files.length) {
      await finaliseCheckRun(octokit, owner, repo, checkRun.id, "success", {
        title:   "\u2705 No reviewable files changed",
        summary: "All changed files are excluded by the ignore patterns.",
        text:    "",
      });
      return null;
    }

    // ── 5. Multi-pass Claude review ────────────────────────────────────────────
    const { findings, tokensUsed } = await runMultiPassReview({
      files, pr, repository, cfg,
    });

    // ── 6. Compute verdict ─────────────────────────────────────────────────────
    const { verdict, confidence } = computeVerdict(findings, cfg);

    // ── 7. Post GitHub PR Review ──────────────────────────────────────────────
    const { reviewId, summary } = await postGitHubReview({
      octokit, owner, repo, pr, findings, verdict, confidence, cfg,
    });

    // ── 8. Update check run ────────────────────────────────────────────────────
    const shouldBlock = cfg.block_on_verdict.includes(verdict) &&
      confidenceLevel(confidence) >= confidenceLevel(cfg.min_confidence_to_block);

    await finaliseCheckRun(octokit, owner, repo, checkRun.id,
      shouldBlock ? "failure" : "success",
      buildCheckOutput(findings, verdict, confidence, summary)
    );

    // ── 9. Persist final review ────────────────────────────────────────────────
    const criticalFindings = findings.filter(f => f.severity === "critical").length;

    await db.query(
      "UPDATE ai_reviews SET " +
      "  verdict = $1, confidence = $2, findings = $3, summary = $4, " +
      "  files_reviewed = $5, lines_added = $6, lines_removed = $7, " +
      "  tokens_used = $8, github_review_id = $9, completed_at = NOW() " +
      "WHERE id = $10",
      [
        verdict, confidence, JSON.stringify(findings), summary,
        files.length, totalAdded, totalRemoved,
        tokensUsed, reviewId, reviewRow.id,
      ]
    );

    // ── 10. Audit trail ────────────────────────────────────────────────────────
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
        findings:     findings.filter(f => f.severity === "critical").map(f => f.title),
      });
    }

    await Events.ciRunCompleted(repoId, {
      prNumber: pr.number,
      success:  !shouldBlock,
      metadata: { type: "ai_review", verdict, findings_count: findings.length },
    });

    logger.info(
      { repo: repository.full_name, pr: pr.number, verdict, findings: findings.length, blocked: shouldBlock },
      "AI review: complete"
    );

    return { verdict, confidence, findings, blocked: shouldBlock };

  } catch (err) {
    logger.error({ err: err.message, pr: pr.number }, "AI review: failed");

    await finaliseCheckRun(octokit, owner, repo, checkRun.id, "neutral", {
      title:   "\u26A0\uFE0F AI review unavailable",
      summary: "Review could not be completed: " + err.message,
      text:    "",
    });

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

  let filtered = prFiles.filter(f => {
    if (f.status === "removed") return false;
    if (ignorePatterns.some(pat => minimatch(f.filename, pat))) return false;
    return true;
  });

  // Respect limits
  filtered = filtered.slice(0, cfg.max_files_to_review);

  let totalAdded = 0, totalRemoved = 0, totalLines = 0;
  const files = [];

  for (const f of filtered) {
    const added   = f.additions ?? 0;
    const removed = f.deletions ?? 0;
    totalAdded   += added;
    totalRemoved += removed;
    totalLines   += added + removed;

    if (totalLines > cfg.max_lines_to_review) break;

    files.push({
      filename: f.filename,
      status:   f.status,
      added, removed,
      patch:    f.patch ?? "",
      sha:      f.sha,
    });
  }

  return { files, totalAdded, totalRemoved };
}

// ════════════════════════════════════════════════════════════════════════════
// Multi-pass Claude review
// ════════════════════════════════════════════════════════════════════════════

async function runMultiPassReview({ files, pr, repository, cfg }) {
  var BT = String.fromCharCode(96);
  var diffText = files.map(function(f) {
    return "### " + f.filename + " (+" + f.added + " -" + f.removed + ")\n" +
      BT + "diff\n" + f.patch.slice(0, 3000) + "\n" + BT;
  }).join("\n\n");

  const contextBlock = cfg.architecture_context
    ? "\n\nArchitecture context:\n" + cfg.architecture_context
    : "";

  const passes = [];
  if (cfg.check_logic)        passes.push("logic");
  if (cfg.check_security)     passes.push("security");
  if (cfg.check_architecture || cfg.check_cost_leaks) passes.push("architecture");

  const allFindings = [];
  let totalTokens = 0;

  for (const pass of passes) {
    const { findings, tokens } = await runSinglePass(pass, {
      diffText, pr, repository, contextBlock,
    });
    allFindings.push(...findings);
    totalTokens += tokens;
  }

  // De-duplicate findings by title+file
  const seen = new Set();
  const unique = allFindings.filter(f => {
    const key = f.file + ":" + f.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { findings: unique, tokensUsed: totalTokens };
}

async function runSinglePass(passType, { diffText, pr, repository, contextBlock }) {
  var PASS_PROMPTS = {
    logic: "You are a senior engineer performing a **logic review** of a pull request.\n" +
      "Focus on: correctness, edge cases, null/undefined handling, off-by-one errors,\n" +
      "race conditions, infinite loops, missing error handling, incorrect algorithms.\n" +
      "Do NOT comment on style, formatting, or architectural concerns.",

    security: "You are a security engineer performing a **security review** of a pull request.\n" +
      "Focus on: injection vulnerabilities (SQL, XSS, command), hardcoded secrets,\n" +
      "insecure dependencies, authentication/authorization bypasses, path traversal,\n" +
      "unsafe deserialization, SSRF, exposed PII, improper error messages leaking internals.\n" +
      "Do NOT comment on logic correctness or architecture.",

    architecture: "You are a principal engineer performing an **architecture and cost review**.\n" +
      "Focus on: design pattern violations, unnecessary complexity, missing abstractions,\n" +
      "N+1 queries, missing caching, unbounded loops calling external APIs,\n" +
      "missing pagination, synchronous operations that should be async, cost leaks\n" +
      "(e.g. calling a paid API in a hot loop), missing rate limiting.\n" +
      "Do NOT comment on logic or security.",
  };

  var prompt = PASS_PROMPTS[passType] + contextBlock +
    "\n\nRepository: " + repository.full_name +
    "\nPR: #" + pr.number + " \u2014 " + pr.title +
    "\nAuthor: @" + pr.user.login +
    "\n\nChanges:\n" + diffText +
    '\n\nReturn ONLY a JSON array of findings (empty array if none). Each finding:\n' +
    '{\n' +
    '  "category": "' + passType + '",\n' +
    '  "severity": "critical" | "high" | "medium" | "low" | "info",\n' +
    '  "title": "<concise 8-word max title>",\n' +
    '  "description": "<2-3 sentence explanation of the problem>",\n' +
    '  "suggestion": "<concrete, actionable fix \u2014 1-2 sentences>",\n' +
    '  "file": "<filename or null>",\n' +
    '  "line": <line number in the diff or null>\n' +
    '}\n' +
    "\nRules:\n" +
    "- Only report real issues. Do not invent findings.\n" +
    '- Severity "critical": security vulnerabilities, data loss risks, crashes.\n' +
    '- Severity "high": significant bugs, major performance issues.\n' +
    '- Severity "medium": correctness issues unlikely to cause immediate breakage.\n' +
    '- Severity "low" / "info": suggestions and improvements.\n' +
    "- Maximum 8 findings per pass. Prioritise highest severity.";

  try {
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system:     "You are a code review expert. Return ONLY a valid JSON array. No explanation, no markdown fences.",
      messages:   [{ role: "user", content: prompt }],
    });

    const text     = message.content[0].text.trim();
    const clean    = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const findings = JSON.parse(clean);
    const tokens   = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    return { findings: Array.isArray(findings) ? findings : [], tokens };
  } catch (err) {
    logger.warn({ pass: passType, err: err.message }, "AI review: pass failed");
    return { findings: [], tokens: 0 };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Verdict computation
// ════════════════════════════════════════════════════════════════════════════

function computeVerdict(findings, cfg) {
  const critical = findings.filter(f => f.severity === "critical").length;
  const high     = findings.filter(f => f.severity === "high").length;

  let verdict    = "approved";
  let confidence = "high";

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

async function postGitHubReview({ octokit, owner, repo, pr, findings, verdict, confidence, cfg }) {
  var VERDICT_LABEL = {
    approved:          "\u2705 Approved",
    needs_discussion:  "\uD83D\uDCAC Needs discussion",
    request_changes:   "\u274C Changes requested",
  };

  const critical = findings.filter(f => f.severity === "critical");
  const high     = findings.filter(f => f.severity === "high");
  const others   = findings.filter(f => !["critical","high"].includes(f.severity));

  const summaryLines = [
    "## \uD83E\uDD16 AI Code Review \u2014 " + VERDICT_LABEL[verdict],
    "",
    "**Confidence:** " + confidence + " \u00B7 **Findings:** " + findings.length,
    critical.length ? "\n**" + critical.length + " critical issue" + (critical.length > 1 ? "s" : "") + " require attention before merging.**" : "",
    "",
  ];

  if (critical.length || high.length) {
    summaryLines.push("### Key issues");
    for (const f of [...critical, ...high].slice(0, 5)) {
      summaryLines.push("- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " (`" + f.file + "`)" : ""));
    }
    summaryLines.push("");
  }

  if (others.length) {
    summaryLines.push("### Other findings (" + others.length + ")");
    for (const f of others.slice(0, 5)) {
      summaryLines.push("- **[" + f.severity + "]** " + f.title);
    }
    summaryLines.push("");
  }

  var categories = [cfg.check_logic && "logic", cfg.check_security && "security", cfg.check_architecture && "architecture"].filter(Boolean).join(", ");
  summaryLines.push(
    "---",
    "_GitWire AI Review Gate \u00B7 Categories reviewed: " + categories + "_"
  );

  const body    = summaryLines.filter(l => l !== "").join("\n");
  const summary = summaryLines.slice(0, 3).join(" ");

  // Build inline comments for findings that have file + line
  const comments = findings
    .filter(f => f.file && f.line)
    .slice(0, 10)
    .map(f => ({
      path:     f.file,
      position: f.line,
      body:     "**[" + f.severity.toUpperCase() + "] " + f.title + "**\n\n" + f.description + "\n\n> **Suggestion:** " + f.suggestion,
    }));

  const ghVerdict =
    verdict === "request_changes" ? "REQUEST_CHANGES" :
    verdict === "approved"        ? "APPROVE"         : "COMMENT";

  const { data: review } = await octokit.request(
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
  ).catch(err => {
    logger.warn({ err: err.message, checkRunId }, "Failed to finalise check run");
  });
}

function buildCheckOutput(findings, verdict, confidence, summary) {
  const ICONS = { approved: "\u2705", needs_discussion: "\uD83D\uDCAC", request_changes: "\u274C" };
  const title = (ICONS[verdict] ?? "\uD83E\uDD16") + " AI Review \u2014 " + verdict.replace(/_/g, " ") + " (" + confidence + " confidence)";

  const details = findings.map(f =>
    "- **[" + f.severity.toUpperCase() + "]** " + f.title + (f.file ? " \u2014 `" + f.file + "`" : "") + "\n  " + f.description
  ).join("\n");

  return {
    title,
    summary: summary ?? findings.length + " finding" + (findings.length !== 1 ? "s" : "") + " across logic,security,architecture passes.",
    text:    details || "No specific findings.",
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Config loader
// ════════════════════════════════════════════════════════════════════════════

async function loadReviewConfig(repoId) {
  const { rows: [cfg] } = await db.query(
    "SELECT * FROM ai_review_config WHERE repo_id = $1", [repoId]
  );
  return cfg ?? null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function confidenceLevel(c) {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}
