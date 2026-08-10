// src/services/reviewEvidenceService.js
// ReviewEvidence — the structured evidence contract that replaces the opaque
// bundle as the source of truth for AI review coverage.
//
// RI-2 work package: changed-file acquisition, policy exemption, coverage preflight.
//
// The ReviewEvidence object is consumed by the primary reviewer (RI-4 findings),
// the independent verifier (RI-5), and the deterministic decision policy (RI-6).
// It is NOT consumed by the current production engine — it exists behind the
// review_integrity_v2 feature flag.

import { logger } from "../lib/logger.js";

// ── Coverage states ──────────────────────────────────────────────────────────

export const COVERAGE = Object.freeze({
  FULL:           "full",            // entire file content represented in evidence
  POLICY_EXEMPT:  "policy_exempt",   // deterministically exempted from review
  PARTIAL:        "partial",         // only part of the file is in evidence (e.g. truncated diff)
  UNAVAILABLE:    "unavailable",     // file exists but could not be acquired (limit exceeded before reaching it)
});

// ── Policy exemption categories ──────────────────────────────────────────────

export const EXEMPTION_RULES = Object.freeze({
  BINARY:             "binary",
  GENERATED_ARTIFACT: "generated_artifact",
  VENDORED_SOURCE:    "vendored_source",
  CONFIGURED_IGNORE:  "configured_ignore",
  PURE_RENAME:        "pure_rename",
  GENERATED_LOCKFILE: "generated_lockfile",
});

// ── Deterministic exemption classification ──────────────────────────────────

// File extensions that are always binary (never reviewable as text)
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".tgz", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".flv", ".webm",
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib",
  ".class", ".jar", ".war",
  ".pyc", ".pyd", ".wasm",
  ".dat", ".bin",
]);

// Patterns indicating generated artifacts
const GENERATED_PATTERNS = [
  /\.min\.js$/i,
  /\.min\.css$/i,
  /\.bundle\.js$/i,
  /^dist\//i,
  /^build\//i,
  /^out\//i,
  /^\.next\//i,
  /^coverage\//i,
  /^\.cache\//i,
];

// Patterns indicating vendored (third-party) source
const VENDORED_PATTERNS = [
  /^vendor\//i,
  /^third_party\//i,
  /^node_modules\//i,
  /^bower_components\//i,
  /^deps\//i,
];

// Lockfile patterns (require care — not globally exempt)
const LOCKFILE_PATTERNS = [
  /^package-lock\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^Cargo\.lock$/i,
  /^go\.sum$/i,
  /^composer\.lock$/i,
  /^Gemfile\.lock$/i,
  /\.lock$/i,
];

/**
 * Determine the deterministic policy exemption for a file, if any.
 *
 * The model never decides exemption status — this function is purely
 * deterministic and auditable.
 *
 * @param {object} file - PR file from GitHub API
 * @param {string[]} configuredIgnorePatterns - from ai_review_config.ignore_patterns
 * @returns {object|null} { rule, reason, source } or null if not exempt
 */
export function classifyExemption(file, configuredIgnorePatterns = []) {
  const filename = file.filename || "";
  const ext = filename.substring(filename.lastIndexOf(".")).toLowerCase();

  // 1. Pure rename with no content change
  if (file.status === "renamed" && file.additions === 0 && file.deletions === 0) {
    return {
      rule: EXEMPTION_RULES.PURE_RENAME,
      reason: "Renamed with no content change",
      source: "built_in",
    };
  }

  // 2. Binary file (by extension)
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      rule: EXEMPTION_RULES.BINARY,
      reason: "Binary file type: " + ext,
      source: "built_in",
    };
  }

  // 3. No patch (binary or large file with no text diff)
  if (!file.patch && file.status !== "removed") {
    return {
      rule: EXEMPTION_RULES.BINARY,
      reason: "No text diff available (binary or large file)",
      source: "built_in",
    };
  }

  // 4. Generated artifact
  for (const pattern of GENERATED_PATTERNS) {
    if (pattern.test(filename)) {
      return {
        rule: EXEMPTION_RULES.GENERATED_ARTIFACT,
        reason: "Matches generated artifact pattern: " + pattern,
        source: "built_in",
      };
    }
  }

  // 5. Vendored source
  for (const pattern of VENDORED_PATTERNS) {
    if (pattern.test(filename)) {
      return {
        rule: EXEMPTION_RULES.VENDORED_SOURCE,
        reason: "Matches vendored source pattern: " + pattern,
        source: "built_in",
      };
    }
  }

  // 6. Configured ignore patterns (from ai_review_config)
  for (const pat of configuredIgnorePatterns) {
    try {
      const re = new RegExp(pat);
      if (re.test(filename)) {
        return {
          rule: EXEMPTION_RULES.CONFIGURED_IGNORE,
          reason: "Matches configured ignore pattern: " + pat,
          source: "repository_policy",
        };
      }
    } catch (_e) {
      // Invalid regex — try string match
      if (filename.includes(pat)) {
        return {
          rule: EXEMPTION_RULES.CONFIGURED_IGNORE,
          reason: "Matches configured ignore pattern: " + pat,
          source: "repository_policy",
        };
      }
    }
  }

  // 7. Lockfile (generated-lockfile — requires care, not globally exempt)
  for (const pattern of LOCKFILE_PATTERNS) {
    if (pattern.test(filename)) {
      return {
        rule: EXEMPTION_RULES.GENERATED_LOCKFILE,
        reason: "Lockfile (generated): " + filename,
        source: "built_in",
      };
    }
  }

  return null;
}

// ── Changed-file acquisition ─────────────────────────────────────────────────

