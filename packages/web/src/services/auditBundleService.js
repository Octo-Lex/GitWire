// src/services/auditBundleService.js
// Generates exportable audit bundles — bounded evidence packages for
// compliance, handoff, or external review.
//
// A bundle collects decisions, managed actions, waivers, and dry-run proofs
// within a specified scope (repo, pillar, target, time window).
// All secret-like fields are redacted before export.

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redactSecrets, truncateLongStrings, getRedactedFields } from "../lib/redact.js";

/**
 * Generate an audit bundle for a given scope.
 *
 * @param {object} params
 * @param {string} [params.repo]         - repo full_name (owner/repo)
 * @param {string} [params.pillar]       - pillar name
 * @param {string} [params.targetType]   - 'pr' or 'issue'
 * @param {number} [params.targetNumber] - PR/issue number
 * @param {string} [params.from]         - ISO date (inclusive)
 * @param {string} [params.to]           - ISO date (inclusive)
 * @param {number} [params.limit=500]    - max records per section
 * @returns {Promise<object>} audit bundle object
 */
export async function generateAuditBundle(params = {}) {
  const {
    repo, pillar, targetType, targetNumber,
    from, to,
    limit = 500,
  } = params;

  logger.info({ repo, pillar, targetType, targetNumber, from, to }, "Generating audit bundle");

  // Build shared WHERE conditions + params
  var pIdx = 0;
  var sharedParams = [];
  var sharedConditions = [];

  // We'll use a CTE or subquery for repo_id lookup if repo is specified
  var repoJoin = "";
  if (repo) {
    pIdx++;
    sharedParams.push(repo);
    sharedConditions.push("r.full_name = $" + pIdx);
    repoJoin = " JOIN repositories r ON r.github_id = d.repo_id ";
  }

  if (pillar) {
    pIdx++;
    sharedParams.push(pillar);
    sharedConditions.push("d.pillar = $" + pIdx);
  }
  if (targetType) {
    pIdx++;
    sharedParams.push(targetType);
    sharedConditions.push("d.target_type = $" + pIdx);
  }
  if (targetNumber) {
    pIdx++;
    sharedParams.push(targetNumber);
    sharedConditions.push("d.target_number = $" + pIdx);
  }
  if (from) {
    pIdx++;
    sharedParams.push(from);
    sharedConditions.push("d.created_at >= $" + pIdx);
  }
  if (to) {
    pIdx++;
    sharedParams.push(to);
    sharedConditions.push("d.created_at <= $" + pIdx);
  }

  var whereClause = sharedConditions.length > 0
    ? " WHERE " + sharedConditions.join(" AND ")
    : "";

  // Fetch decisions (excluding dry_run — those go in a separate section)
  const decisionsQuery =
    "SELECT d.*" + (repo ? ", r.full_name AS repo_full_name" : "") +
    " FROM decision_log d" + repoJoin + whereClause +
    " AND d.decision != 'dry_run'" +
    " ORDER BY d.created_at DESC" +
    " LIMIT " + Math.min(limit, 1000);
  const { rows: decisions } = await db.query(decisionsQuery, sharedParams);

  // Fetch dry-run decisions
  const dryRunQuery =
    "SELECT d.*" + (repo ? ", r.full_name AS repo_full_name" : "") +
    " FROM decision_log d" + repoJoin + whereClause +
    " AND d.decision = 'dry_run'" +
    " ORDER BY d.created_at DESC" +
    " LIMIT " + Math.min(limit, 1000);
  const { rows: dryRunDecisions } = await db.query(dryRunQuery, sharedParams);

  // Fetch managed actions
  // Build separate conditions for managed_actions table
  var actionParams = [];
  var actionConditions = [];
  var actionJoin = "";
  var aIdx = 0;

  if (repo) {
    aIdx++;
    actionParams.push(repo);
    actionConditions.push("r.full_name = $" + aIdx);
    actionJoin = " JOIN repositories r ON r.github_id = a.repo_id ";
  }
  if (pillar) {
    aIdx++;
    actionParams.push(pillar);
    actionConditions.push("a.pillar = $" + aIdx);
  }
  if (targetType) {
    aIdx++;
    actionParams.push(targetType);
    actionConditions.push("a.target_type = $" + aIdx);
  }
  if (targetNumber) {
    aIdx++;
    actionParams.push(targetNumber);
    actionConditions.push("a.target_number = $" + aIdx);
  }
  if (from) {
    aIdx++;
    actionParams.push(from);
    actionConditions.push("a.created_at >= $" + aIdx);
  }
  if (to) {
    aIdx++;
    actionParams.push(to);
    actionConditions.push("a.created_at <= $" + aIdx);
  }

  var actionWhere = actionConditions.length > 0
    ? " WHERE " + actionConditions.join(" AND ")
    : "";

  const { rows: managedActions } = await db.query(
    "SELECT a.*" + (repo ? ", r.full_name AS repo_full_name" : "") +
    " FROM managed_actions a" + actionJoin + actionWhere +
    " ORDER BY a.created_at DESC" +
    " LIMIT " + Math.min(limit, 1000),
    actionParams
  );

  // Fetch waivers
  var waiverParams = [];
  var waiverConditions = [];
  var waiverJoin = "";
  var wIdx = 0;

  if (repo) {
    wIdx++;
    waiverParams.push(repo);
    waiverConditions.push("r.full_name = $" + wIdx);
    waiverJoin = " JOIN repositories r ON r.github_id = w.repo_id ";
  }
  if (pillar) {
    wIdx++;
    waiverParams.push(pillar);
    waiverConditions.push("w.pillar = $" + wIdx);
  }

  var waiverWhere = waiverConditions.length > 0
    ? " WHERE " + waiverConditions.join(" AND ")
    : "";

  const { rows: waivers } = await db.query(
    "SELECT w.*" + (repo ? ", r.full_name AS repo_full_name" : "") +
    " FROM policy_waivers w" + waiverJoin + waiverWhere +
    " ORDER BY w.created_at DESC" +
    " LIMIT " + Math.min(limit, 1000),
    waiverParams
  );

  // Apply redaction + truncation to all sections
  const redactedDecisions = decisions.map((d) => truncateLongStrings(redactSecrets(d)));
  const redactedDryRun = dryRunDecisions.map((d) => truncateLongStrings(redactSecrets(d)));
  const redactedActions = managedActions.map((a) => truncateLongStrings(redactSecrets(a)));
  const redactedWaivers = waivers.map((w) => truncateLongStrings(redactSecrets(w)));

  const bundle = {
    schema_version: "audit-bundle/v1",
    generated_at: new Date().toISOString(),
    scope: {
      repo: repo || null,
      pillar: pillar || null,
      target_type: targetType || null,
      target_number: targetNumber || null,
      from: from || null,
      to: to || null,
    },
    summary: {
      decisions: redactedDecisions.length,
      managed_actions: redactedActions.length,
      waivers: redactedWaivers.length,
      dry_run_decisions: redactedDryRun.length,
    },
    decisions: redactedDecisions,
    managed_actions: redactedActions,
    waivers: redactedWaivers,
    dry_run_decisions: redactedDryRun,
    redactions: {
      enabled: true,
      fields: getRedactedFields(),
      value: "[REDACTED]",
    },
  };

  logger.info({ summary: bundle.summary }, "Audit bundle generated");

  return bundle;
}

