// @gitwire/rules — helpers.js
// Query helpers for resolved config objects.

import { DEFAULT_CONFIG } from "./schema.js";
import { evaluateExpr } from "./expr/index.js";

/**
 * Check if a pillar is enabled in the given config.
 * Returns true by default (missing enabled = true) unless explicitly false.
 */
export function isPillarEnabled(pillar, config) {
  return config?.pillars?.[pillar]?.enabled !== false;
}

/**
 * Check if dry-run mode is enabled.
 * When true, workers log what they would do but skip all mutations.
 */
export function isDryRun(config) {
  return config?.settings?.dry_run === true;
}

/**
 * Check if a file path is allowed for CI healing patching.
 * Blocked patterns take precedence over allowed patterns.
 */
export function isFileAllowed(filePath, config) {
  const ci = config?.pillars?.ci_healing || {};
  const blocked = ci.blocked_file_patterns || [];
  const allowed = ci.allowed_file_patterns || ["**"];

  // Blocked (denylist) wins
  for (const pattern of blocked) {
    if (matchGlob(filePath, pattern)) return false;
  }

  // Then check allowed
  for (const pattern of allowed) {
    if (matchGlob(filePath, pattern)) return true;
  }

  return false;
}

/**
 * Check if a file path is in the blocked-paths list for issue_fix.
 */
export function isFixPathBlocked(filePath, config) {
  const blocked = config?.pillars?.issue_fix?.blocked_paths || [];
  return blocked.some((p) => matchGlob(filePath, p));
}

/**
 * Check if an issue label qualifies for autonomous fixing.
 */
export function isFixLabelAllowed(label, config) {
  const allowed = config?.pillars?.issue_fix?.allowed_labels || [];
  return allowed
    .map((l) => l.toLowerCase())
    .includes(label.toLowerCase());
}

/**
 * Get stale config for a given item type (issues or prs).
 */
export function getStaleConfig(type, config) {
  const stale = config?.pillars?.maintainer?.stale || {};
  return stale[type] || {};
}

/**
 * Check if an item is exempt from stale management by label.
 */
export function isStaleExempt(labels, type, config) {
  const staleConfig = getStaleConfig(type, config);
  const exempt = staleConfig.exempt_labels || [];
  return labels.some((l) => exempt.includes(l));
}

// ── Glob matching ────────────────────────────────────────────────────────────
// Supports *, **, and simple literal matching.
// NOT a full glob implementation — good enough for file path patterns.

export function matchGlob(str, pattern) {
  // Convert glob pattern to regex
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // ** matches any path including /
      if (pattern[i + 2] === "/") {
        regex += "(?:.*/)?";
        i += 3;
      } else {
        regex += ".*";
        i += 2;
      }
    } else if (pattern[i] === "*") {
      // * matches anything except /
      regex += "[^/]*";
      i++;
    } else if (pattern[i] === "?") {
      regex += "[^/]";
      i++;
    } else {
      regex += escapeRegex(pattern[i]);
      i++;
    }
  }

  return new RegExp("^" + regex + "$").test(str);
}

function escapeRegex(char) {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Confidence / Risk scoring ─────────────────────────────────────────────────

const CONFIDENCE_LEVELS = { low: 1, medium: 2, high: 3 };

/**
 * Compare two confidence levels. Returns true if actual >= required.
 */
export function meetsConfidence(actual, required) {
  const a = CONFIDENCE_LEVELS[actual] || 0;
  const r = CONFIDENCE_LEVELS[required] || 0;
  return a >= r;
}

/**
 * Get the minimum confidence threshold for CI healing patches.
 * Returns the configured level or "medium" by default.
 */
export function getMinPatchConfidence(config) {
  return config?.pillars?.ci_healing?.min_confidence_to_patch || "medium";
}

/**
 * Get the minimum confidence threshold for issue fix PR submission.
 * Returns the configured level or "medium" by default.
 */
export function getMinFixConfidence(config) {
  return config?.pillars?.issue_fix?.min_confidence_to_submit || "medium";
}

/**
 * Compute a composite risk score from a CI diagnosis.
 * Returns { score: 0-100, level: "low"|"medium"|"high", reasons: string[] }
 */
export function scoreCIRisk(diagnosis) {
  let score = 0;
  const reasons = [];

  // Confidence inverted (low confidence = high risk)
  const conf = diagnosis.confidence || "medium";
  if (conf === "low") { score += 40; reasons.push("Low AI confidence"); }
  else if (conf === "medium") { score += 15; reasons.push("Medium AI confidence"); }
  else { reasons.push("High AI confidence"); }

  // Failure type risk
  const HIGH_RISK_TYPES = ["infra_error", "build_error", "unknown"];
  const SAFE_TYPES = ["lint_error", "format_error", "type_error"];
  if (HIGH_RISK_TYPES.includes(diagnosis.failure_type)) {
    score += 30; reasons.push("High-risk failure type: " + diagnosis.failure_type);
  } else if (SAFE_TYPES.includes(diagnosis.failure_type)) {
    reasons.push("Safe failure type: " + diagnosis.failure_type);
  } else {
    score += 15; // test_flaky, test_permanent, dependency_missing
  }

  // No file identified = higher risk
  if (!diagnosis.failing_file) {
    score += 20; reasons.push("No failing file identified");
  }

  // Auto-fixable flag
  if (diagnosis.auto_fixable === false) {
    score += 30; reasons.push("AI flagged as not auto-fixable");
  }

  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score: Math.min(score, 100), level, reasons };
}

