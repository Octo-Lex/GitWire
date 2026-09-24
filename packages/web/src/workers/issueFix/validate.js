// src/workers/issueFix/validate.js
// Stage 5: deterministic candidate validation + policy/risk guards, then the
// managed-action proposal. Generated content is treated as untrusted input.

import { isFixPathBlocked, isDryRun, meetsConfidence, getMinFixConfidence, scoreFixRisk } from "@gitwire/rules";
import { propose, approve, execute, cancel } from "../../services/actionStateMachine.js";
import { logger } from "../../lib/logger.js";
import { upsertFixAttempt, postIssueComment } from "./helpers.js";

const MAX_GENERATED_COMMIT_MESSAGE_LENGTH = 120;
const MAX_GENERATED_EXPLANATION_LENGTH = 500;
const GENERATED_METADATA_CONTROL_RE = /[\u0000-\u001f\u007f\u2028\u2029]/;

function isSafeRepositoryPath(value) {
  if (typeof value !== "string" || !value.length) return false;
  if (value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function normalizePositiveInteger(value, fallback, hardMax) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, hardMax);
}

function validateGeneratedMetadata(path, fix, reasons) {
  if (fix.commit_message != null) {
    if (typeof fix.commit_message !== "string") {
      reasons.push(`${path}: commit_message must be a string`);
    } else {
      const trimmed = fix.commit_message.trim();
      if (!trimmed) reasons.push(`${path}: commit_message must not be empty`);
      if (fix.commit_message.length > MAX_GENERATED_COMMIT_MESSAGE_LENGTH) {
        reasons.push(`${path}: commit_message exceeds ${MAX_GENERATED_COMMIT_MESSAGE_LENGTH} characters`);
      }
      if (trimmed !== fix.commit_message) {
        reasons.push(`${path}: commit_message must not contain leading or trailing whitespace`);
      }
      if (GENERATED_METADATA_CONTROL_RE.test(fix.commit_message)) {
        reasons.push(`${path}: commit_message must be a single-line string without control characters`);
      }
    }
  }

  if (fix.explanation != null) {
    if (typeof fix.explanation !== "string") {
      reasons.push(`${path}: explanation must be a string`);
    } else {
      const trimmed = fix.explanation.trim();
      if (!trimmed) reasons.push(`${path}: explanation must not be empty`);
      if (fix.explanation.length > MAX_GENERATED_EXPLANATION_LENGTH) {
        reasons.push(`${path}: explanation exceeds ${MAX_GENERATED_EXPLANATION_LENGTH} characters`);
      }
      if (trimmed !== fix.explanation) {
        reasons.push(`${path}: explanation must not contain leading or trailing whitespace`);
      }
      if (GENERATED_METADATA_CONTROL_RE.test(fix.explanation)) {
        reasons.push(`${path}: explanation must be a single-line string without control characters`);
      }
    }
  }
}

// Historical dashboard versions wrote confidence as 1/2/3 even though the
// rules schema uses low/medium/high. Normalize both representations so a numeric
// override cannot accidentally reduce the required confidence to zero.
export function normalizeFixConfidence(value) {
  if (value === "low" || value === "medium" || value === "high") return value;
  if (value === 1 || value === "1") return "low";
  if (value === 2 || value === "2") return "medium";
  if (value === 3 || value === "3") return "high";
  return "medium";
}

function lines(text) {
  return text === "" ? [] : text.split("\n");
}

/**
 * Exact line insert/delete edit distance (Myers), bounded by limit + 1.
 * Substituting one line counts as one deletion + one insertion, matching normal
 * diff additions/deletions. The bounded search prevents large generated files
 * from turning a configured safety limit into an unbounded CPU cost.
 */
export function countLineEdits(originalText, fixedText, limit) {
  const originalLines = lines(originalText);
  const fixedLines = lines(fixedText);

  let start = 0;
  while (
    start < originalLines.length &&
    start < fixedLines.length &&
    originalLines[start] === fixedLines[start]
  ) {
    start++;
  }

  let originalEnd = originalLines.length - 1;
  let fixedEnd = fixedLines.length - 1;
  while (
    originalEnd >= start &&
    fixedEnd >= start &&
    originalLines[originalEnd] === fixedLines[fixedEnd]
  ) {
    originalEnd--;
    fixedEnd--;
  }

  const original = originalLines.slice(start, originalEnd + 1);
  const fixed = fixedLines.slice(start, fixedEnd + 1);
  const n = original.length;
  const m = fixed.length;
  if (n === 0) return m;
  if (m === 0) return n;

  const maxDistance = n + m;
  const searchLimit = Math.min(maxDistance, Math.max(0, limit) + 1);
  let previous = new Map([[1, 0]]);

  for (let distance = 0; distance <= searchLimit; distance++) {
    const next = new Map();
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = previous.get(diagonal + 1);
      const right = previous.get(diagonal - 1);
      let x;

      if (
        diagonal === -distance ||
        (diagonal !== distance && (right ?? Number.NEGATIVE_INFINITY) < (down ?? Number.NEGATIVE_INFINITY))
      ) {
        x = down ?? 0;
      } else {
        x = (right ?? 0) + 1;
      }

      let y = x - diagonal;
      while (x < n && y < m && original[x] === fixed[y]) {
        x++;
        y++;
      }
      if (x >= n && y >= m) return distance;
      next.set(diagonal, x);
    }
    previous = next;
  }

  return searchLimit + 1;
}

