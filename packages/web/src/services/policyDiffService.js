// src/services/policyDiffService.js
// Non-mutating policy diff impact analysis.
//
// Compares a repo's current resolved policy against a proposed .gitwire.yml
// and shows what changes operationally: pillar enablement, dry-run status,
// risk additions/removals, warnings, and per-event simulation impact.
//
// This service never writes config or mutates GitHub.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { parseConfig, validateConfig } from "@gitwire/rules";
import { isPillarEnabled, isDryRun, shouldTrigger } from "@gitwire/rules";
import { getConfigForRepo } from "./configService.js";
import { validatePolicy } from "./policyValidationService.js";
import { redactSecrets } from "../lib/redact.js";

const SOURCE_TO_PILLAR = {
  triage: "triage",
  ci_heal: "ci_healing",
  ai_review: "ai_review",
  issue_fix: "issue_fix",
  merge_queue: "merge_queue",
  enforcement: "enforcement",
  trust: "trust",
  maintainer: "maintainer",
  insights: "insights",
};

/**
 * Compare current repo policy against proposed policy.
 *
 * @param {object} params
 * @param {string} params.repo         - repo full_name (required)
 * @param {string} params.yaml         - proposed .gitwire.yml content
 * @param {string} [params.from]       - ISO date for simulation window
 * @param {string} [params.to]         - ISO date for simulation window
 * @param {number} [params.limit=50]   - max events to compare
 * @returns {Promise<object>} diff impact result
 */
