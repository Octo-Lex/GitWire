// src/services/reviewValidator.js
// Validates AI review output against schema + scope rules.
//
// Adapted from prior autoreview work autoreview patterns:
//   - Validate findings shape before persistence
//   - Filter out-of-scope findings (files not in the diff)
//   - Flip verdict if all findings are out-of-scope
//   - Return clean validated report with audit trail of what was rejected

import { logger } from "../lib/logger.js";
import {
  validateReviewReport,
  reportToLegacy,
} from "@gitwire/rules";

/**
 * Validate and scope-filter an AI review report.
 *
 * @param {object} report - Raw parsed review report from the LLM
 * @param {string[]} changedFiles - Files that were in the diff (scope)
 * @returns {{
 *   valid: boolean,
 *   legacy: object|null,
 *   keptFindings: object[],
 *   ignoredFindings: object[],
 *   schemaErrors: string[],
 *   scopeDroppedCount: number
 * }}
 */
export function validateReview(report, changedFiles) {
  // ── Step 1: Schema validation ───────────────────────────────────────────
  const schemaResult = validateReviewReport(report);

  if (!schemaResult.valid) {
    logger.warn(
      { errors: schemaResult.errors },
      "Review validation: schema errors, attempting partial extraction"
    );

    // Try to salvage what we can — if findings array exists, filter valid ones
    if (report && Array.isArray(report.findings)) {
      const partial = salvagePartialReport(report, changedFiles);
      if (partial.legacy) {
        logger.info(
          { kept: partial.keptFindings.length, ignored: partial.ignoredFindings.length },
          "Review validation: salvaged partial report"
        );
        return {
          valid: true,
          legacy: partial.legacy,
          keptFindings: partial.keptFindings,
          ignoredFindings: partial.ignoredFindings,
          schemaErrors: schemaResult.errors,
          scopeDroppedCount: partial.scopeDroppedCount,
        };
      }
    }

    return {
      valid: false,
      legacy: null,
      keptFindings: [],
      ignoredFindings: [],
      schemaErrors: schemaResult.errors,
      scopeDroppedCount: 0,
    };
  }

  // ── Step 2: Scope filtering ─────────────────────────────────────────────
  const changedFileSet = new Set(changedFiles);

  const keptFindings = [];
  const ignoredFindings = [];

  for (const finding of report.findings) {
    const filePath = finding.code_location?.file_path;

    // No file_path = general finding, always keep
    if (!filePath) {
      keptFindings.push(finding);
      continue;
    }

    // Exact match
    if (changedFileSet.has(filePath)) {
      keptFindings.push(finding);
      continue;
    }

    // Prefix match (finding may reference a line within a changed file)
    const isPrefixOfFile = [...changedFileSet].some(function (cf) {
      return cf.startsWith(filePath) || filePath.startsWith(cf);
    });
    if (isPrefixOfFile) {
      keptFindings.push(finding);
      continue;
    }

    // Out of scope — reject
    ignoredFindings.push({
      finding,
      reason: "file_not_in_diff: " + filePath,
    });
  }

  const scopeDroppedCount = ignoredFindings.length;

  // ── Step 3: Flip verdict if all findings were out-of-scope ──────────────
  // (adapted from autoreview's scope rejection pattern)
  let finalReport = report;
  if (report.findings.length > 0 && keptFindings.length === 0) {
    logger.info("Review validation: all findings out-of-scope, flipping verdict to correct");
    finalReport = {
      ...report,
      findings: [],
      overall_correctness: "patch is correct",
      overall_explanation: report.overall_explanation +
        "\n\n[GitWire: All " + report.findings.length + " findings were out-of-scope (files not in the diff) and were dropped.]",
    };
  } else if (scopeDroppedCount > 0) {
    // Some findings dropped — rebuild with only in-scope findings
    finalReport = {
      ...report,
      findings: keptFindings,
    };
  }

  // ── Step 4: Convert to legacy format ────────────────────────────────────
  const legacy = reportToLegacy(finalReport);

  return {
    valid: true,
    legacy,
    keptFindings: legacy.findings,
    ignoredFindings,
    schemaErrors: [],
    scopeDroppedCount,
  };
}

/**
 * Attempt to salvage a partial report from a malformed LLM response.
 * Extracts individually valid findings and constructs a minimal report.
 */
function salvagePartialReport(report, changedFiles) {
  const validFindings = [];
  const ignoredFindings = [];

  for (const finding of (report.findings || [])) {
    if (!finding || typeof finding !== "object") continue;

    // Minimal validation: must have title and priority
    if (typeof finding.title !== "string" || finding.title.length === 0) {
      ignoredFindings.push({ finding, reason: "missing_title" });
      continue;
    }

    if (!["P0", "P1", "P2", "P3"].includes(finding.priority)) {
      ignoredFindings.push({ finding, reason: "invalid_priority" });
      continue;
    }

    // Build a normalized finding
    const normalized = {
      title: finding.title.slice(0, 140),
      body: (finding.body || finding.description || "").slice(0, 2000),
      priority: finding.priority,
      confidence: typeof finding.confidence === "number" ? Math.min(1, Math.max(0, finding.confidence)) : 0.5,
      category: ["bug", "security", "regression", "test_gap", "maintainability"].includes(finding.category)
        ? finding.category
        : "maintainability",
      code_location: {
        file_path: finding.code_location?.file_path || finding.file || null,
        line: finding.code_location?.line || finding.line || null,
      },
    };

    validFindings.push(normalized);
  }

  if (validFindings.length === 0 && !report.overall_correctness) {
    return { legacy: null, keptFindings: [], ignoredFindings, scopeDroppedCount: 0 };
  }

  // Build a synthetic report
  const salvaged = {
    findings: validFindings,
    overall_correctness: report.overall_correctness || "patch is correct",
    overall_explanation: report.overall_explanation || "Partial review extracted from malformed response.",
    overall_confidence: typeof report.overall_confidence === "number" ? report.overall_confidence : 0.3,
  };

  // Re-run scope filtering
  const changedFileSet = new Set(changedFiles);
  const kept = [];
  const scopeIgnored = [];

  for (const f of salvaged.findings) {
    const fp = f.code_location?.file_path;
    if (!fp || changedFileSet.has(fp)) {
      kept.push(f);
    } else {
      scopeIgnored.push({ finding: f, reason: "file_not_in_diff: " + fp });
    }
  }

  const finalFindings = kept.length === 0 && salvaged.findings.length > 0
    ? []
    : kept;

  const finalReport = {
    ...salvaged,
    findings: finalFindings,
    overall_correctness: finalFindings.length === 0 ? "patch is correct" : salvaged.overall_correctness,
  };

  const legacy = reportToLegacy(finalReport);

  return {
    legacy,
    keptFindings: legacy.findings,
    ignoredFindings: [...ignoredFindings, ...scopeIgnored],
    scopeDroppedCount: scopeIgnored.length,
  };
}
