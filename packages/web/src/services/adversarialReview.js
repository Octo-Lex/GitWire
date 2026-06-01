// src/services/adversarialReview.js
// Devil's Advocate: second-pass adversarial challenge for AI review findings.
//
// After the initial structured review produces findings, this module makes
// a second (cheaper) LLM call that tries to DISPROVE each finding. Surviving
// findings get a confidence boost; disproved ones are dropped or downgraded.
// The adversarial pass also looks for risks the initial review missed.
//
// Flow:
//   findings[] → build challenge prompt → Haiku call → parse challenges
//   → refineFindings() → updated findings[] + adversarial metadata

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { extractReviewJSON } from "@gitwire/rules";

const ADVERSARIAL_MODEL = "claude-haiku-4-20250414";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
});

// ════════════════════════════════════════════════════════════════════════════
// System prompt for the adversarial challenge
// ════════════════════════════════════════════════════════════════════════════

const ADVERSARIAL_SYSTEM_PROMPT = [
  "You are the Devil's Advocate in a code review. Your job is to CHALLENGE",
  "the findings of a previous AI review. You must try to disprove or weaken",
  "every finding. You are skeptical by nature.",
  "",
  "For each finding, consider:",
  "1. Could this be a FALSE POSITIVE? Is the finding based on incomplete context?",
  "   (e.g., the diff doesn't show the full function, imports are missing,",
  "   test coverage exists elsewhere, the code is called in a specific way)",
  "2. Could this be INTENTIONAL behavior or a deliberate design choice?",
  "3. Is the severity OVERSTATED? Could a 'critical' actually be 'medium'?",
  "4. Is the finding generic/vague rather than specific to this diff?",
  "",
  "Also look for risks the initial review MISSED entirely — things that",
  "should have been flagged but weren't.",
  "",
  "Respond with JSON only:",
  "{",
  '  "challenges": [',
  "    {",
  '      "finding_index": 0,',
  '      "disproven": false,',
  '      "reason": "Why this finding should or should not stand",',
  '      "suggested_action": "keep" | "downgrade" | "drop",',
  '      "new_severity": "critical" | "high" | "medium" | "low"',
  "    }",
  "  ],",
  '  "missed_risks": [',
  "    {",
  '      "title": "Brief description of missed risk",',
  '      "severity": "critical" | "high" | "medium" | "low",',
  '      "category": "bug" | "security" | "regression" | "test_gap" | "maintainability",',
  '      "reason": "Why this is a real risk the review overlooked"',
  "    }",
  "  ]",
  "}",
  "",
  "Rules:",
  "- You MUST challenge every finding. No free passes.",
  '- "drop" only if you can construct a plausible false-positive scenario.',
  '- "downgrade" if the issue is real but severity is overstated.',
  '- "keep" if the finding stands up to scrutiny (this is fine).',
  "- You MUST suggest at least 0 missed risks (empty array is OK if none found).",
  "- Be honest, not contrarian for its own sake.",
].join("\n");

// ════════════════════════════════════════════════════════════════════════════
// Build the user prompt from findings
// ════════════════════════════════════════════════════════════════════════════