export async function diffPolicyImpact(params = {}) {
  const { repo, yaml: yamlText, from, to, limit = 50 } = params;

  if (!repo) throw new Error("repo is required");
  if (!yamlText) throw new Error("yaml is required");

  const fromDate = from || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();

  // Step 1: Load current policy
  const currentConfig = await getConfigForRepo(repo);
  const currentValidation = await validatePolicy(yamlToText(currentConfig));
  const currentDryRun = isDryRun(currentConfig);
  const currentEnabledPillars = getEnabledPillars(currentConfig);

  // Step 2: Parse proposed policy
  let proposedConfig;
  try {
    proposedConfig = parseConfig(yamlText);
  } catch (err) {
    return {
      compared_at: new Date().toISOString(),
      repo,
      current: {
        valid: true,
        dry_run: currentDryRun,
        enabled_pillars: currentEnabledPillars,
      },
      proposed: { valid: false, errors: [err.message] },
      changes: null,
      simulation_impact: null,
      results: [],
      error: "Invalid proposed policy — cannot diff",
    };
  }

  const proposedValidation = validateConfig(proposedConfig);
  if (!proposedValidation.valid) {
    return {
      compared_at: new Date().toISOString(),
      repo,
      current: {
        valid: true,
        dry_run: currentDryRun,
        enabled_pillars: currentEnabledPillars,
      },
      proposed: { valid: false, errors: proposedValidation.errors },
      changes: null,
      simulation_impact: null,
      results: [],
      error: "Invalid proposed policy — cannot diff",
    };
  }

  const proposedDryRun = isDryRun(proposedConfig);
  const proposedEnabledPillars = getEnabledPillars(proposedConfig);

  // Step 3: Compute config/risk/warning diffs
  const proposedAnalysis = await validatePolicy(yamlText);

  const pillarsEnabled = proposedEnabledPillars.filter(p => !currentEnabledPillars.includes(p));
  const pillarsDisabled = currentEnabledPillars.filter(p => !proposedEnabledPillars.includes(p));

  // Risk diffs — compare by path
  const currentRisks = currentValidation.risky_settings || [];
  const proposedRisks = proposedAnalysis.risky_settings || [];
  const risksAdded = proposedRisks.filter(r => !currentRisks.some(c => c.path === r.path));
  const risksRemoved = currentRisks.filter(c => !proposedRisks.some(r => c.path === c.path));

  // Warning diffs — compare by path+message
  const currentWarnings = currentValidation.warnings || [];
  const proposedWarnings = proposedAnalysis.warnings || [];
  const warningsAdded = proposedWarnings.filter(w =>
    !currentWarnings.some(c => c.path === w.path && c.message === w.message)
  );
  const warningsRemoved = currentWarnings.filter(c =>
    !proposedWarnings.some(w => w.path === c.path && w.message === c.message)
  );

  const dryRunChange = currentDryRun !== proposedDryRun ? {
    from: currentDryRun,
    to: proposedDryRun,
    risk: proposedDryRun ? "decreased" : "increased",
  } : null;

  const changes = {
    dry_run: dryRunChange,
    pillars_enabled: pillarsEnabled,
    pillars_disabled: pillarsDisabled,
    risks_added: risksAdded,
    risks_removed: risksRemoved,
    warnings_added: warningsAdded,
    warnings_removed: warningsRemoved,
  };

  // Step 4: Simulation impact — compare event outcomes
  const { rows: [repoRow] } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1", [repo]
  );

  let simulationImpact = {
    events_considered: 0,
    newly_would_act: 0,
    newly_would_skip: 0,
    unchanged: 0,
    unsupported: 0,
  };
  let eventResults = [];

  if (repoRow) {
    const { rows: events } = await db.query(
      `SELECT id, source, trigger_event, target_type, target_number,
              pillar, decision, reason, conditions, config_used, created_at
       FROM decision_log
       WHERE repo_id = $1
         AND created_at >= $2
         AND created_at <= $3
       ORDER BY created_at DESC
       LIMIT $4`,
      [repoRow.github_id, fromDate, toDate, Math.min(limit, 200)]
    );

    eventResults = events.map(event => {
      const currentSim = simulateOne(event, currentConfig, currentDryRun);
      const proposedSim = simulateOne(event, proposedConfig, proposedDryRun);
      const impact = classifyImpact(currentSim, proposedSim);

      return {
        event_id: String(event.id),
        event_type: event.trigger_event,
        source: event.source,
        target_type: event.target_type,
        target_number: event.target_number,
        current_decision: currentSim.simulated_decision,
        proposed_decision: proposedSim.simulated_decision,
        impact,
        reason: impactReason(currentSim, proposedSim, impact),
      };
    });

    simulationImpact = {
      events_considered: eventResults.length,
      newly_would_act: eventResults.filter(r => r.impact === "more_permissive" || r.impact === "removes_dry_run").length,
      newly_would_skip: eventResults.filter(r => r.impact === "more_restrictive" || r.impact === "new_dry_run").length,
      unchanged: eventResults.filter(r => r.impact === "unchanged").length,
      unsupported: eventResults.filter(r => r.impact === "unsupported").length,
    };
  }

  return {
    compared_at: new Date().toISOString(),
    repo,
    current: {
      valid: true,
      dry_run: currentDryRun,
      enabled_pillars: currentEnabledPillars,
    },
    proposed: {
      valid: true,
      dry_run: proposedDryRun,
      enabled_pillars: proposedEnabledPillars,
    },
    changes,
    simulation_impact: simulationImpact,
    results: eventResults,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getEnabledPillars(config) {
  return Object.entries(config.pillars || {})
    .filter(([, val]) => val?.enabled !== false)
    .map(([key]) => key);
}

function yamlToText(config) {
  // Minimal serialization for validatePolicy (which re-parses)
  return JSON.stringify(config);
}

function simulateOne(event, config, dryRun) {
  const pillar = SOURCE_TO_PILLAR[event.source] || event.pillar || event.source;
  const conditions = [];

  const pillarEnabled = isPillarEnabled(pillar, config);
  conditions.push({ check: "pillar_enabled(" + pillar + ")", result: pillarEnabled });

  if (!pillarEnabled) {
    return { simulated_decision: "would_skip", conditions };
  }

  const ctx = { branch: null, author: null, paths: [] };
  if (event.config_used && typeof event.config_used === "object") {
    ctx.branch = event.config_used.branch || null;
    ctx.author = event.config_used.author || null;
    ctx.paths = event.config_used.paths || [];
  }

  const triggerMatch = shouldTrigger(pillar, ctx, config);
  conditions.push({ check: "trigger_filter(" + pillar + ")", result: triggerMatch });

  if (!triggerMatch) {
    return { simulated_decision: "would_skip", conditions };
  }

  conditions.push({ check: "is_dry_run()", result: dryRun });

  if (dryRun) {
    return { simulated_decision: "dry_run", conditions };
  }

  return { simulated_decision: "would_act", conditions };
}

function classifyImpact(current, proposed) {
  const cd = current.simulated_decision;
  const pd = proposed.simulated_decision;

  if (cd === pd) return "unchanged";

  // AI-dependent
  if (pd === "would_require_ai" || pd === "unsupported_missing_payload") return "unsupported";

  // Dry-run transitions
  if (cd === "dry_run" && pd === "would_act") return "removes_dry_run";
  if (cd === "would_act" && pd === "dry_run") return "new_dry_run";

  // Permissiveness
  const ACTIVE = new Set(["would_act", "dry_run"]);
  if (ACTIVE.has(pd) && !ACTIVE.has(cd)) return "more_permissive";
  if (!ACTIVE.has(pd) && ACTIVE.has(cd)) return "more_restrictive";

  return "unchanged";
}

function impactReason(current, proposed, impact) {
  switch (impact) {
    case "unchanged":
      return "Same effective outcome under both policies.";
    case "more_permissive":
      return "Proposed policy would act where current policy would skip.";
    case "more_restrictive":
      return "Proposed policy would skip where current policy would act.";
    case "new_dry_run":
      return "Proposed policy adds dry-run protection where current policy mutates.";
    case "removes_dry_run":
      return "Proposed policy removes dry-run protection — would mutate where current policy does not.";
    case "unsupported":
      return "Cannot compare — AI-dependent or missing event data.";
    default:
      return "Impact unclear.";
  }
}
