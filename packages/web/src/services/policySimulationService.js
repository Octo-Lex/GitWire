// src/services/policySimulationService.js
// Non-mutating historical policy simulation.
//
// Takes a proposed .gitwire.yml policy and replays it against recent
// decision_log entries to show what GitWire WOULD have done differently.
//
// v1 boundary: Simulates policy/guard outcomes (pillar enabled, trigger filter,
// dry-run). Does NOT replay AI-generated classifications — those are marked
// as `would_require_ai`.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { isPillarEnabled, isDryRun, shouldTrigger } from "@gitwire/rules";
import { parseConfig, validateConfig } from "@gitwire/rules";
import { redactSecrets } from "../lib/redact.js";

// Map decision_log source to pillar name
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

// Sources that depend on AI model output — can't be replayed deterministically
const AI_DEPENDENT_SOURCES = new Set(["triage", "ai_review", "issue_fix"]);

/**
 * Simulate a proposed policy against historical decision_log events.
 *
 * @param {object} params
 * @param {string} params.repo         - repo full_name (required)
 * @param {string} params.yaml         - proposed .gitwire.yml content
 * @param {string} [params.from]       - ISO date (default: 14 days ago)
 * @param {string} [params.to]         - ISO date (default: now)
 * @param {number} [params.limit=50]   - max events to simulate
 * @returns {Promise<object>} simulation result
 */
export async function simulatePolicy(params = {}) {
  const {
    repo, yaml: yamlText,
    from, to,
    limit = 50,
  } = params;

  if (!repo) {
    throw new Error("repo is required for simulation");
  }
  if (!yamlText) {
    throw new Error("yaml is required for simulation");
  }

  const fromDate = from || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const toDate = to || new Date().toISOString();

  // Step 1: Parse and validate the proposed policy
  let proposedConfig;
  try {
    proposedConfig = parseConfig(yamlText);
  } catch (err) {
    return {
      simulated_at: new Date().toISOString(),
      scope: { repo, from: fromDate, to: toDate, limit },
      policy: { valid: false, errors: [err.message] },
      summary: { events_considered: 0, would_act: 0, would_skip: 0, would_block: 0, dry_run: 0, unsupported: 0 },
      results: [],
      error: "Invalid policy — cannot simulate",
    };
  }

  const validation = validateConfig(proposedConfig);
  if (!validation.valid) {
    return {
      simulated_at: new Date().toISOString(),
      scope: { repo, from: fromDate, to: toDate, limit },
      policy: { valid: false, errors: validation.errors },
      summary: { events_considered: 0, would_act: 0, would_skip: 0, would_block: 0, dry_run: 0, unsupported: 0 },
      results: [],
      error: "Invalid policy — cannot simulate",
    };
  }

  const dryRun = isDryRun(proposedConfig);
  const enabledPillars = Object.entries(proposedConfig.pillars || {})
    .filter(([, val]) => val?.enabled !== false)
    .map(([key]) => key);

  // Step 2: Fetch historical decision_log events for this repo
  const { rows: [repoRow] } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repo]
  );
  if (!repoRow) {
    return {
      simulated_at: new Date().toISOString(),
      scope: { repo, from: fromDate, to: toDate, limit },
      policy: { valid: true, dry_run: dryRun, enabled_pillars: enabledPillars },
      summary: { events_considered: 0, would_act: 0, would_skip: 0, would_block: 0, dry_run: 0, unsupported: 0 },
      results: [],
      error: "Repository not found",
    };
  }

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

  // Step 3: Simulate each event against the proposed policy
  const results = events.map((event) => simulateEvent(event, proposedConfig, dryRun));

  // Step 4: Aggregate summary
  const summary = {
    events_considered: results.length,
    would_act: results.filter((r) => r.simulated_decision === "would_act").length,
    would_skip: results.filter((r) => r.simulated_decision === "would_skip").length,
    would_block: results.filter((r) => r.simulated_decision === "would_block").length,
    dry_run: results.filter((r) => r.simulated_decision === "dry_run").length,
    unsupported: results.filter((r) =>
      r.simulated_decision === "would_require_ai" || r.simulated_decision === "unsupported_missing_payload"
    ).length,
  };

  logger.info({ repo, summary }, "Policy simulation complete");

  return {
    simulated_at: new Date().toISOString(),
    scope: { repo, from: fromDate, to: toDate, limit },
    policy: { valid: true, dry_run: dryRun, enabled_pillars: enabledPillars },
    summary,
    results,
  };
}

/**
 * Simulate a single historical event against the proposed policy.
 *
 * @param {object} event - decision_log row
 * @param {object} proposedConfig - parsed proposed config
 * @param {boolean} dryRun - dry-run flag from proposed config
 * @returns {object} simulated result
 */
