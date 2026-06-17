// src/services/policyRecommendationService.js
// Deterministic, rule-based guardrail recommendations.
//
// Generates actionable suggestions from proposed policy validation, risk
// analysis, simulation results, and diff impact. No AI — all rules are
// deterministic and explainable for v0.16.0.
//
// This service never writes config or mutates GitHub.

import { logger } from "../lib/logger.js";
import { parseConfig, validateConfig } from "@gitwire/rules";
import { isPillarEnabled, isDryRun } from "@gitwire/rules";
import { validatePolicy } from "./policyValidationService.js";

// ── Recommendation IDs ───────────────────────────────────────────────────────
//
// Stable string identifiers so dashboards can deduplicate / suppress.
const REC = {
  DRY_RUN_FOR_RISKY: "enable-dry-run-for-risky-policy",
  DRY_RUN_FOR_NEW: "enable-dry-run-for-new-risky-policy",
  DRY_RUN_REMOVED: "keep-dry-run-during-rollout",
  NEWLY_PERMISSIVE: "narrow-triggers-or-dry-run-for-newly-permissive",
  BROAD_TRIGGERS: "add-trigger-filters-for-mutating-pillar",
  HIGH_LIMIT_ISSUE_FIX: "lower-issue-fix-limits",
  HIGH_LIMIT_CI_HEAL: "lower-ci-heal-limits",
  AUTO_PATCH_UNCONSTRAINED: "constrain-auto-patch-paths",
  ISSUE_FIX_UNCONSTRAINED: "constrain-issue-fix-scope",
  MERGE_QUEUE_NO_CHECKS: "require-branch-protection-for-merge-queue",
  NO_RECOMMENDATIONS: "no-recommendations",
};

// ── Pillars that mutate GitHub ───────────────────────────────────────────────
const MUTATING_PILLARS = new Set([
  "triage",
  "ci_healing",
  "issue_fix",
  "merge_queue",
  "enforcement",
  "maintainer",
]);

// ── Thresholds ───────────────────────────────────────────────────────────────
const LIMIT_THRESHOLDS = {
  issue_fix_max_files: 10,
  issue_fix_max_attempts: 3,
  ci_heal_max_files: 8,
  ci_heal_max_attempts: 3,
};

/**
 * Generate deterministic guardrail recommendations for a proposed policy.
 *
 * @param {object} params
 * @param {string} params.yaml                 - proposed .gitwire.yml (required)
 * @param {string} [params.repo]               - repo full_name (optional, enables diff-aware recs)
 * @param {object} [params.diffImpact]         - precomputed diff impact (optional)
 * @returns {Promise<object>} recommendations result
 */