function buildChallengePrompt(findings, prTitle, repoName) {
  var lines = [
    "Challenge these " + findings.length + " findings from the AI review of:",
    "PR: " + prTitle + " in " + repoName,
    "",
  ];

  findings.forEach(function (f, i) {
    lines.push("### Finding #" + i);
    lines.push("- **Title:** " + f.title);
    lines.push("- **Severity:** " + (f.severity || "unknown"));
    lines.push("- **Description:** " + (f.description || f.body || "N/A"));
    if (f.file) lines.push("- **File:** " + f.file + (f.line ? ":" + f.line : ""));
    if (f.suggestion) lines.push("- **Suggestion:** " + f.suggestion);
    lines.push("");
  });

  lines.push("Challenge each finding. Output JSON only.");
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// Run the adversarial challenge
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {Array} findings - Validated findings from initial review
 * @param {object} opts
 * @param {string} opts.prTitle
 * @param {string} opts.repoName
 * @param {string} [opts.model] - Override model (defaults to Haiku)
 * @returns {{ challenges: Array, missedRisks: Array, tokensUsed: number }}
 */
export async function runAdversarialChallenge(findings, opts) {
  if (!findings || findings.length === 0) {
    return { challenges: [], missedRisks: [], tokensUsed: 0 };
  }

  var model = opts.model || ADVERSARIAL_MODEL;
  var userPrompt = buildChallengePrompt(findings, opts.prTitle || "", opts.repoName || "");

  logger.info(
    { findingsCount: findings.length, model },
    "Adversarial review: challenging findings"
  );

  try {
    var message = await anthropic.messages.create({
      model:      model,
      max_tokens: 2048,
      system:     ADVERSARIAL_SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userPrompt }],
    });

    var text = "";
    if (Array.isArray(message.content)) {
      text = message.content
        .filter(function (b) { return b.type === "text"; })
        .map(function (b) { return b.text; })
        .join("\n");
    } else if (typeof message.content === "string") {
      text = message.content;
    }

    var tokens = (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0);

    // Parse JSON response
    var parsed = parseChallengeResponse(text.trim());
    if (!parsed) {
      logger.warn("Adversarial review: could not parse challenge response, keeping all findings");
      return {
        challenges: findings.map(function (_, i) {
          return { finding_index: i, disproven: false, reason: "Parse failure", suggested_action: "keep", new_severity: null };
        }),
        missedRisks: [],
        tokensUsed: tokens,
      };
    }

    logger.info(
      {
        challenged: parsed.challenges.length,
        dropped: parsed.challenges.filter(function (c) { return c.suggested_action === "drop"; }).length,
        downgraded: parsed.challenges.filter(function (c) { return c.suggested_action === "downgrade"; }).length,
        missedRisks: parsed.missed_risks.length,
      },
      "Adversarial review: challenge complete"
    );

    return {
      challenges: parsed.challenges,
      missedRisks: parsed.missed_risks || [],
      tokensUsed: tokens,
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Adversarial review: challenge call failed, keeping all findings");
    return {
      challenges: findings.map(function (_, i) {
        return { finding_index: i, disproven: false, reason: "API error", suggested_action: "keep", new_severity: null };
      }),
      missedRisks: [],
      tokensUsed: 0,
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Parse the challenge JSON response
// ════════════════════════════════════════════════════════════════════════════

function parseChallengeResponse(text) {
  // Try extractReviewJSON cascade from rules package
  var { json } = extractReviewJSON(text);
  if (json && Array.isArray(json.challenges)) {
    return json;
  }

  // Fallback: raw JSON parse
  try {
    var parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.challenges)) return parsed;
  } catch (_e) { /* ignore */ }

  // Fallback: extract from markdown fence
  var fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    try {
      var fenced = JSON.parse(fenceMatch[1]);
      if (fenced && Array.isArray(fenced.challenges)) return fenced;
    } catch (_e) { /* ignore */ }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// Refine findings based on challenge results
// ════════════════════════════════════════════════════════════════════════════

var VALID_SEVERITIES = ["critical", "high", "medium", "low"];
var SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Apply challenge results to the original findings.
 *
 * @param {Array} findings - Original validated findings
 * @param {Array} challenges - Challenge results from adversarial pass
 * @param {Array} missedRisks - New risks discovered by adversarial pass
 * @returns {{ refined: Array, dropped: Array, upheld: Array, missed: Array }}
 */
export function refineFindings(findings, challenges, missedRisks) {
  var dropped = [];
  var upheld = [];
  var refined = [];

  // Build challenge lookup by finding index
  var challengeMap = {};
  challenges.forEach(function (c) {
    if (typeof c.finding_index === "number") {
      challengeMap[c.finding_index] = c;
    }
  });

  findings.forEach(function (finding, index) {
    var challenge = challengeMap[index];

    if (!challenge || challenge.suggested_action === "keep") {
      // Finding survived challenge — boost confidence, mark as upheld
      var updated = Object.assign({}, finding, {
        adversarial_status: "upheld",
        confidence: Math.min(1.0, (finding.confidence || 0.7) + 0.1),
      });

      if (challenge && challenge.reason) {
        updated.adversarial_note = "Challenged but upheld: " + challenge.reason;
      }

      upheld.push(updated);
      refined.push(updated);
    } else if (challenge.suggested_action === "drop") {
      // Finding disproved — remove from active, track for display
      dropped.push(Object.assign({}, finding, {
        adversarial_status: "dropped",
        adversarial_note: challenge.reason || "Disproven by adversarial review",
      }));
    } else if (challenge.suggested_action === "downgrade") {
      // Finding weakened — lower severity
      var newSeverity = (challenge.new_severity && VALID_SEVERITIES.indexOf(challenge.new_severity) !== -1)
        ? challenge.new_severity
        : finding.severity;

      // Ensure downgrade actually lowers (never upgrades)
      if (SEVERITY_ORDER[newSeverity] <= SEVERITY_ORDER[finding.severity]) {
        newSeverity = finding.severity;
      }

      var downgraded = Object.assign({}, finding, {
        severity: newSeverity,
        adversarial_status: "downgraded",
        adversarial_note: "Downgraded from " + finding.severity + ": " + (challenge.reason || "Overstated"),
        confidence: Math.max(0.3, (finding.confidence || 0.7) - 0.2),
      });

      refined.push(downgraded);
    } else {
      // Unknown action — keep as-is
      refined.push(Object.assign({}, finding, { adversarial_status: "kept" }));
    }
  });

  // Add missed risks as new findings
  var missed = (missedRisks || []).map(function (risk) {
    return {
      title: risk.title || "Adversarial discovery",
      severity: (VALID_SEVERITIES.indexOf(risk.severity) !== -1) ? risk.severity : "medium",
      description: risk.reason || "",
      category: risk.category || "bug",
      adversarial_status: "missed_risk",
      adversarial_note: "Discovered by Devil's Advocate pass",
      confidence: 0.6,
    };
  });

  return {
    refined: refined.concat(missed),
    dropped: dropped,
    upheld: upheld,
    missed: missed,
  };
}
