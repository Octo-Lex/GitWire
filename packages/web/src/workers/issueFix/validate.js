// src/workers/issueFix/validate.js
// Stage 5: Risk scoring + confidence check + scope guards + patch validation.

import { isFixPathBlocked, isDryRun, meetsConfidence, getMinFixConfidence, scoreFixRisk } from "@gitwire/rules";
import { propose, approve, execute, cancel } from "../../services/actionStateMachine.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment } from "./helpers.js";

/**
 * Returns validated fixes, or null if pipeline should stop.
 * CC target: ~8
 */
export async function validateFixes(ctx, analysis, generated) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo } = ctx;
  const { fixes, fileContents } = generated;
  const fixOpts = repoConfig.pillars?.issue_fix || {};
  const maxFileChanges = fixOpts.max_file_changes || 3;
  const minConfidence = getMinFixConfidence(repoConfig);

  // ── Confidence pre-check ────────────────────────────────────────────────
  var preConfidence = analysis.complexity === "trivial" ? "high" : analysis.complexity === "simple" ? "medium" : "low";
  if (!meetsConfidence(preConfidence, minConfidence)) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Complexity " + analysis.complexity + " below confidence threshold " + minConfidence);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - confidence gate**\n\n" +
      "Issue complexity: **" + analysis.complexity + "** (confidence: " + preConfidence + ")\n" +
      "Minimum required: **" + minConfidence + "**\n\n" +
      "_Adjust `issue_fix.min_confidence_to_submit` in `.gitwire.yml` if needed._"
    );
    return null;
  }

  // ── Risk scoring ────────────────────────────────────────────────────────
  var risk = scoreFixRisk(analysis, fixes, fileContents);
  logger.info({ repo, issueNumber, riskScore: risk.score, riskLevel: risk.level, reasons: risk.reasons }, "Fix risk assessment");

  if (risk.level === "high") {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "High risk: " + risk.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - high risk**\n\n" +
      "Risk score: **" + risk.score + "/100**\n" +
      risk.reasons.map(function(r) { return "- " + r; }).join("\n") + "\n\n" +
      "_This fix is too risky for autonomous submission._"
    );
    return null;
  }

  // ── Scope: max file changes ────────────────────────────────────────────
  if (fixes.length > maxFileChanges) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Too many files changed: " + fixes.length + " > " + maxFileChanges);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - scope guard**\n\n" +
      "Fix touches " + fixes.length + " files (max: " + maxFileChanges + ").\n\n" +
      "_Reduce scope or adjust `issue_fix.max_file_changes` in `.gitwire.yml`._"
    );
    return null;
  }

  // ── Scope: blocked paths ────────────────────────────────────────────────
  const blockedFixes = fixes.filter((f) => isFixPathBlocked(f.path, repoConfig));
  if (blockedFixes.length > 0) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Blocked paths: " + blockedFixes.map((f) => f.path).join(", "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u{1F6AB} **GitWire Fix - blocked paths**\n\n" +
      "These files are protected by policy: `" + blockedFixes.map((f) => f.path).join("`, `") + "`\n\n" +
      "_Adjust `issue_fix.blocked_paths` in `.gitwire.yml` if needed._"
    );
    return null;
  }

  // ── Patch validation ────────────────────────────────────────────────────
  const validationResult = validatePatches(fixes, fileContents);
  if (!validationResult.valid) {
    logger.warn({ repo, issueNumber, reasons: validationResult.reasons }, "Patch validation failed");
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "Patch validation failed: " + validationResult.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "\u26A0\uFE0F **GitWire Fix - validation failed**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "Generated fixes did not pass validation:\n" +
      validationResult.reasons.map((r) => "- " + r).join("\n") + "\n\n" +
      "_A maintainer should review manually._"
    );
    return null;
  }

  // ── Action state machine: propose + approve ─────────────────────────────
  const fixAction = await propose({
    repoFullName: repo,
    pillar: "issue_fix",
    actionType: "create-fix-pr",
    source: "ai_fix",
    evidence: { issue_number: issueNumber, fixes: fixes.length, complexity: analysis.complexity, confidence: preConfidence },
    repoId: repoId,
    targetType: "pr",
  });

  // Dry-run check
  if (isDryRun(repoConfig)) {
    await cancel(fixAction.id, "Dry-run mode");
    logger.info({ repo, issueNumber, fixes: fixes.length, complexity: analysis.complexity }, "DRY RUN: would create fix PR");
    await upsertFixAttempt(repoId, issueNumber, branchName, "submitted",
      analysis.complexity, analysis.explanation, null, null);
    return null;
  }

  await approve(fixAction.id, { confidence: preConfidence, min_confidence: getMinFixConfidence(repoConfig), scope_ok: true });
  await execute(fixAction.id);

  return { fixes, fileContents, preConfidence, fixAction };
}

// ── Patch validation logic ─────────────────────────────────────────────────

function validatePatches(fixes, originalFiles) {
  const reasons = [];

  for (const fix of fixes) {
    const orig = originalFiles.find((f) => f.path === fix.path);
    if (!orig) {
      reasons.push("No original content for " + fix.path);
      continue;
    }

    if (fix.fixed_content === orig.content) {
      reasons.push(fix.path + ": AI returned identical content \u2014 no fix applied");
      continue;
    }

    const origLines = orig.content.split("\n").length;
    const fixLines = fix.fixed_content.split("\n").length;
    const delta = Math.abs(fixLines - origLines);
    const ratio = origLines > 0 ? delta / origLines : 0;

    if (ratio > 0.6 && origLines > 10) {
      reasons.push(fix.path + ": too many lines changed (" + delta + "/" + origLines + " = " + Math.round(ratio * 100) + "%) \u2014 possible destructive replacement");
    }

    if (fixLines < origLines * 0.7 && origLines > 5) {
      reasons.push(fix.path + ": file shrank significantly (" + origLines + " \u2192 " + fixLines + " lines) \u2014 likely missing content");
    }

    if (fix.fixed_content.trim().length === 0) {
      reasons.push(fix.path + ": fixed file is empty");
    }

    const ext = fix.path.split(".").pop();
    if (ext === "py") {
      const lines = fix.fixed_content.split("\n");
      let inTriple = false;
      for (const line of lines) {
        const tripleCount = (line.match(/"""/g) || []).length + (line.match(/'''/g) || []).length;
        if (tripleCount % 2 === 1) inTriple = !inTriple;
      }
      if (inTriple) {
        reasons.push(fix.path + ": unclosed triple-quote string detected");
      }
    }
    if (ext === "json") {
      try { JSON.parse(fix.fixed_content); } catch (_) {
        reasons.push(fix.path + ": invalid JSON after fix");
      }
    }
  }

  const validFixes = fixes.filter((fix) => {
    const orig = originalFiles.find((f) => f.path === fix.path);
    if (!orig) return false;
    if (fix.fixed_content === orig.content) return false;
    if (fix.fixed_content.trim().length === 0) return false;
    return true;
  });

  if (validFixes.length === 0) {
    reasons.push("No valid fixes remaining after validation");
  }

  return {
    valid: validFixes.length > 0 && reasons.filter((r) => r.includes("destructive") || r.includes("shrank") || r.includes("empty") || r.includes("No valid")).length === 0,
    reasons,
  };
}