export async function recommendGuardrails(params = {}) {
  const { yaml: yamlText, repo, diffImpact } = params;

  if (!yamlText) throw new Error("yaml is required");

  // Step 1: Parse + validate proposed policy
  let proposedConfig;
  try {
    proposedConfig = parseConfig(yamlText);
  } catch (err) {
    return {
      generated_at: new Date().toISOString(),
      repo: repo || null,
      summary: { critical: 0, warning: 0, info: 0 },
      recommendations: [],
      error: "Invalid proposed policy — cannot recommend",
    };
  }

  const validation = validateConfig(proposedConfig);
  if (!validation.valid) {
    return {
      generated_at: new Date().toISOString(),
      repo: repo || null,
      summary: { critical: 0, warning: 0, info: 0 },
      recommendations: [],
      error: "Invalid proposed policy — cannot recommend",
    };
  }

  const analysis = await validatePolicy(yamlText);
  const dryRun = isDryRun(proposedConfig);
  const enabledPillars = getEnabledPillars(proposedConfig);
  const risks = analysis.risky_settings || [];
  const unmitigatedRisks = risks.filter(r => !r.mitigated_by_dry_run);

  const recs = [];

  // ── Rule: Dry-run disabled + risky settings ──────────────────────────────
  if (!dryRun && risks.length > 0) {
    recs.push({
      id: REC.DRY_RUN_FOR_RISKY,
      severity: risks.some(r => r.severity === "high") ? "critical" : "warning",
      category: "dry_run",
      path: "dry_run",
      title: "Enable dry-run before applying risky policy",
      reason: `Policy has ${risks.length} risky setting(s) and dry_run is disabled.`,
      suggested_change: "Set dry_run: true for the first rollout.",
      evidence: {
        dry_run: false,
        risk_count: risks.length,
        risks: risks.map(r => r.path),
      },
    });
  }

  // ── Rule: Dry-run disabled + newly enabled pillars ───────────────────────
  const newlyEnabled = enabledPillars.filter(p => {
    // Heuristic: if diffImpact provides current enabled pillars, use it.
    if (diffImpact?.current?.enabled_pillars) {
      return !diffImpact.current.enabled_pillars.includes(p);
    }
    return false;
  });

  if (!dryRun && newlyEnabled.length > 0) {
    recs.push({
      id: REC.DRY_RUN_FOR_NEW,
      severity: "critical",
      category: "dry_run",
      path: "dry_run",
      title: "Enable dry-run for newly enabled pillars",
      reason: `Proposed policy enables ${newlyEnabled.length} new pillar(s) without dry-run: ${newlyEnabled.join(", ")}.`,
      suggested_change: "Set dry_run: true until new pillars are validated.",
      evidence: {
        newly_enabled: newlyEnabled,
        dry_run: false,
      },
    });
  }

  // ── Rule: Dry-run removed (from diff) ────────────────────────────────────
  if (diffImpact?.changes?.dry_run && diffImpact.changes.dry_run.from === true && diffImpact.changes.dry_run.to === false) {
    recs.push({
      id: REC.DRY_RUN_REMOVED,
      severity: "critical",
      category: "dry_run",
      path: "dry_run",
      title: "Dry-run removed — keep it during rollout",
      reason: "Proposed policy removes dry-run protection. Newly active mutations will execute immediately.",
      suggested_change: "Keep dry_run: true until simulation results are reviewed.",
      evidence: {
        dry_run_from: true,
        dry_run_to: false,
      },
    });
  }

  // ── Rule: Newly permissive behavior (from diff) ──────────────────────────
  if (diffImpact?.simulation_impact && diffImpact.simulation_impact.newly_would_act > 0) {
    recs.push({
      id: REC.NEWLY_PERMISSIVE,
      severity: "warning",
      category: "scope",
      path: "triggers",
      title: "Newly permissive behavior detected",
      reason: `Proposed policy would act on ${diffImpact.simulation_impact.newly_would_act} historical event(s) that the current policy would not.`,
      suggested_change: "Narrow trigger filters or enable dry-run before rollout.",
      evidence: {
        newly_would_act: diffImpact.simulation_impact.newly_would_act,
      },
    });
  }

  // ── Rule: Broad triggers for mutating pillars ────────────────────────────
  for (const pillar of enabledPillars) {
    if (!MUTATING_PILLARS.has(pillar)) continue;

    const trigger = getTriggerFilter(proposedConfig, pillar);
    if (!trigger || isBroadTrigger(trigger)) {
      recs.push({
        id: REC.BROAD_TRIGGERS,
        severity: "warning",
        category: "triggers",
        path: `pillars.${pillar}.triggers`,
        title: `Broad triggers for ${pillar}`,
        reason: `Mutating pillar "${pillar}" has empty or permissive trigger filters.`,
        suggested_change: `Add branch/author/path filters to pillars.${pillar}.triggers.`,
        evidence: {
          pillar,
          current_trigger: trigger || "none",
        },
      });
    }
  }

  // ── Rule: High issue-fix limits ──────────────────────────────────────────
  const issueFix = getPillarConfig(proposedConfig, "issue_fix");
  if (issueFix?.enabled) {
    const maxFiles = issueFix.max_files ?? issueFix.maxFiles;
    const maxAttempts = issueFix.max_attempts ?? issueFix.maxAttempts;
    if (maxFiles && maxFiles > LIMIT_THRESHOLDS.issue_fix_max_files) {
      recs.push({
        id: REC.HIGH_LIMIT_ISSUE_FIX,
        severity: "warning",
        category: "limits",
        path: "pillars.issue_fix.max_files",
        title: "High issue-fix file limit",
        reason: `issue_fix.max_files is ${maxFiles} (threshold: ${LIMIT_THRESHOLDS.issue_fix_max_files}).`,
        suggested_change: `Lower max_files to ${LIMIT_THRESHOLDS.issue_fix_max_files} or fewer.`,
        evidence: { current: maxFiles, threshold: LIMIT_THRESHOLDS.issue_fix_max_files },
      });
    }
    if (maxAttempts && maxAttempts > LIMIT_THRESHOLDS.issue_fix_max_attempts) {
      recs.push({
        id: REC.HIGH_LIMIT_ISSUE_FIX,
        severity: "warning",
        category: "limits",
        path: "pillars.issue_fix.max_attempts",
        title: "High issue-fix attempt limit",
        reason: `issue_fix.max_attempts is ${maxAttempts} (threshold: ${LIMIT_THRESHOLDS.issue_fix_max_attempts}).`,
        suggested_change: `Lower max_attempts to ${LIMIT_THRESHOLDS.issue_fix_max_attempts} or fewer.`,
        evidence: { current: maxAttempts, threshold: LIMIT_THRESHOLDS.issue_fix_max_attempts },
      });
    }
  }

  // ── Rule: High CI-heal limits ────────────────────────────────────────────
  const ciHeal = getPillarConfig(proposedConfig, "ci_healing");
  if (ciHeal?.enabled) {
    const maxFiles = ciHeal.max_files ?? ciHeal.maxFiles;
    const maxAttempts = ciHeal.max_attempts ?? ciHeal.maxAttempts;
    if (maxFiles && maxFiles > LIMIT_THRESHOLDS.ci_heal_max_files) {
      recs.push({
        id: REC.HIGH_LIMIT_CI_HEAL,
        severity: "warning",
        category: "limits",
        path: "pillars.ci_healing.max_files",
        title: "High CI-heal file limit",
        reason: `ci_healing.max_files is ${maxFiles} (threshold: ${LIMIT_THRESHOLDS.ci_heal_max_files}).`,
        suggested_change: `Lower max_files to ${LIMIT_THRESHOLDS.ci_heal_max_files} or fewer.`,
        evidence: { current: maxFiles, threshold: LIMIT_THRESHOLDS.ci_heal_max_files },
      });
    }
    if (maxAttempts && maxAttempts > LIMIT_THRESHOLDS.ci_heal_max_attempts) {
      recs.push({
        id: REC.HIGH_LIMIT_CI_HEAL,
        severity: "warning",
        category: "limits",
        path: "pillars.ci_healing.max_attempts",
        title: "High CI-heal attempt limit",
        reason: `ci_healing.max_attempts is ${maxAttempts} (threshold: ${LIMIT_THRESHOLDS.ci_heal_max_attempts}).`,
        suggested_change: `Lower max_attempts to ${LIMIT_THRESHOLDS.ci_heal_max_attempts} or fewer.`,
        evidence: { current: maxAttempts, threshold: LIMIT_THRESHOLDS.ci_heal_max_attempts },
      });
    }
  }

  // ── Rule: Auto-patch enabled without constraints ─────────────────────────
  if (ciHeal?.enabled && ciHeal?.auto_patch === true) {
    const paths = ciHeal.paths || ciHeal.allowed_paths;
    if (!paths || paths.length === 0) {
      recs.push({
        id: REC.AUTO_PATCH_UNCONSTRAINED,
        severity: dryRun ? "info" : "warning",
        category: "scope",
        path: "pillars.ci_healing.auto_patch",
        title: "Auto-patch enabled without path constraints",
        reason: "ci_healing.auto_patch is enabled but no path filters are set.",
        suggested_change: "Add allowed_paths or enable dry-run.",
        evidence: { auto_patch: true, paths: paths || [] },
      });
    }
  }

  // ── Rule: Issue-fix enabled without scope constraints ────────────────────
  if (issueFix?.enabled) {
    const labels = issueFix.labels || issueFix.allowed_labels;
    const paths = issueFix.paths || issueFix.allowed_paths;
    if ((!labels || labels.length === 0) && (!paths || paths.length === 0)) {
      recs.push({
        id: REC.ISSUE_FIX_UNCONSTRAINED,
        severity: dryRun ? "info" : "warning",
        category: "scope",
        path: "pillars.issue_fix",
        title: "Issue-fix enabled without scope constraints",
        reason: "issue_fix is enabled but no label or path filters are set.",
        suggested_change: "Add allowed_labels or allowed_paths, or enable dry-run.",
        evidence: { labels: labels || [], paths: paths || [] },
      });
    }
  }

  // ── Rule: Merge queue enabled without required checks ────────────────────
  const mergeQueue = getPillarConfig(proposedConfig, "merge_queue");
  if (mergeQueue?.enabled) {
    const checks = mergeQueue.required_checks || mergeQueue.checks;
    if (!checks || checks.length === 0) {
      recs.push({
        id: REC.MERGE_QUEUE_NO_CHECKS,
        severity: "warning",
        category: "safety",
        path: "pillars.merge_queue.required_checks",
        title: "Merge queue enabled without required checks",
        reason: "merge_queue is enabled but no required CI checks are configured.",
        suggested_change: "Add required_checks (e.g., ['ci', 'lint']) before enabling merge queue.",
        evidence: { checks: checks || [] },
      });
    }
  }

  // ── Rule: No risks / no recommendations ──────────────────────────────────
  if (recs.length === 0) {
    recs.push({
      id: REC.NO_RECOMMENDATIONS,
      severity: "info",
      category: "safety",
      path: null,
      title: "No high-risk guardrail changes recommended",
      reason: "Policy is valid, risks are mitigated by dry-run, triggers are scoped, and limits are within thresholds.",
      suggested_change: null,
      evidence: {
        valid: true,
        dry_run: dryRun,
        enabled_pillars: enabledPillars,
        risk_count: risks.length,
      },
    });
  }

  const summary = {
    critical: recs.filter(r => r.severity === "critical").length,
    warning: recs.filter(r => r.severity === "warning").length,
    info: recs.filter(r => r.severity === "info").length,
  };

  return {
    generated_at: new Date().toISOString(),
    repo: repo || null,
    summary,
    recommendations: recs,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnabledPillars(config) {
  return Object.entries(config.pillars || {})
    .filter(([, val]) => val?.enabled !== false)
    .map(([key]) => key);
}

function getPillarConfig(config, pillar) {
  return config.pillars?.[pillar] || null;
}

function getTriggerFilter(config, pillar) {
  const p = getPillarConfig(config, pillar);
  return p?.triggers || p?.trigger_filter || null;
}

function isBroadTrigger(trigger) {
  if (!trigger) return true;
  if (typeof trigger === "string") return trigger.trim() === "" || trigger === "*";
  if (Array.isArray(trigger)) return trigger.length === 0;
  if (typeof trigger === "object") {
    const hasBranch = trigger.branches || trigger.branch;
    const hasAuthor = trigger.authors || trigger.author;
    const hasPaths = trigger.paths || trigger.path;
    return !hasBranch && !hasAuthor && !hasPaths;
  }
  return false;
}