/**
 * Compute a composite risk score for an issue fix.
 * Returns { score: 0-100, level: "low"|"medium"|"high", reasons: string[] }
 */
export function scoreFixRisk(analysis, fixes, originalFiles) {
  let score = 0;
  const reasons = [];

  // Complexity
  const complexity = analysis.complexity || "moderate";
  if (complexity === "complex") { score += 40; reasons.push("Complex issue"); }
  else if (complexity === "moderate") { score += 20; reasons.push("Moderate complexity"); }
  else if (complexity === "trivial") { reasons.push("Trivial fix"); }
  else { reasons.push("Simple fix"); }

  // Number of files changed
  if (fixes.length > 3) { score += 20; reasons.push(fixes.length + " files changed"); }

  // Line delta check
  for (const fix of fixes) {
    const orig = originalFiles.find(f => f.path === fix.path);
    if (orig) {
      const origLines = orig.content.split("\n").length;
      const fixLines = fix.fixed_content.split("\n").length;
      const delta = Math.abs(fixLines - origLines);
      if (delta > origLines * 0.3 && origLines > 10) {
        score += 15; reasons.push(fix.path + ": " + Math.round(delta / origLines * 100) + "% lines changed");
      }
    }
  }

  const level = score >= 50 ? "high" : score >= 25 ? "medium" : "low";
  return { score: Math.min(score, 100), level, reasons };
}

// ── Trigger control ────────────────────────────────────────────────────────────

/**
 * Check if a trigger context matches the pillar's trigger filters.
 * Returns true if the pillar should fire for this context.
 *
 * @param {string} pillar - pillar name (e.g., 'ci_healing')
 * @param {object} context - { branch?: string, author?: string, paths?: string[] }
 * @param {object} config - resolved config object
 * @returns {boolean} true = should trigger, false = filtered out
 */
export function shouldTrigger(pillar, context, config) {
  const triggers = config?.pillars?.[pillar]?.triggers;
  if (!triggers) return true; // no triggers config = always active

  // Branch filter — if specified, branch must match at least one pattern
  if (triggers.branches?.length > 0) {
    const branch = context.branch || "";
    if (!triggers.branches.some((p) => matchGlob(branch, p))) return false;
  }

  // Author ignore list — if author matches any pattern, skip
  if (triggers.ignore_authors?.length > 0) {
    const author = context.author || "";
    if (triggers.ignore_authors.some((p) => matchGlob(author, p))) return false;
  }

  // Path filter — if specified, at least one changed path must match
  if (triggers.paths?.length > 0 && context.paths?.length > 0) {
    const hasMatch = context.paths.some((fp) =>
      triggers.paths.some((p) => matchGlob(fp, p))
    );
    if (!hasMatch) return false;
  }

  return true;
}

// ── Custom rules evaluation ───────────────────────────────────────────────────

/**
 * Evaluate all custom rules in a config against a context.
 * Returns an array of { name, actions } for rules whose `if` condition is true.
 *
 * @param {object} context — event context (author, files, branch, labels, etc.)
 * @param {object} config — resolved config with custom_rules and expressions
 * @param {object} [plugins] — custom filter functions from .gitwire/plugins/
 * @returns {Array<{name: string, actions: Array}>} matched rules with their run actions
 */
export function evaluateRules(context, config, plugins) {
  const rules = config?.custom_rules;
  if (!rules || typeof rules !== "object") return [];

  // Build expression context — merge named expressions into context
  // Named expressions like `is.docs` get resolved first
  const exprContext = { ...context };
  const expressions = config?.expressions || {};

  // Resolve named expression groups (e.g., is.docs, is.security)
  for (const [groupName, group] of Object.entries(expressions)) {
    if (typeof group === "object" && group !== null) {
      exprContext[groupName] = {};
      for (const [key, expr] of Object.entries(group)) {
        try {
          exprContext[groupName][key] = evaluateExpr(expr, context, plugins);
        } catch (_e) {
          // Failed named expression resolves to undefined
          exprContext[groupName][key] = undefined;
        }
      }
    } else if (typeof group === "string") {
      // Top-level named expression
      try {
        exprContext[groupName] = evaluateExpr(group, context, plugins);
      } catch (_e) {
        exprContext[groupName] = undefined;
      }
    }
  }

  // Evaluate each rule
  const matched = [];
  for (const [ruleName, rule] of Object.entries(rules)) {
    if (!rule || typeof rule.if !== "string") continue;

    try {
      const result = evaluateExpr(rule.if, exprContext, plugins);
      if (result) {
        matched.push({
          name: ruleName,
          actions: rule.run || [],
        });
      }
    } catch (_e) {
      // Rule evaluation failure = skip (don't block other rules)
    }
  }

  return matched;
}
