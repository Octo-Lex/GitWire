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
import { minimatch } from "minimatch";
import { createHash } from "node:crypto";

// ── Coverage states ──────────────────────────────────────────────────────────

export const COVERAGE = Object.freeze({
  FULL:           "full",            // entire file content represented in evidence
  POLICY_EXEMPT:  "policy_exempt",   // deterministically exempted from review
  PARTIAL:        "partial",         // only part of the file is in evidence (bounded portion)
  UNAVAILABLE:    "unavailable",     // file exists but could not be acquired (limit exceeded, no patch, etc.)
});

// ── Policy exemption categories ──────────────────────────────────────────────

export const EXEMPTION_RULES = Object.freeze({
  BINARY:             "binary",
  GENERATED_ARTIFACT: "generated_artifact",
  VENDORED_SOURCE:    "vendored_source",
  CONFIGURED_IGNORE:  "configured_ignore",
  PURE_RENAME:        "pure_rename",
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

/**
 * Determine the deterministic policy exemption for a file, if any.
 *
 * The model never decides exemption status — this function is purely
 * deterministic and auditable.
 *
 * Lockfiles are NOT globally exempt — a dependency-change PR can materially
 * change application behavior through its lockfile. Lockfiles remain
 * reviewable unless explicit repository policy exempts them.
 *
 * Files with a missing patch are NOT classified as binary — they may simply
 * be large. They are handled as unavailable by buildReviewEvidence.
 *
 * @param {object} file - PR file from GitHub API
 * @param {string[]} configuredIgnorePatterns - glob patterns from ai_review_config.ignore_patterns
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

  // 2. Binary file (by extension only — deterministic)
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      rule: EXEMPTION_RULES.BINARY,
      reason: "Binary file type: " + ext,
      source: "built_in",
    };
  }

  // 3. Generated artifact
  for (const pattern of GENERATED_PATTERNS) {
    if (pattern.test(filename)) {
      return {
        rule: EXEMPTION_RULES.GENERATED_ARTIFACT,
        reason: "Matches generated artifact pattern: " + pattern,
        source: "built_in",
      };
    }
  }

  // 4. Vendored source
  for (const pattern of VENDORED_PATTERNS) {
    if (pattern.test(filename)) {
      return {
        rule: EXEMPTION_RULES.VENDORED_SOURCE,
        reason: "Matches vendored source pattern: " + pattern,
        source: "built_in",
      };
    }
  }

  // 5. Configured ignore patterns (from ai_review_config) — using minimatch
  // to match the production review path's glob semantics.
  for (const pat of configuredIgnorePatterns) {
    if (minimatch(filename, pat)) {
      return {
        rule: EXEMPTION_RULES.CONFIGURED_IGNORE,
        reason: "Matches configured ignore pattern: " + pat,
        source: "repository_policy",
      };
    }
  }

  // Note: lockfiles are NOT exempt by default. A dependency-change PR can
  // materially change behavior through its lockfile. Repository policy may
  // exempt specific lockfiles via configured ignore patterns if desired.

  // Note: files with a missing patch are NOT classified as binary here.
  // They may be large files. buildReviewEvidence handles them as unavailable.

  return null;
}

// ── Content digest helper ────────────────────────────────────────────────────

function contentDigest(text) {
  if (!text) return null;
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Fetch file content at a specific ref and return its content digest.
 * Uses the GitHub contents API to get actual file content (not the diff patch).
 *
 * @param {object} octokit - GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - file path
 * @param {string} ref - commit SHA or ref
 * @returns {Promise<{ sha: string|null, contentDigest: string|null }>}
 */
async function fetchFileIdentity(octokit, owner, repo, path, ref) {
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref }
    );
    if (data && data.type === "file") {
      const content = data.encoding === "base64"
        ? Buffer.from(data.content, "base64").toString("utf-8")
        : (data.content || "");
      return {
        sha: data.sha || null,
        contentDigest: contentDigest(content),
      };
    }
  } catch (_e) {
    // File doesn't exist at this ref, or API error — identity unavailable
  }
  return { sha: null, contentDigest: null };
}

/**
 * Build side-specific Git identity for a changed file by fetching
 * actual base and head file content from the repository.
 *
 * A file's HEAD identity exists unless the file was removed.
 * A file's BASE identity exists unless the file was added.
 *
 * The content digest is computed from the actual file content at that ref,
 * NOT from the diff patch. This provides commit-bound integrity.
 *
 * @param {object} octokit - GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {object} file - PR file from GitHub API
 * @param {object} reviewRoot - { baseSha, headSha }
 * @returns {Promise<object>} { base, head } — each is { sha, blobSha, contentDigest } or null
 */