/**
 * Convert an audit bundle to Markdown format.
 *
 * @param {object} bundle - bundle from generateAuditBundle
 * @returns {string} Markdown document
 */
export function bundleToMarkdown(bundle) {
  const lines = [];

  lines.push("# GitWire Audit Bundle");
  lines.push("");
  lines.push("> **Exported:** " + bundle.generated_at);
  lines.push("> **Schema:** " + bundle.schema_version);
  lines.push("");

  // Scope
  lines.push("## Scope");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|-------|-------|");
  lines.push("| Repository | " + (bundle.scope.repo || "All") + " |");
  lines.push("| Pillar | " + (bundle.scope.pillar || "All") + " |");
  lines.push("| Target | " + (bundle.scope.target_type ? bundle.scope.target_type + " #" + (bundle.scope.target_number || "?") : "All") + " |");
  lines.push("| From | " + (bundle.scope.from || "Beginning") + " |");
  lines.push("| To | " + (bundle.scope.to || "Now") + " |");
  lines.push("");

  // Summary
  lines.push("## Summary");
  lines.push("");
  lines.push("| Category | Count |");
  lines.push("|----------|-------|");
  lines.push("| Decisions | " + bundle.summary.decisions + " |");
  lines.push("| Managed Actions | " + bundle.summary.managed_actions + " |");
  lines.push("| Waivers | " + bundle.summary.waivers + " |");
  lines.push("| Dry-Run Proofs | " + bundle.summary.dry_run_decisions + " |");
  lines.push("");

  // Redactions note
  lines.push("## Redactions");
  lines.push("");
  lines.push("The following field patterns were redacted: `" + bundle.redactions.fields.join("`, `") + "`");
  lines.push("");

  // Decisions
  if (bundle.decisions.length > 0) {
    lines.push("## Decisions");
    lines.push("");
    for (const d of bundle.decisions) {
      lines.push("### " + (d.source || "unknown") + " / " + (d.decision || "unknown") + " / " + (d.target_type || "") + "#" + (d.target_number || "?"));
      lines.push("- **Time:** " + d.created_at);
      lines.push("- **Pillar:** " + (d.pillar || "—"));
      lines.push("- **Reason:** " + (d.reason || "—"));
      if (d.conditions) {
        lines.push("- **Conditions:** " + JSON.stringify(d.conditions));
      }
      lines.push("");
    }
  }

  // Managed actions
  if (bundle.managed_actions.length > 0) {
    lines.push("## Managed Actions");
    lines.push("");
    for (const a of bundle.managed_actions) {
      lines.push("### Action #" + (a.id || "?") + " — " + (a.action_type || a.status || "unknown"));
      lines.push("- **Status:** " + (a.status || "—"));
      lines.push("- **Pillar:** " + (a.pillar || "—"));
      lines.push("- **Created:** " + a.created_at);
      if (a.error_message) {
        lines.push("- **Error:** " + a.error_message);
      }
      lines.push("");
    }
  }

  // Waivers
  if (bundle.waivers.length > 0) {
    lines.push("## Waivers");
    lines.push("");
    for (const w of bundle.waivers) {
      const status = w.active ? "active" : "expired";
      lines.push("### " + (w.pillar || "unknown") + " / " + w.scope + " / " + status);
      lines.push("- **Reason:** " + (w.reason || "—"));
      lines.push("- **Granted by:** " + (w.granted_by || "—"));
      lines.push("- **Expires:** " + (w.expires_at || "indefinite"));
      lines.push("- **Created:** " + w.created_at);
      lines.push("");
    }
  }

  // Dry-run proofs
  if (bundle.dry_run_decisions.length > 0) {
    lines.push("## Dry-Run Proofs");
    lines.push("");
    lines.push("> These evaluations did not mutate GitHub.");
    lines.push("");
    for (const d of bundle.dry_run_decisions) {
      lines.push("### " + (d.source || "unknown") + " / " + (d.target_type || "") + "#" + (d.target_number || "?"));
      lines.push("- **Time:** " + d.created_at);
      lines.push("- **Pillar:** " + (d.pillar || "—"));
      lines.push("- **Would have:** " + (d.reason || "—"));
      lines.push("");
    }
  }

  return lines.join("\n");
}
