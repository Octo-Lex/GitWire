// src/services/reviewScopeResolver.js
// SC-01 P1: budget-free eligible-scope resolution for the smart-coverage
// planner.
//
// buildFileCoverage() (frozen v1.2 WP-2) applies two persisted admission
// budgets — max_files_to_review (default 30) and max_lines_to_review
// (default 2000) — BEFORE evidence ever reaches token admission. Those
// budgets are execution-planning signals under SC-01, not coverage
// decisions, so the planner needs a scope model that classifies every
// changed file without them.
//
// Classification semantics are IDENTICAL to buildFileCoverage() for
// everything that is not a budget:
//   policy_exempt  - explicit ignore/exemption rule matched the path
//   unavailable    - no usable patch (binary / missing / GitHub withheld)
//   eligible       - changed file with a reviewable patch (deleted files
//                    with a patch are normal reviewable changes)
//
// This module is pure: no I/O, deterministic for its inputs. The only
// import is minimatch, for exact parity with the legacy ignore-pattern
// filter. cfg.max_files_to_review and cfg.max_lines_to_review are
// DELIBERATELY NOT READ — passing them has no effect on the resolved
// scope.

import { minimatch } from "minimatch";

/**
 * Classify every changed file as eligible / exempt / unavailable without
 * applying any line- or file-count budget.
 *
 * @param {object} input
 * @param {Array}  input.prFiles  - raw GitHub changed-file objects (all pages)
 * @param {object} input.cfg      - { ignore_patterns } (budget fields ignored)
 * @param {string} input.headSha  - exact head the files were listed at
 * @param {boolean} [input.paginationCapped] - the changed-files pagination cap
 *   was hit; files beyond the cap are unaccounted and the owed scope is
 *   truthfully incomplete (acquisition boundary, SC-01 P7 territory).
 * @returns {{
 *   headSha: string, totalChangedFiles: number, paginationCapped: boolean,
 *   eligible: Array<{filename, status, added, removed, patch, sha}>,
 *   policyExempt: Array<{path, status, reason}>,
 *   unavailable: Array<{path, status, reason}>,
 *   totals: {eligibleAdded: number, eligibleRemoved: number}
 * }}
 */
export function resolveReviewScope({ prFiles, cfg, headSha, paginationCapped = false }) {
  const ignorePatterns = Array.isArray(cfg?.ignore_patterns) ? cfg.ignore_patterns : [];

  const eligible = [];
  const policyExempt = [];
  const unavailable = [];
  let eligibleAdded = 0;
  let eligibleRemoved = 0;

  for (const f of prFiles) {
    const ignored = ignorePatterns.some(
      (pat) => typeof pat === "string" && minimatch(f.filename, pat)
    );
    if (ignored) {
      policyExempt.push({ path: f.filename, status: f.status, reason: "ignore_pattern" });
      continue;
    }
    if (!f.patch) {
      unavailable.push({ path: f.filename, status: f.status, reason: "no_patch" });
      continue;
    }
    const added = f.additions ?? 0;
    const removed = f.deletions ?? 0;
    eligibleAdded += added;
    eligibleRemoved += removed;
    eligible.push({
      filename: f.filename,
      status:   f.status,
      added,
      removed,
      patch:    f.patch,
      sha:      f.sha,
    });
  }

  return {
    headSha,
    totalChangedFiles: prFiles.length,
    paginationCapped: paginationCapped === true,
    eligible,
    policyExempt,
    unavailable,
    totals: { eligibleAdded, eligibleRemoved },
  };
}