async function buildSideIdentity(octokit, owner, repo, file, reviewRoot) {
  const status = file.status || "modified";
  const filename = file.filename || "";
  const previousFilename = file.previous_filename || filename;

  const baseRef = reviewRoot?.baseSha || null;
  const headRef = reviewRoot?.headSha || null;

  // HEAD identity: exists for all statuses except "removed"
  let head = null;
  if (status !== "removed" && headRef) {
    const headIdentity = await fetchFileIdentity(octokit, owner, repo, filename, headRef);
    head = {
      sha: headRef,
      blobSha: headIdentity.sha || file.sha || null,
      contentDigest: headIdentity.contentDigest,
    };
  }

  // BASE identity: exists for all statuses except "added"
  let base = null;
  if (status !== "added" && baseRef) {
    // For renamed files, the base content is at the OLD path
    const basePath = (status === "renamed") ? previousFilename : filename;
    const baseIdentity = await fetchFileIdentity(octokit, owner, repo, basePath, baseRef);
    base = {
      sha: baseRef,
      blobSha: baseIdentity.sha || (status === "removed" ? file.sha : null),
      contentDigest: baseIdentity.contentDigest,
    };
  }

  return { base, head };
}

// ── Changed-file acquisition ─────────────────────────────────────────────────

/**
 * Acquire ALL changed files from a PR, paginating through the GitHub API.
 * No files are silently dropped. Removed files are included with explicit
 * accounting. Renamed files include both old and new paths.
 *
 * GitHub's PR-files API returns at most 3000 files. If the PR's
 * changed_files count exceeds the number we acquired, paginatedFully
 * is set to false and the coverage preflight will forbid approval.
 *
 * This replaces the current fetchDiff() which fetches only one page and
 * silently filters out removed/ignored files.
 *
 * @param {object} octokit - GitHub client
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} expectedFileCount - MANDATORY: authoritative changed_files from PR metadata
 * @returns {Promise<object>} { allFiles, paginatedFully }
 */