/** Validate an AI-generated batch against exact-head originals. Any reason is fatal. */
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

    validateGeneratedMetadata(fix.path, fix, reasons);

    const orig = originals.get(fix.path);
    if (!orig || typeof orig.content !== "string" || typeof orig.sha !== "string" || !orig.sha) {
      reasons.push(`No exact-head original content for ${fix.path}`);
      continue;
    }
    if (fix.fixed_content === orig.content) {
      reasons.push(`${fix.path}: AI returned identical content — no fix applied`);
      continue;
    }

    const origLines = lines(orig.content).length;
    const fixLines = lines(fix.fixed_content).length;
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

function validateConfiguredLineBudget(fixes, originalFiles, configuredLimit) {
  const maxLineChanges = normalizePositiveInteger(configuredLimit, 200, 10000);
  const originals = new Map(originalFiles.map((file) => [file.path, file]));
  let total = 0;

  for (const fix of fixes) {
    const original = originals.get(fix.path);
    const remaining = maxLineChanges - total;
    const edits = countLineEdits(original.content, fix.fixed_content, remaining);
    total += edits;
    if (total > maxLineChanges) {
      return {
        valid: false,
        maxLineChanges,
        total,
        reason: `Generated fix exceeds max_line_changes (${total} > ${maxLineChanges})`,
      };
    }
  }

  return { valid: true, maxLineChanges, total };
}

/** Returns validated fixes, or null if pipeline should stop. */
export async function validateFixes(ctx, analysis, generated) {
  const {
    octokit, owner, repoName, repoId, issueNumber, branchName, repoConfig, repo,
    principalId, requestedByPrincipalId, requestedByLogin, triggeredBy,
  } = ctx;
  const fixes = Array.isArray(generated?.fixes) ? generated.fixes : [];
  const fileContents = Array.isArray(generated?.fileContents) ? generated.fileContents : [];
  const fixOpts = repoConfig.pillars?.issue_fix || {};
  const maxFileChanges = normalizePositiveInteger(fixOpts.max_file_changes, 3, 100);
  const minConfidence = normalizeFixConfidence(getMinFixConfidence(repoConfig));

  const validationResult = validatePatchCandidates(fixes, fileContents);
  if (!validationResult.valid) {
    logger.warn({ repo, issueNumber, reasons: validationResult.reasons }, "Patch validation failed");
    await upsertFixAttempt(repoId, issueNumber, branchName, "failed", analysis.complexity,
      analysis.explanation, "Patch validation failed: " + validationResult.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "⚠️ **GitWire Fix - validation failed**\n\n" +
      "**Assessment:** " + analysis.explanation + "\n\n" +
      "Generated fixes did not pass deterministic validation:\n" +
      validationResult.reasons.map((reason) => "- " + reason).join("\n") + "\n\n" +
      "_A maintainer should review manually._"
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

  const lineBudget = validateConfiguredLineBudget(fixes, fileContents, fixOpts.max_line_changes);
  if (!lineBudget.valid) {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, lineBudget.reason);
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - line-change guard**\n\n" +
      lineBudget.reason + ".\n\n" +
      "_Reduce scope or adjust `issue_fix.max_line_changes` in settings._"
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

  const risk = scoreFixRisk(analysis, fixes, fileContents);
  logger.info({
    repo,
    issueNumber,
    riskScore: risk.score,
    riskLevel: risk.level,
    reasons: risk.reasons,
    lineChanges: lineBudget.total,
  }, "Fix risk assessment");

  if (risk.level === "high") {
    await upsertFixAttempt(repoId, issueNumber, branchName, "rejected", analysis.complexity,
      analysis.explanation, "High risk: " + risk.reasons.join("; "));
    await postIssueComment(octokit, owner, repoName, issueNumber,
      "🚫 **GitWire Fix - high risk**\n\n" +
      "Risk score: **" + risk.score + "/100**\n" +
      risk.reasons.map((reason) => "- " + reason).join("\n") + "\n\n" +
      "_This fix is too risky for autonomous submission._"
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
      line_changes: lineBudget.total,
      complexity: analysis.complexity,
      confidence: preConfidence,
      base_sha: ctx._scope?.baseSha,
      principalId,
      surfaceId: "worker:issueFix",
      trigger_kind: triggeredBy ?? null,
      requested_by_principal_id: requestedByPrincipalId ?? null,
      requested_by_login: requestedByLogin ?? null,
    },
    repoId,
    targetType: "issue",
    targetNumber: issueNumber,
    actionKey: "issue-fix:" + issueNumber,
  });

  if (isDryRun(repoConfig)) {
    await cancel(fixAction.id, "Dry-run mode");
    logger.info({ repo, issueNumber, fixes: fixes.length, lineChanges: lineBudget.total }, "DRY RUN: would create fix PR");
    await upsertFixAttempt(repoId, issueNumber, branchName, "dry_run",
      analysis.complexity, analysis.explanation, null, null);
    return null;
  }

  await approve(fixAction.id, {
    confidence: preConfidence,
    min_confidence: minConfidence,
    scope_ok: true,
    base_sha: ctx._scope?.baseSha,
    line_changes: lineBudget.total,
  });
  await execute(fixAction.id);

  return { fixes, fileContents, preConfidence, fixAction };
}
