// src/services/reviewOutputFormatter.js
// GitHub PR-review output builders (RI-9 Phase 10 information boundary).
//
// These two functions were moved verbatim from aiReviewService.js so the
// PR-facing output surface is directly testable. They compose the review
// body, inline comments, and check-run output from FINDINGS and VERDICT
// only — never from execution-profile telemetry. That is the frozen
// PR/dashboard/audit information boundary:
//
//   PR review:     decision, reviewed SHA, actionable findings, evidence,
//                  suggestions, concise incompleteness explanation
//   Dashboard:     execution identity, quality measurements, budgets, cost
//   Audit receipt: full execution-profile forensic metadata

import { buildInlineComments, partitionAnchored, renderBodyOnlyDetails } from "./reviewAnchorResolver.js";

// ════════════════════════════════════════════════════════════════════════════
// GitHub PR Review body building (shared between legacy POST and v2 mutation manager)
// ════════════════════════════════════════════════════════════════════════════

export function buildReviewMarkdown(findings, verdict, confidence, scopeDroppedCount, adversarialMeta, files) {
  var VERDICT_LABEL = {
    approved:          "\u2705 Approved",
    needs_discussion:  "\uD83D\uDCAC Needs discussion",
    request_changes:   "\u274C Changes requested",
  };

  var critical = findings.filter(function (f) { return f.severity === "critical"; });
  var high     = findings.filter(function (f) { return f.severity === "high"; });
  var others   = findings.filter(function (f) { return ["critical", "high"].indexOf(f.severity) === -1; });
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

  // Inline comments are anchor-validated against the fetched unified
  // patches (line/side on the RIGHT side). The model's file line is NOT a
  // diff position — serializing it as `position` produced 422 "Position
  // could not be resolved". Findings NOT emitted inline — unanchorable,
  // no usable location, or beyond the inline cap — carry their full
  // description, suggestion, and location in the body. The finding is
  // never dropped.
  var { anchored, bodyOnly } = partitionAnchored(findings, files ?? []);
  summaryLines.push(...renderBodyOnlyDetails(bodyOnly));
  var comments = buildInlineComments(anchored, files ?? []);

  var body    = summaryLines.filter(function (l) { return l !== ""; }).join("\n");
  var summary = summaryLines.slice(0, 3).join(" ");

  return { body, summary, comments };
}

// ════════════════════════════════════════════════════════════════════════════
// Check run helpers
// ════════════════════════════════════════════════════════════════════════════

export function buildCheckOutput(findings, verdict, confidence, summary, scopeDroppedCount) {
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
