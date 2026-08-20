// src/services/reviewCoverageService.js
// Deterministic changed-file coverage accounting for the advisory review
// contract (frozen v1.2, WP-2).
//
// Every changed file — including removed files, which are normal reviewable
// changes, not exemptions — gets an accounting record BEFORE any review
// filtering. Configured budgets still cap review work; exceeding a budget
// marks the omitted material explicitly partial instead of silently dropping
// it. `policy_exempt` means an explicit ignore rule excluded the path, never
// "GitHub says the file was deleted".
//
// Coverage values:
//   full           - file admitted to review with complete evidence
//   policy_exempt  - explicit ignore/exemption rule matched the path
//   partial        - file known but review evidence incomplete (budget or
//                    truncation reached)
//   unavailable    - no usable patch (binary / missing)
//
// This module is pure: no I/O, deterministic for its inputs. The only import
// is minimatch, used for exact parity with the legacy ignore-pattern filter.

import { minimatch } from "minimatch";

/**
 * Account for every changed file and select the reviewable set.
 *
 * @param {object} input
 * @param {Array}  input.prFiles  - raw GitHub changed-file objects (all pages)
 * @param {object} input.cfg      - { ignore_patterns, max_files_to_review, max_lines_to_review }
 * @param {string} input.headSha  - exact head the files were listed at
 * @param {boolean} [input.paginationCapped] - the changed-files pagination cap
 *   was hit; files beyond the cap are unaccounted and evidence is incomplete.
 * @returns {{
 *   files: Array, totalAdded: number, totalRemoved: number,
 *   coverage: {
 *     headSha: string, totalChangedFiles: number, accountedFiles: number,
 *     files: Array<{path, status, coverage, reason}>,
 *     limitsExceeded: string[], approvalEvidenceComplete: boolean
 *   }
 * }}
 */
export function buildFileCoverage({ prFiles, cfg, headSha, paginationCapped = false }) {
  const ignorePatterns = Array.isArray(cfg?.ignore_patterns) ? cfg.ignore_patterns : [];
  const maxFiles = Number.isFinite(cfg?.max_files_to_review) ? cfg.max_files_to_review : 30;
  const maxLines = Number.isFinite(cfg?.max_lines_to_review) ? cfg.max_lines_to_review : 2000;

  const records = [];
  const nonExempt = [];

  for (const f of prFiles) {
    const ignored = ignorePatterns.some(
      (pat) => typeof pat === "string" && minimatch(f.filename, pat)
    );
    if (ignored) {
      records.push({ path: f.filename, status: f.status, coverage: "policy_exempt", reason: "ignore_pattern" });
      continue;
    }
    nonExempt.push(f);
    if (!f.patch) {
      records.push({ path: f.filename, status: f.status, coverage: "unavailable", reason: "no_patch" });
    } else {
      records.push({ path: f.filename, status: f.status, coverage: "full", reason: null });
    }
  }

  // Apply configured budgets in the legacy order: file-count slice first,
  // then the cumulative line budget. Admitted files flow to the bundle;
  // everything the budgets exclude is marked partial with the limit that
  // excluded it. Totals keep the legacy semantics: admitted files plus the
  // file that tripped the line budget are counted, later files are not.
  const admitted = [];
  const limitsExceeded = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let lineTotal = 0;
  let lineBudgetTripped = false;

  for (let i = 0; i < nonExempt.length; i++) {
    const f = nonExempt[i];

    if (admitted.length >= maxFiles) {
      markRecord(records, f.filename, "partial", "max_files_exceeded");
      if (!limitsExceeded.includes("max_files_to_review")) limitsExceeded.push("max_files_to_review");
      continue;
    }

    const lines = (f.additions ?? 0) + (f.deletions ?? 0);
    if (lineTotal + lines > maxLines) {
      lineTotal += lines;
      totalAdded += f.additions ?? 0;
      totalRemoved += f.deletions ?? 0;
      markRecord(records, f.filename, "partial", "max_lines_exceeded");
      if (!limitsExceeded.includes("max_lines_to_review")) limitsExceeded.push("max_lines_to_review");
      lineBudgetTripped = true;
      break;
    }

    lineTotal += lines;
    totalAdded += f.additions ?? 0;
    totalRemoved += f.deletions ?? 0;
    admitted.push({
      filename: f.filename,
      status:   f.status,
      added:    f.additions ?? 0,
      removed:  f.deletions ?? 0,
      patch:    f.patch ?? "",
      sha:      f.sha,
    });
  }

  if (lineBudgetTripped) {
    // Everything after the trip file was never examined — explicit partial.
    const tripIndex = nonExempt.findIndex((f) => recordFor(records, f.filename)?.reason === "max_lines_exceeded");
    for (let i = tripIndex + 1; i < nonExempt.length; i++) {
      markRecord(records, nonExempt[i].filename, "partial", "max_lines_exceeded");
    }
  }

  if (paginationCapped && !limitsExceeded.includes("changed_files_pagination_cap")) {
    limitsExceeded.push("changed_files_pagination_cap");
  }

  const coverage = {
    headSha,
    totalChangedFiles: prFiles.length,
    accountedFiles: records.length,
    files: records,
    limitsExceeded,
    approvalEvidenceComplete:
      paginationCapped !== true &&
      records.every((r) => r.coverage === "full" || r.coverage === "policy_exempt"),
  };

  return { files: admitted, totalAdded, totalRemoved, coverage };
}

/**
 * Apply bundle-stage truncation adjustments (per-file patch truncation,
 * aggregate bundle truncation) and recompute evidence completeness.
 *
 * @param {object} coverage                      - coverage from buildFileCoverage
 * @param {Array<{path: string, coverage: string, reason: string}>} [adjustments]
 * @returns {object} updated coverage (new object; input untouched)
 */
export function finalizeCoverage(coverage, adjustments) {
  const files = coverage.files.map((r) => ({ ...r }));
  for (const adj of adjustments ?? []) {
    const record = files.find((r) => r.path === adj.path);
    if (record && adj.coverage === "partial") {
      record.coverage = "partial";
      record.reason = adj.reason;
    }
  }
  return {
    ...coverage,
    files,
    approvalEvidenceComplete: files.every(
      (r) => r.coverage === "full" || r.coverage === "policy_exempt"
    ),
  };
}

/**
 * Human-readable one-line evidence summary for check and review surfaces.
 *
 * @param {object} coverage
 * @returns {string}
 */
export function coverageSummaryLine(coverage) {
  if (!coverage) return "";
  if (coverage.approvalEvidenceComplete) {
    return (
      "Evidence complete \u00B7 " +
      coverage.accountedFiles + "/" + coverage.totalChangedFiles +
      " changed files accounted for"
    );
  }
  const lacking = coverage.files.filter(
    (r) => r.coverage === "partial" || r.coverage === "unavailable"
  ).length;
  const limits = coverage.limitsExceeded.length
    ? " (limits reached: " + coverage.limitsExceeded.join(", ") + ")"
    : "";
  return (
    "Evidence incomplete \u00B7 " +
    lacking + " of " + coverage.totalChangedFiles +
    " changed files lack complete review evidence" + limits
  );
}

function markRecord(records, path, coverage, reason) {
  const record = recordFor(records, path);
  if (record) {
    record.coverage = coverage;
    record.reason = reason;
  }
}

function recordFor(records, path) {
  return records.find((r) => r.path === path) ?? null;
}
