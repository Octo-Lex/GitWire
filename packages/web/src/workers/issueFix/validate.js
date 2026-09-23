// src/workers/issueFix/validate.js
// Stage 5: deterministic patch-shape validation, risk/confidence/scope guards,
// then managed-action proposal. No generated content reaches score/policy logic
// until its repository-relative file identity and full-file payload are valid.

import { isFixPathBlocked, isDryRun, meetsConfidence, getMinFixConfidence, scoreFixRisk } from "@gitwire/rules";
import { propose, approve, execute, cancel } from "../../services/actionStateMachine.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment } from "./helpers.js";

function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || !value.length) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Deterministically validate an AI-generated full-file candidate batch against
 * the exact files fetched from the reviewed commit.
 *
 * Any reason is fatal. Earlier behavior collected invalid-JSON/unclosed-string/
 * missing-original reasons but only treated a subset of reasons as blocking,
 * allowing malformed candidates to proceed when another file looked valid.
 */
export function validatePatchCandidates(fixes, originalFiles) {
  const reasons = [];
  const seenPaths = new Set();
  const originals = new Map(
    Array.isArray(originalFiles)
      ? originalFiles
          .filter((file) => file && typeof file.path === "string")
          .map((file) => [file.path, file])
      : [],
  );

  if (!Array.isArray(fixes) || fixes.length === 0) {
    return { valid: false, reasons: ["No generated fixes to validate"] };
  }

  for (let index = 0; index < fixes.length; index++) {
    const fix = fixes[index];
    if (!fix || typeof fix !== "object" || Array.isArray(fix)) {
      reasons.push(`Fix ${index + 1}: candidate must be an object`);
      continue;
    }

    if (!isSafeRepositoryPath(fix.path)) {
      reasons.push(`Fix ${index + 1}: invalid repository-relative path`);
      continue;
    }

    if (seenPaths.has(fix.path)) {
      reasons.push(`${fix.path}: duplicate generated path`);
      continue;
    }
    seenPaths.add(fix.path);

    if (typeof fix.fixed_content !== "string") {
      reasons.push(`${fix.path}: fixed_content must be a string`);
      continue;
    }
    if (fix.fixed_content.trim().length === 0) {
      reasons.push(`${fix.path}: fixed file is empty`);
      continue;
    }

    const orig = originals.get(fix.path);
    if (!orig || typeof orig.content !== "string" || typeof orig.sha !== "string" || !orig.sha) {
      reasons.push(`No exact-head original content for ${fix.path}`);
      continue;
    }

    if (fix.fixed_content === orig.content) {
      reasons.push(`${fix.path}: AI returned identical content — no fix applied`);
      continue;
    }

    const origLines = orig.content.split("\n").length;
    const fixLines = fix.fixed_content.split("\n").length;
    const delta = Math.abs(fixLines - origLines);
    const ratio = origLines > 0 ? delta / origLines : 0;

    if (ratio > 0.6 && origLines > 10) {
      reasons.push(`${fix.path}: too many lines changed (${delta}/${origLines} = ${Math.round(ratio * 100)}%) — possible destructive replacement`);
    }
    if (fixLines < origLines * 0.7 && origLines > 5) {
      reasons.push(`${fix.path}: file shrank significantly (${origLines} → ${fixLines} lines) — likely missing content`);
    }

    const ext = fix.path.split(".").pop()?.toLowerCase();
    if (ext === "py") {
      let inTriple = false;
      for (const line of fix.fixed_content.split("\n")) {
        const tripleCount = (line.match(/"""/g) || []).length + (line.match(/'''/g) || []).length;
        if (tripleCount % 2 === 1) inTriple = !inTriple;
      }
      if (inTriple) reasons.push(`${fix.path}: unclosed triple-quote string detected`);
    }
    if (ext === "json") {
      try {
        JSON.parse(fix.fixed_content);
      } catch {
        reasons.push(`${fix.path}: invalid JSON after fix`);
      }
    }
  }

  return { valid: reasons.length === 0, reasons };
}

/** Returns validated fixes, or null if pipeline should stop. */
export async function validateFixes(ctx, analysis, generated) {
  const { octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo, principalId } = ctx;
  const fixes = Array.isArray(generated?.fixes) ? generated.fixes : [];
  const fileContents = Array.isArray(generated?.fileContents) ? generated.fileContents : [];
  const fixOpts = repoConfig.pillars?.issue_fix || {};
  const maxFileChanges = fixOpts.max_file_changes || 3;
  const minConfidence = getMinFixConfidence(repoConfig);

  const validationResult = validatePatchCandidates(fixes, fileContents);
  if (!validationResult.valid) {
    logger.warn({ repo, issueNumber, reasons: validationResult.reasons }, "Patch validation failed");
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "Patch validation failed: " + validationResult.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - validation failed**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "Generated fixes did not pass deterministic validation:\n" +
      validationResult.reasons.map((r) => "- " + r).join("\n") + "\n\n" +
      "_A maintainer should review manually._"
    );
    return null;
  }

  const preConfidence = analysis.complexity === "trivial" ? "high" : analysis.complexity === "simple" ? "medium" : "low";
  if (!meetsConfidence(preConfidence, minConfidence)) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Complexity " + analysis.complexity + " below confidence threshold " + minConfidence);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - confidence gate**\n\n" +
      "Issue complexity: **" + analysis.complexity + "** (confidence: " + preConfidence + ")\n" +
      "Minimum required: **" + minConfidence + "**\n\n" +
      "_Adjust `issue_fix.min_confidence_to_submit` in `.gitwire.yml` if needed._"
    );
    return null;
  }

  const risk = scoreFixRisk(analysis, fixes, fileContents);
  logger.info({ repo, issueNumber, riskScore: risk.score, riskLevel: risk.level, reasons: risk.reasons }, "Fix risk assessment");

  if (risk.level === "high") {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "High risk: " + risk.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - high risk**\n\n" +
      "Risk score: **" + risk.score + "/100**\n" +
      risk.reasons.map((r) => "- " + r).join("\n") + "\n\n" +
      "_This fix is too risky for autonomous submission._"
    );
    return null;
  }

  if (fixes.length > maxFileChanges) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Too many files changed: " + fixes.length + " > " + maxFileChanges);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - scope guard**\n\n" +
      "Fix touches " + fixes.length + " files (max: " + maxFileChanges + ").\n\n" +
      "_Reduce scope or adjust `issue_fix.max_file_changes` in settings._"
    );
    return null;
  }

  const blockedFixes = fixes.filter((fix) => isFixPathBlocked(fix.path, repoConfig));
  if (blockedFixes.length > 0) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "Blocked paths: " + blockedFixes.map((fix) => fix.path).join(", "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - blocked paths**\n\n" +
      "These files are protected by policy: `" + blockedFixes.map((fix) => fix.path).join("`, `") + "`\n\n" +
      "_Adjust `issue_fix.blocked_paths` in `.gitwire.yml` if needed._"
    );
    return null;
  }

  const fixAction = await propose({
    repoFullName: repo,
    pillar: "issue_fix",
    actionType: "create-fix-pr",
    source: "ai_fix",
    evidence: {
      issue_number: issueNumber,
      fixes: fixes.length,
      complexity: analysis.complexity,
      confidence: preConfidence,
      base_sha: ctx._scope?.baseSha,
      principalId,
      surfaceId: "worker:issueFix",
    },
    repoId,
    targetType: "issue",
    targetNumber: issueNumber,
    actionKey: "issue-fix:" + issueNumber,
  });

  if (isDryRun(repoConfig)) {
    await cancel(fixAction.id, "Dry-run mode");
    logger.info({ repo, issueNumber, fixes: fixes.length, complexity: analysis.complexity }, "DRY RUN: would create fix PR");
    await upsertFixAttempt(repoId, issueNumber, branchName, "dry_run",
      analysis.complexity, analysis.explanation, null, null);
    return null;
  }

  await approve(fixAction.id, {
    confidence: preConfidence,
    min_confidence: minConfidence,
    scope_ok: true,
    base_sha: ctx._scope?.baseSha,
  });
  await execute(fixAction.id);

  return { fixes, fileContents, preConfidence, fixAction };
}
