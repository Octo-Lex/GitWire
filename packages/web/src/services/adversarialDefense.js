import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { extractReviewJSON } from "@gitwire/rules";
import { refineFindings } from "./adversarialReview.js";

const anthropic = new Anthropic({
  apiKey:  config.anthropic.apiKey,
  baseURL: config.anthropic.baseURL,
});

// ==============================================================================
// Turn 3: Defense Pass — reviewer responds to Devil's Advocate challenges
// ==============================================================================

const DEFENSE_SYSTEM_PROMPT = [
  "You are the original code reviewer. The Devil's Advocate has challenged",
  "your findings. You must now defend or accept each challenge.",
  "",
  "For each challenge:",
  "- If the challenge raises a valid point you missed, ACCEPT it.",
  "- If the challenge is wrong or your finding is correct, DEFEND it with evidence.",
  "- You may also UPGRADE a finding if the challenge revealed it is worse than you thought.",
  "",
  "Respond with JSON only:",
  "{",
  '  "defenses": [',
  "    {",
  '      "finding_index": 0,',
  '      "action": "accept" | "defend" | "upgrade",',
  '      "reason": "Why you accept the challenge or defend the finding",',
  '      "final_severity": "critical" | "high" | "medium" | "low",',
  '      "final_action": "keep" | "downgrade" | "drop"',
  "    }",
  "  ],",
  '  "additional_missed": [',
  "    {",
  '      "title": "...",',
  '      "severity": "high",',
  '      "category": "security" | "bug" | "regression" | "test_gap" | "maintainability",',
  '      "reason": "..."',
  "    }",
  "  ]",
  "}",
  "",
  "Rules:",
  "- 'accept': The Devil's Advocate was right. Use the challenged action.",
  "- 'defend': Your original finding was correct. Explain WHY with evidence.",
  "- 'upgrade': The challenge made you realize the issue is worse than you thought.",
  "- Be intellectually honest. Accept good challenges, defend genuine findings.",
].join("\n");

function buildDefensePrompt(findings, challenges, prTitle, repoName) {
  var lines = [
    "You reviewed PR: " + prTitle + " in " + repoName,
    "The Devil's Advocate has challenged your " + findings.length + " findings.",
    "Respond to each challenge.",
    "",
  ];

  findings.forEach(function (f, i) {
    var challenge = challenges.find(function (c) { return c.finding_index === i; });
    lines.push("### Finding #" + i + ": " + f.title);
    lines.push("Your severity: " + (f.severity || "unknown"));
    lines.push("Your description: " + (f.description || f.body || "N/A"));
    if (challenge) {
      lines.push("Challenge: " + (challenge.suggested_action || "unknown"));
      lines.push("Challenge reason: " + (challenge.reason || "N/A"));
      if (challenge.new_severity) lines.push("Challenged severity: " + challenge.new_severity);
    } else {
      lines.push("No challenge for this finding.");
    }
    lines.push("");
  });

  lines.push("Defend or accept each challenge. Output JSON only.");
  return lines.join("\n");
}

/**
 * Run the defense pass (Turn 3).
 * The original reviewer responds to each challenge from the Devil's Advocate.
 *
 * @param {Array} findings - Original findings from initial review
 * @param {Array} challenges - Challenges from adversarial pass
 * @param {object} opts
 * @returns {{ defenses: Array, additionalMissed: Array, tokensUsed: number }}
 */
export async function runDefensePass(findings, challenges, opts) {
  if (!findings || findings.length === 0 || !challenges || challenges.length === 0) {
    return {
      defenses: findings.map(function (_, i) {
        return { finding_index: i, action: "defend", reason: "No challenges to respond to", final_severity: null, final_action: "keep" };
      }),
      additionalMissed: [],
      tokensUsed: 0,
    };
  }

  var model = opts.model || "claude-haiku-4-20250414";
  var userPrompt = buildDefensePrompt(findings, challenges, opts.prTitle || "", opts.repoName || "");

  logger.info(
    { findingsCount: findings.length, challengesCount: challenges.length, model },
    "Adversarial review: defense pass (turn 3)"
  );

  try {
    var message = await anthropic.messages.create({
      model:      model,
      max_tokens: 2048,
      system:     DEFENSE_SYSTEM_PROMPT,
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

    // Parse defense response (uses "defenses" key)
    var parsed = null;
    var { json } = extractReviewJSON(text.trim());
    if (json && Array.isArray(json.defenses)) {
      parsed = json;
    }
    if (!parsed) {
      try { parsed = JSON.parse(text.trim()); } catch (_e) { /* ignore */ }
    }

    if (!parsed || !Array.isArray(parsed.defenses)) {
      logger.warn("Adversarial review: could not parse defense response, keeping challenge results");
      return {
        defenses: challenges,
        additionalMissed: [],
        tokensUsed: tokens,
      };
    }

    logger.info(
      {
        defended: parsed.defenses.filter(function (d) { return d.action === "defend" || d.action === "upgrade"; }).length,
        accepted: parsed.defenses.filter(function (d) { return d.action === "accept"; }).length,
        additionalMissed: (parsed.additional_missed || []).length,
      },
      "Adversarial review: defense pass complete (turn 3)"
    );

    return {
      defenses: parsed.defenses,
      additionalMissed: parsed.additional_missed || [],
      tokensUsed: tokens,
    };
  } catch (err) {
    logger.warn({ err: err.message }, "Adversarial review: defense pass failed, keeping challenge results");
    return {
      defenses: challenges,
      additionalMissed: [],
      tokensUsed: 0,
    };
  }
}

/**
 * Merge defense results with challenge results to produce final findings.
 *
 * @param {Array} findings - Original findings
 * @param {Array} challenges - Turn 2 challenges
 * @param {Array} defenses - Turn 3 defense responses
 * @param {Array} missedRisks - Turn 2 missed risks
 * @param {Array} additionalMissed - Turn 3 additional missed risks
 * @returns {{ refined: Array, dropped: Array, upheld: Array, missed: Array }}
 */
export function refineWithDefense(findings, challenges, defenses, missedRisks, additionalMissed) {
  // Build defense lookup
  var defenseMap = {};
  (defenses || []).forEach(function (d) {
    if (typeof d.finding_index === "number") {
      defenseMap[d.finding_index] = d;
    }
  });

  // Convert defense results into challenge overrides
  var finalChallenges = challenges.map(function (challenge, i) {
    var defense = defenseMap[i];
    if (!defense) return challenge;

    if (defense.action === "accept") {
      return Object.assign({}, challenge, { defense_action: "accepted" });
    } else if (defense.action === "defend") {
      return {
        finding_index: i,
        disproven: false,
        reason: (challenge.reason || "") + " | Reviewer defended: " + (defense.reason || ""),
        suggested_action: defense.final_action || "keep",
        new_severity: defense.final_severity || null,
        defense_action: "defended",
      };
    } else if (defense.action === "upgrade") {
      return {
        finding_index: i,
        disproven: false,
        reason: (challenge.reason || "") + " | Reviewer upgraded: " + (defense.reason || ""),
        suggested_action: "keep",
        new_severity: null,
        defense_action: "upgraded",
      };
    }
    return challenge;
  });

  var allMissed = (missedRisks || []).concat(additionalMissed || []);

  return refineFindings(findings, finalChallenges, allMissed);
}