function simulateEvent(event, proposedConfig, dryRun) {
  const pillar = SOURCE_TO_PILLAR[event.source] || event.pillar || event.source;
  const conditions = [];
  const wouldDo = [];

  // Guard 1: Is pillar enabled in proposed config?
  const pillarEnabled = isPillarEnabled(pillar, proposedConfig);
  conditions.push({ check: "pillar_enabled(" + pillar + ")", result: pillarEnabled });

  if (!pillarEnabled) {
    return {
      event_id: String(event.id),
      event_type: event.trigger_event,
      source: event.source,
      target_type: event.target_type,
      target_number: event.target_number,
      original_decision: event.decision,
      simulated_decision: "would_skip",
      would_do: [],
      reason: "Pillar '" + pillar + "' is disabled in the proposed policy.",
      conditions,
    };
  }

  // Guard 2: Trigger filter
  // Reconstruct a minimal context from the event for trigger evaluation
  const ctx = extractContext(event);
  const triggerMatch = shouldTrigger(pillar, ctx, proposedConfig);
  conditions.push({ check: "trigger_filter(" + pillar + ")", result: triggerMatch });

  if (!triggerMatch) {
    return {
      event_id: String(event.id),
      event_type: event.trigger_event,
      source: event.source,
      target_type: event.target_type,
      target_number: event.target_number,
      original_decision: event.decision,
      simulated_decision: "would_skip",
      would_do: [],
      reason: "Trigger filter did not match for pillar '" + pillar + "' in the proposed policy.",
      conditions,
    };
  }

  // Guard 3: Check if this source requires AI replay
  if (AI_DEPENDENT_SOURCES.has(event.source)) {
    // For AI-dependent sources, we can simulate the guard outcomes
    // but cannot replay the actual AI classification
    conditions.push({ check: "is_dry_run()", result: dryRun });

    // Determine what the AI component would have done from the original event
    const originalActed = event.decision === "acted" || event.decision === "dry_run";

    if (originalActed) {
      // The AI DID produce output originally — but under new policy we can't
      // guarantee the same output. Mark as requiring AI replay.
      wouldDo.push("(requires AI replay for: " + event.source + ")");

      return {
        event_id: String(event.id),
        event_type: event.trigger_event,
        source: event.source,
        target_type: event.target_type,
        target_number: event.target_number,
        original_decision: event.decision,
        simulated_decision: "would_require_ai",
        would_do: wouldDo,
        reason: "Guards pass, but " + event.source + " depends on AI classification. Original decision was '" + event.decision + "'. Cannot deterministically replay model output.",
        conditions,
      };
    }

    // AI originally skipped (no labels to apply, etc.) — likely still skips
    return {
      event_id: String(event.id),
      event_type: event.trigger_event,
      source: event.source,
      target_type: event.target_type,
      target_number: event.target_number,
      original_decision: event.decision,
      simulated_decision: dryRun ? "dry_run" : "would_act",
      would_do: dryRun ? [] : ["(evaluate with AI)"],
      reason: dryRun
        ? "Guards pass. Dry-run would prevent mutation. Original AI output was '" + event.decision + "'."
        : "Guards pass. AI evaluation would run. Original decision was '" + event.decision + "'.",
      conditions,
    };
  }

  // Non-AI sources (enforcement, trust, merge_queue, maintainer, insights)
  // These have deterministic guard outcomes
  conditions.push({ check: "is_dry_run()", result: dryRun });

  if (dryRun) {
    return {
      event_id: String(event.id),
      event_type: event.trigger_event,
      source: event.source,
      target_type: event.target_type,
      target_number: event.target_number,
      original_decision: event.decision,
      simulated_decision: "dry_run",
      would_do: [],
      reason: "Guards pass for '" + pillar + "'. Dry-run mode would prevent mutation.",
      conditions,
    };
  }

  // Not dry-run — would act
  return {
    event_id: String(event.id),
    event_type: event.trigger_event,
    source: event.source,
    target_type: event.target_type,
    target_number: event.target_number,
    original_decision: event.decision,
    simulated_decision: "would_act",
    would_do: ["(execute " + event.source + " action)"],
    reason: "Guards pass for '" + pillar + "'. Under proposed policy, GitWire would act.",
    conditions,
  };
}

/**
 * Extract a minimal context object from a decision_log event
 * for trigger filter evaluation.
 */
function extractContext(event) {
  const ctx = {
    branch: null,
    author: null,
    paths: [],
  };

  // Try to extract from config_used or conditions
  if (event.config_used && typeof event.config_used === "object") {
    ctx.branch = event.config_used.branch || null;
    ctx.author = event.config_used.author || null;
    ctx.paths = event.config_used.paths || [];
  }

  // If conditions have useful data, extract from there
  if (event.conditions && Array.isArray(event.conditions)) {
    for (const cond of event.conditions) {
      if (typeof cond.check === "string") {
        // Extract branch from trigger conditions
        if (cond.check.includes("branch") && cond.result !== undefined) {
          // Can't extract actual branch value from boolean condition
        }
      }
    }
  }

  return ctx;
}
