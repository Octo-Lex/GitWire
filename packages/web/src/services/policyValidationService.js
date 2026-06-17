// src/services/policyValidationService.js
// Non-mutating .gitwire.yml policy validation.
//
// Accepts raw YAML text, parses with @gitwire/rules, and produces a structured
// response with:
//   - Structural validity (valid/errors)
//   - Warnings (risky combinations, unsafe defaults)
//   - Enabled pillars list
//   - Dry-run detection
//   - Risky settings analysis
//   - Normalized config (merged with defaults)
//
// This service never writes config or mutates GitHub.

import { parseConfig, DEFAULT_CONFIG, validateConfig } from "@gitwire/rules";
import { redactSecrets } from "../lib/redact.js";
import { logger } from "../lib/logger.js";

/**
 * Validate a .gitwire.yml policy string.
 *
 * @param {string} yamlText - raw YAML content
 * @returns {Promise<object>} structured validation result
 */
export async function validatePolicy(yamlText) {
  const errors = [];
  const warnings = [];
  let config = null;
  let normalizedConfig = null;

  // Step 1: Parse YAML
  try {
    config = parseConfig(yamlText || "");
  } catch (err) {
    // parseConfig throws on invalid shape (after YAML parse)
    // Try to distinguish YAML syntax errors from structural validation errors
    const msg = err.message || "Unknown parse error";
    if (msg.includes("Invalid .gitwire.yml:")) {
      // Structural validation errors from validateConfig
      const errorList = msg.replace(/^Invalid \.gitwire\.yml:\s*/, "").split("; ");
      for (const e of errorList) {
        if (e.trim()) errors.push({ path: "*", severity: "error", message: e.trim() });
      }
    } else {
      // YAML syntax error
      errors.push({ path: "*", severity: "error", message: msg });
    }

    return {
      valid: false,
      errors,
      warnings: [],
      enabled_pillars: [],
      dry_run: false,
      risky_settings: [],
      normalized_config: null,
      parsed_at: new Date().toISOString(),
    };
  }

  // Step 2: Structural validation (redundant with parseConfig but catches edge cases)
  const validation = validateConfig(config);
  if (!validation.valid) {
    for (const e of validation.errors) {
      errors.push({ path: "*", severity: "error", message: e });
    }
  }

  // Step 3: Normalize (merge with defaults)
  normalizedConfig = config;

  // Step 4: Analyze
  const enabledPillars = getEnabledPillars(normalizedConfig);
  const dryRun = getDryRun(normalizedConfig);
  const riskySettings = analyzeRiskySettings(normalizedConfig, dryRun);
  const policyWarnings = generateWarnings(normalizedConfig, dryRun, enabledPillars);

  // Step 5: Redact any secret-like values from normalized config
  const redactedConfig = redactSecrets(normalizedConfig);

  // Step 6: Detect unknown/deprecated keys
  const knownPillars = Object.keys(DEFAULT_CONFIG.pillars);
  const userPillars = Object.keys(normalizedConfig.pillars || {});
  for (const pillar of userPillars) {
    if (!knownPillars.includes(pillar)) {
      warnings.push({
        path: "pillars." + pillar,
        severity: "warning",
        message: "Unknown pillar '" + pillar + "' — will be ignored (allowed for forward compatibility)",
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [...policyWarnings, ...warnings],
    enabled_pillars: enabledPillars,
    dry_run: dryRun,
    risky_settings: riskySettings,
    normalized_config: redactedConfig,
    parsed_at: new Date().toISOString(),
  };
}

/**
 * Extract the list of enabled pillars from a resolved config.
 */
function getEnabledPillars(config) {
  const pillars = config.pillars || {};
  return Object.entries(pillars)
    .filter(([, val]) => val?.enabled !== false)
    .map(([key]) => key);
}

/**
 * Check if dry-run mode is active.
 */
function getDryRun(config) {
  return config.settings?.dry_run === true;
}

/**
 * Identify settings that carry operational risk.
 *
 * Risk categories:
 * - Destructive: Can modify repository files (issue_fix, ci_healing.auto_patch)
 * - Auto-close: Can close issues/PRs (spam_gate, maintainer stale close_days)
 * - Unbounded: No limits or guards configured
 */
function analyzeRiskySettings(config, dryRun) {
  const risky = [];
  const pillars = config.pillars || {};

  // issue_fix is destructive by design
  if (pillars.issue_fix?.enabled === true) {
    risky.push({
      path: "pillars.issue_fix.enabled",
      reason: "Issue fixing can modify repository files autonomously",
      severity: "high",
      mitigated_by_dry_run: dryRun,
    });
  }

  // ci_healing.auto_patch creates PRs
  if (pillars.ci_healing?.enabled !== false && pillars.ci_healing?.auto_patch === true) {
    risky.push({
      path: "pillars.ci_healing.auto_patch",
      reason: "Auto-patching opens PRs with AI-generated code fixes",
      severity: "medium",
      mitigated_by_dry_run: dryRun,
    });
  }

  // spam_gate auto-closes items
  if (pillars.spam_gate?.enabled === true) {
    risky.push({
      path: "pillars.spam_gate.enabled",
      reason: "Spam gate auto-closes issues and PRs from high-volume authors",
      severity: "high",
      mitigated_by_dry_run: dryRun,
    });
  }

  // maintainer stale auto-close
  const staleIssuesClose = pillars.maintainer?.stale?.issues?.close_days;
  if (staleIssuesClose && typeof staleIssuesClose === "number" && staleIssuesClose > 0) {
    risky.push({
      path: "pillars.maintainer.stale.issues.close_days",
      reason: "Stale issues will be auto-closed after " + staleIssuesClose + " days",
      severity: "medium",
      mitigated_by_dry_run: dryRun,
    });
  }

  const stalePrsClose = pillars.maintainer?.stale?.prs?.close_days;
  if (stalePrsClose && typeof stalePrsClose === "number" && stalePrsClose > 0) {
    risky.push({
      path: "pillars.maintainer.stale.prs.close_days",
      reason: "Stale PRs will be auto-closed after " + stalePrsClose + " days",
      severity: "medium",
      mitigated_by_dry_run: dryRun,
    });
  }

  // merge_queue without required checks
  if (pillars.merge_queue?.enabled === true) {
    const requiredChecks = pillars.merge_queue?.required_checks || [];
    if (requiredChecks.length === 0) {
      risky.push({
        path: "pillars.merge_queue.required_checks",
        reason: "Merge queue is enabled but has no required checks configured",
        severity: "medium",
        mitigated_by_dry_run: dryRun,
      });
    }
  }

  // ai_review with adversarial_review disabled
  if (pillars.ai_review?.enabled !== false && pillars.ai_review?.adversarial_review === false) {
    risky.push({
      path: "pillars.ai_review.adversarial_review",
      reason: "AI review adversarial filtering is disabled — may produce more false positives",
      severity: "low",
      mitigated_by_dry_run: false, // Not mitigated by dry-run
    });
  }

  return risky;
}

/**
 * Generate human-readable warnings for risky combinations.
 */
function generateWarnings(config, dryRun, enabledPillars) {
  const warnings = [];
  const pillars = config.pillars || {};

  // Auto-patching without dry-run
  if (!dryRun && pillars.ci_healing?.enabled !== false && pillars.ci_healing?.auto_patch === true) {
    warnings.push({
      path: "pillars.ci_healing.auto_patch",
      severity: "warning",
      message: "Auto-patching is enabled while dry_run is false. AI-generated fix PRs will be created without a safety net.",
    });
  }

  // issue_fix without dry-run
  if (!dryRun && pillars.issue_fix?.enabled === true) {
    warnings.push({
      path: "pillars.issue_fix.enabled",
      severity: "warning",
      message: "Autonomous issue fixing is enabled while dry_run is false. GitWire will create PRs with code changes.",
    });
  }

  // spam_gate without dry-run
  if (!dryRun && pillars.spam_gate?.enabled === true) {
    warnings.push({
      path: "pillars.spam_gate.enabled",
      severity: "warning",
      message: "Spam gate is enabled while dry_run is false. Issues and PRs will be auto-closed.",
    });
  }

  // Very high max_fix_attempts
  const maxAttempts = pillars.ci_healing?.max_fix_attempts;
  if (typeof maxAttempts === "number" && maxAttempts > 5) {
    warnings.push({
      path: "pillars.ci_healing.max_fix_attempts",
      severity: "warning",
      message: "max_fix_attempts is set to " + maxAttempts + " — consider lowering to 3-5 to avoid excessive API usage.",
    });
  }

  // Low min_confidence_to_submit
  const minConfidence = pillars.issue_fix?.min_confidence_to_submit;
  if (minConfidence === "low") {
    warnings.push({
      path: "pillars.issue_fix.min_confidence_to_submit",
      severity: "warning",
      message: "min_confidence_to_submit is set to 'low' — PRs with low-confidence fixes will be submitted. Consider 'medium' or 'high'.",
    });
  }

  // No blocked_file_patterns on ci_healing
  const blockedPatterns = pillars.ci_healing?.blocked_file_patterns;
  if (pillars.ci_healing?.enabled !== false && pillars.ci_healing?.auto_patch === true) {
    if (!blockedPatterns || blockedPatterns.length === 0) {
      warnings.push({
        path: "pillars.ci_healing.blocked_file_patterns",
        severity: "warning",
        message: "ci_healing.auto_patch is enabled but blocked_file_patterns is empty. Consider blocking sensitive files (.env, secrets, *.pem).",
      });
    }
  }

  // Many pillars enabled without dry-run
  if (!dryRun && enabledPillars.length >= 6) {
    warnings.push({
      path: "settings.dry_run",
      severity: "info",
      message: enabledPillars.length + " pillars are enabled while dry_run is false. Consider enabling dry_run for initial rollout.",
    });
  }

  return warnings;
}