/**
 * Acquire ALL changed files from a PR, paginating through the GitHub API.
 * No files are silently dropped. Removed files are included with explicit
 * accounting. Renamed files include both old and new paths.
 *
 * This replaces the current fetchDiff() which fetches only one page and
 * silently filters out removed/ignored files.
 *
 * @param {object} octokit - GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} maxFiles - max files to review (from config, default 30)
 * @param {number} maxLines - max changed lines to review (from config, default 2000)
 * @returns {Promise<object>} { allFiles, paginatedFully }
 */
export async function acquireChangedFiles(octokit, owner, repo, prNumber, maxFiles = 30, maxLines = 2000) {
  const allFiles = [];
  let page = 1;
  let paginatedFully = true;

  // Paginate through ALL PR files
  while (true) {
    const { data: files } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
      { owner, repo, pull_number: prNumber, per_page: 100, page }
    );

    allFiles.push(...files);

    if (files.length < 100) {
      break; // last page
    }

    page++;

    // Safety: GitHub PRs can have thousands of files. Cap at 1000 to avoid
    // unbounded API calls. If we hit this, paginatedFully = false.
    if (page > 10) {
      paginatedFully = false;
      logger.warn({ prNumber, filesFetched: allFiles.length }, "PR file pagination capped at 1000 files");
      break;
    }
  }

  return { allFiles, paginatedFully };
}

// ── Coverage preflight ───────────────────────────────────────────────────────

/**
 * Build a ReviewEvidence object from the acquired files, applying policy
 * exemptions and computing coverage states.
 *
 * Coverage assignment rules:
 *   - Policy-exempt files → coverage = "policy_exempt"
 *   - Removed files → coverage = "full" (the diff shows everything that was removed)
 *   - Files within limits → coverage = "full"
 *   - File that crosses the line limit → coverage = "partial" (included but truncated)
 *   - Files beyond the file/line limit → coverage = "unavailable" (accounted but not in evidence)
 *
 * @param {object} params
 * @param {object[]} params.allFiles - all PR files from acquireChangedFiles
 * @param {string[]} params.ignorePatterns - configured ignore patterns
 * @param {number} params.maxFiles - max files to review
 * @param {number} params.maxLines - max changed lines to review
 * @returns {object} ReviewEvidence with changedFiles, coverage manifest
 */
export function buildReviewEvidence({ allFiles, ignorePatterns = [], maxFiles = 30, maxLines = 2000 }) {
  const changedFiles = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let changedLinesConsumed = 0;
  let lineLimitExceeded = false;

  for (const file of allFiles) {
    const filename = file.filename || "";
    const additions = file.additions ?? 0;
    const deletions = file.deletions ?? 0;
    const fileLines = additions + deletions;
    totalAdded += additions;
    totalRemoved += deletions;

    // Check policy exemption FIRST — exempt files are accounted but don't consume budget
    const exemption = classifyExemption(file, ignorePatterns);

    if (exemption) {
      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.POLICY_EXEMPT,
        coverageReason: "Exempt: " + exemption.reason,
        policyExemption: exemption,
        patch: file.patch ?? null,
      });
      continue;
    }

    // Non-exempt file — check if we've exhausted the file or line budget
    if (lineLimitExceeded || changedFiles.filter(f => f.coverage !== COVERAGE.POLICY_EXEMPT).length >= maxFiles) {
      // Beyond limits — accounted but unavailable
      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.UNAVAILABLE,
        coverageReason: lineLimitExceeded
          ? "Line limit exceeded before this file"
          : "File limit exceeded (" + maxFiles + " files)",
        policyExemption: null,
        patch: null,
      });
      continue;
    }

    // Check if including this file would exceed the line limit
    if (changedLinesConsumed + fileLines > maxLines) {
      // This file crosses the line boundary — partial coverage
      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.PARTIAL,
        coverageReason: "Line limit exceeded while including this file (" + (changedLinesConsumed + fileLines) + " > " + maxLines + ")",
        policyExemption: null,
        patch: file.patch ?? null,
      });
      changedLinesConsumed += fileLines;
      lineLimitExceeded = true;
      continue;
    }

    // Full coverage — file is within budget
    changedFiles.push({
      path: filename,
      previousPath: file.previous_filename || null,
      status: file.status,
      additions,
      deletions,
      coverage: COVERAGE.FULL,
      coverageReason: null,
      policyExemption: null,
      patch: file.patch ?? null,
    });
    changedLinesConsumed += fileLines;
  }

  // Build coverage manifest
  const coverage = {
    totalChangedFiles: allFiles.length,
    fullyCoveredFiles: changedFiles.filter(f => f.coverage === COVERAGE.FULL).length,
    policyExemptFiles: changedFiles.filter(f => f.coverage === COVERAGE.POLICY_EXEMPT).length,
    partialFiles: changedFiles.filter(f => f.coverage === COVERAGE.PARTIAL).length,
    unavailableFiles: changedFiles.filter(f => f.coverage === COVERAGE.UNAVAILABLE).length,

    changedLinesTotal: totalAdded + totalRemoved,
    changedLinesRepresented: changedLinesConsumed,

    limitsExceeded: [],
    approvalEvidenceComplete: false, // computed below
  };

  if (coverage.partialFiles > 0) coverage.limitsExceeded.push("line_limit_partial");
  if (coverage.unavailableFiles > 0) coverage.limitsExceeded.push(lineLimitExceeded ? "line_limit_unavailable" : "file_limit_unavailable");

  // approvalEvidenceComplete: all non-exempt files must be FULL coverage
  const nonExemptFiles = changedFiles.filter(f => f.coverage !== COVERAGE.POLICY_EXEMPT);
  coverage.approvalEvidenceComplete =
    nonExemptFiles.length > 0 &&
    nonExemptFiles.every(f => f.coverage === COVERAGE.FULL);

  return {
    version: 1,
    changedFiles,
    coverage,
  };
}