export async function acquireChangedFiles(octokit, owner, repo, prNumber, expectedFileCount) {
  if (typeof expectedFileCount !== "number") {
    throw new Error("acquireChangedFiles requires expectedFileCount (the PR's authoritative changed_files count). Without it, acquisition cannot prove completeness.");
  }
  const allFiles = [];
  let page = 1;
  let paginatedFully = true;

  // Paginate through ALL PR files — no cap. A PR with thousands of files
  // requires thousands of API calls, but correctness demands complete
  // accounting. The coverage preflight will mark files beyond review limits
  // as unavailable rather than silently dropping them.
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
  }

  // Reconcile against the PR's authoritative changed_files count (mandatory).
  // GitHub's PR-files API returns at most 3000 files; if the PR has more,
  // or if any files were lost in transit, the counts will differ.
  if (allFiles.length !== expectedFileCount) {
    paginatedFully = false;
    try {
      logger.warn({
        prNumber,
        acquired: allFiles.length,
        expected: expectedFileCount,
      }, "PR file acquisition incomplete — acquired count differs from authoritative changed_files");
    } catch (_e) {
      // Logger may not be initialized in test environments without runtime init
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
 *   - Non-exempt files with no patch → coverage = "unavailable" (large/binary, fail-closed)
 *   - Files within limits with a patch → coverage = "full"
 *   - File that crosses the line limit → coverage = "partial" (patch truncated, only represented lines counted)
 *   - Files beyond the file/line limit → coverage = "unavailable"
 *
 * @param {object} params
 * @param {object[]} params.allFiles - all PR files from acquireChangedFiles
 * @param {boolean} params.paginatedFully - whether acquisition fetched all pages
 * @param {string[]} params.ignorePatterns - configured ignore patterns (glob)
 * @param {number} params.maxFiles - max files to review
 * @param {number} params.maxLines - max changed lines to review
 * @param {object} params.review - immutable review root { repoId, repoFullName, prNumber, baseSha, headSha, invocationId }
 * @param {object} params.octokit - GitHub client (for fetching base/head content)
 * @param {string} params.owner
 * @param {string} params.repo
 * @returns {Promise<object>} ReviewEvidence with review root, changedFiles, coverage manifest
 */
export async function buildReviewEvidence({
  allFiles,
  paginatedFully = true,
  ignorePatterns = [],
  maxFiles = 30,
  maxLines = 2000,
  review: reviewRoot,
  octokit,
  owner,
  repo,
}) {
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

    // Build side-specific Git identity by fetching actual base/head content
    const { base, head } = await buildSideIdentity(octokit, owner, repo, file, reviewRoot);

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
        base, head,
        representedLines: 0,
      });
      continue;
    }

    // Non-exempt file — check if we've exhausted the file or line budget
    if (lineLimitExceeded || changedFiles.filter(f => f.coverage !== COVERAGE.POLICY_EXEMPT).length >= maxFiles) {
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
        base, head,
        representedLines: 0,
      });
      continue;
    }

    // No patch on a non-exempt, non-removed file — fail-closed as unavailable
    if (!file.patch && file.status !== "removed") {
      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.UNAVAILABLE,
        coverageReason: "No text diff available (binary or large file) — cannot verify content",
        policyExemption: null,
        patch: null,
        base, head,
        representedLines: 0,
      });
      continue;
    }

    // Check if including this file will exceed the line limit
    const remainingBudget = maxLines - changedLinesConsumed;

    if (fileLines > remainingBudget && remainingBudget > 0) {
      const representedLines = remainingBudget;
      const truncatedPatch = truncatePatchToLines(file.patch, representedLines);

      // For partial coverage, the head identity's contentDigest reflects the
      // full file content (fetched above), but the represented patch is truncated.
      // The contentDigest stays as the full-file digest for integrity.

      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.PARTIAL,
        coverageReason: "Line limit exceeded — only " + representedLines + " of " + fileLines + " lines represented",
        policyExemption: null,
        patch: truncatedPatch,
        base, head,
        representedLines,
      });
      changedLinesConsumed += representedLines;
      lineLimitExceeded = true;
      continue;
    }

    // If remaining budget is 0 or negative, file is unavailable
    if (remainingBudget <= 0) {
      changedFiles.push({
        path: filename,
        previousPath: file.previous_filename || null,
        status: file.status,
        additions,
        deletions,
        coverage: COVERAGE.UNAVAILABLE,
        coverageReason: "Line budget exhausted",
        policyExemption: null,
        patch: null,
        base, head,
        representedLines: 0,
      });
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
      base, head,
      representedLines: fileLines,
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
    acquisitionComplete: paginatedFully,
    approvalEvidenceComplete: false, // computed below
  };

  if (coverage.partialFiles > 0) coverage.limitsExceeded.push("line_limit_partial");
  if (coverage.unavailableFiles > 0) {
    coverage.limitsExceeded.push(lineLimitExceeded ? "line_limit_unavailable" : "file_limit_unavailable");
  }
  if (!paginatedFully) coverage.limitsExceeded.push("pagination_incomplete");

  // approvalEvidenceComplete requires:
  //   1. immutable review root is present (commit-bound identity)
  //   2. pagination completed (all files accounted for)
  //   3. all non-exempt files have FULL coverage
  //   4. at least one non-exempt file exists
  const nonExemptFiles = changedFiles.filter(f => f.coverage !== COVERAGE.POLICY_EXEMPT);
  coverage.approvalEvidenceComplete =
    !!reviewRoot &&
    paginatedFully &&
    nonExemptFiles.length > 0 &&
    nonExemptFiles.every(f => f.coverage === COVERAGE.FULL);

  return {
    version: 1,
    review: reviewRoot || null,
    changedFiles,
    contextItems: [],   // RI-3 will populate
    retrievalTrace: [], // RI-3 will populate
    coverage,
  };
}

// ── Patch truncation helper ──────────────────────────────────────────────────

/**
 * Truncate a unified diff patch to approximately N changed lines.
 * Counts lines starting with + or - (excluding +++ and --- headers).
 * Preserves hunk headers (@@) and context lines.
 *
 * @param {string} patch - unified diff patch
 * @param {number} maxChangedLines - maximum changed lines to retain
 * @returns {string} truncated patch with marker
 */
function truncatePatchToLines(patch, maxChangedLines) {
  if (!patch || typeof patch !== "string") return patch || "";
  const lines = patch.split("\n");
  const kept = [];
  let changedCount = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      kept.push(line);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      kept.push(line);
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      if (changedCount >= maxChangedLines) {
        kept.push("... (truncated at " + maxChangedLines + " changed lines)");
        return kept.join("\n");
      }
      changedCount++;
    }
    kept.push(line);
  }

  return kept.join("\n");
}
