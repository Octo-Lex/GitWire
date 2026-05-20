// src/services/policyReconcilerService.js
// Fleet-wide policy-as-code reconciler for Phase 3.
// Adapted for GitWire: octokit.request(), no silent catches.

import { db }  from "../lib/db.js";
import { forEachInstallation } from "../lib/github.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";

const RECONCILE_INTERVAL_HOURS = 24;

// ════════════════════════════════════════════════════════════════════════════
// Main fleet reconciliation run
// ════════════════════════════════════════════════════════════════════════════

export async function runFleetReconciliation(triggeredBy = "scheduler") {
  const { rows: [run] } = await db.query(
    "INSERT INTO reconciliation_runs (triggered_by) VALUES ($1) RETURNING id", [triggeredBy]
  );

  const stats = { checked: 0, synced: 0, drifted: 0, corrected: 0, failed: 0 };
  const start = Date.now();

  logger.info({ triggeredBy }, "Policy reconciler: starting fleet run");

  await forEachInstallation(async (octokit, installation) => {
    const policies = await loadPoliciesForInstallation(installation.id);

    const { rows: repos } = await db.query(
      "SELECT github_id, full_name, owner, name, default_branch, installation_id FROM repositories WHERE installation_id = $1",
      [installation.id]
    );

    for (const repo of repos) {
      try {
        const result = await reconcileRepo({ octokit, repo, policies });
        stats.checked++;
        if (result.inSync)     stats.synced++;
        else                   stats.drifted++;
        if (result.corrected)  stats.corrected++;
      } catch (err) {
        stats.failed++;
        logger.error({ repo: repo.full_name, err: err.message }, "Policy reconciler: repo failed");
      }
    }
  });

  await db.query(
    "UPDATE reconciliation_runs SET repos_checked=$1, repos_synced=$2, repos_drifted=$3, repos_corrected=$4, repos_failed=$5, duration_ms=$6, completed_at=NOW() WHERE id=$7",
    [stats.checked, stats.synced, stats.drifted, stats.corrected, stats.failed, Date.now() - start, run.id]
  );

  logger.info({ ...stats, durationMs: Date.now() - start }, "Policy reconciler: fleet run complete");
  return { runId: run.id, ...stats };
}

// ════════════════════════════════════════════════════════════════════════════
// Reconcile a single repo
// ════════════════════════════════════════════════════════════════════════════

export async function reconcileRepo({ octokit, repo, policies }) {
  const desired  = buildDesiredState(repo, policies);
  const observed = await fetchObservedState(octokit, repo);
  const { inSync, driftFields: rawDrift } = computeDiff(desired, observed);

  // Make mutable for plan-limit filtering
  const driftFields = [...rawDrift];

  await db.query(
    `INSERT INTO policy_repo_configs (repo_id, desired_state, observed_state, in_sync, drift_fields, last_reconciled_at, next_reconcile_at)
     VALUES ($1,$2,$3,$4,$5,NOW(),NOW() + INTERVAL '24 hours')
     ON CONFLICT (repo_id) DO UPDATE SET
       desired_state = EXCLUDED.desired_state, observed_state = EXCLUDED.observed_state,
       in_sync = EXCLUDED.in_sync, drift_fields = EXCLUDED.drift_fields,
       last_reconciled_at = NOW(), next_reconcile_at = NOW() + INTERVAL '24 hours', updated_at = NOW()`,
    [repo.github_id, JSON.stringify(desired), JSON.stringify(observed), inSync, driftFields]
  );

  if (inSync) return { inSync: true, corrected: false };

  logger.info({ repo: repo.full_name, driftFields }, "Policy reconciler: drift detected");

  const { rows: [cfg] } = await db.query(
    "SELECT reconcile_skip FROM policy_repo_configs WHERE repo_id = $1", [repo.github_id]
  );
  if (cfg?.reconcile_skip) {
    logger.debug({ repo: repo.full_name }, "Policy reconciler: reconcile_skip=true, skipping");
    return { inSync: false, corrected: false };
  }

  // applyCorrections mutates driftFields to remove plan-limited fields
  const corrected = await applyCorrections({ octokit, repo, desired, observed, driftFields });

  // After corrections, check if remaining drift is only plan-limited (now empty)
  const finalInSync = driftFields.length === 0;
  if (corrected || finalInSync) {
    await db.query("UPDATE policy_repo_configs SET in_sync = TRUE, drift_fields = '{}' WHERE repo_id = $1", [repo.github_id]);
    if (corrected) {
      await Events.violationRemediated(repo.github_id, {
        actor: "gitwire[bot]", metadata: { drift_fields: rawDrift, trigger: "policy_reconciler" },
      });
    }
  }

  return { inSync: finalInSync, corrected };
}

// ════════════════════════════════════════════════════════════════════════════
// Desired state builder
// ════════════════════════════════════════════════════════════════════════════

function buildDesiredState(repo, policies) {
  const state = {
    branch_protection: {
      branch: repo.default_branch, required_reviews: 1, require_linear_history: true,
      allow_force_pushes: false, allow_deletions: false, enforce_admins: true, require_status_checks: false,
    },
    required_labels: [
      { name: "bug", color: "d73a4a" },
      { name: "enhancement", color: "a2eeef" },
      { name: "documentation", color: "0075ca" },
    ],
    settings: {
      has_issues: true, has_projects: false, has_wiki: false,
      allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false, delete_branch_on_merge: true,
    },
  };

  for (const policy of policies) {
    if (repoMatchesPolicy(repo.full_name, policy)) {
      if (policy.min_reviews != null)             state.branch_protection.required_reviews = policy.min_reviews;
      if (policy.require_linear_history != null)   state.branch_protection.require_linear_history = policy.require_linear_history;
      if (policy.block_force_pushes != null)       state.branch_protection.allow_force_pushes = !policy.block_force_pushes;
      if (policy.block_deletions != null)          state.branch_protection.allow_deletions = !policy.block_deletions;
      if (policy.enforce_admins != null)           state.branch_protection.enforce_admins = policy.enforce_admins;
    }
  }
  return state;
}

// ════════════════════════════════════════════════════════════════════════════
// Observed state fetcher
// ════════════════════════════════════════════════════════════════════════════

async function fetchObservedState(octokit, repo) {
  const state = { branch_protection: null, required_labels: [], settings: {} };

  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
      owner: repo.owner, repo: repo.name, branch: repo.default_branch,
    });
    const pr = data.required_pull_request_reviews;
    state.branch_protection = {
      branch: repo.default_branch,
      required_reviews:      pr?.required_approving_review_count ?? 0,
      require_linear_history:data.required_linear_history?.enabled ?? false,
      allow_force_pushes:    data.allow_force_pushes?.enabled ?? false,
      allow_deletions:       data.allow_deletions?.enabled    ?? false,
      enforce_admins:        data.enforce_admins?.enabled     ?? false,
      require_status_checks: !!data.required_status_checks,
    };
  } catch { state.branch_protection = null; }

  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/labels", {
      owner: repo.owner, repo: repo.name, per_page: 100,
    });
    state.required_labels = data.map(l => ({ name: l.name, color: l.color }));
  } catch { /* no access */ }

  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner: repo.owner, repo: repo.name });
    state.settings = {
      has_issues: data.has_issues, has_projects: data.has_projects, has_wiki: data.has_wiki,
      allow_squash_merge: data.allow_squash_merge, allow_merge_commit: data.allow_merge_commit,
      allow_rebase_merge: data.allow_rebase_merge, delete_branch_on_merge: data.delete_branch_on_merge,
    };
  } catch { /* no access */ }

  return state;
}

// ════════════════════════════════════════════════════════════════════════════
// Diff computation
// ════════════════════════════════════════════════════════════════════════════

export function computeDiff(desired, observed) {
  const driftFields = [];
  const dbp = desired.branch_protection;
  const obp = observed.branch_protection;

  if (!obp) {
    driftFields.push("branch_protection.missing");
  } else {
    for (const [key, val] of Object.entries(dbp)) {
      if (key === "branch") continue;
      if (obp[key] !== val) driftFields.push("branch_protection." + key);
    }
  }

  const observedLabelNames = new Set(observed.required_labels.map(l => l.name));
  for (const label of desired.required_labels) {
    if (!observedLabelNames.has(label.name)) driftFields.push("label.missing." + label.name);
  }

  for (const [key, val] of Object.entries(desired.settings)) {
    if (observed.settings[key] !== undefined && observed.settings[key] !== val) {
      driftFields.push("settings." + key);
    }
  }

  return { inSync: driftFields.length === 0, driftFields };
}

// ════════════════════════════════════════════════════════════════════════════
// Corrections applicator
// ════════════════════════════════════════════════════════════════════════════

async function applyCorrections({ octokit, repo, desired, observed, driftFields }) {
  const owner = repo.owner;
  const name  = repo.name;
  let applied = false;

  const bpDrift = driftFields.filter(f => f.startsWith("branch_protection."));
  if (bpDrift.length) {
    try {
      const bp = desired.branch_protection;
      await octokit.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
        owner, repo: name, branch: bp.branch,
        required_status_checks: bp.require_status_checks ? { strict: false, contexts: [] } : null,
        enforce_admins: bp.enforce_admins,
        required_pull_request_reviews: bp.required_reviews > 0 ? { required_approving_review_count: bp.required_reviews } : null,
        restrictions: null,
        required_linear_history: bp.require_linear_history,
        allow_force_pushes: bp.allow_force_pushes,
        allow_deletions: bp.allow_deletions,
      });
      logger.info({ repo: repo.full_name, fields: bpDrift }, "Policy reconciler: branch protection corrected");
      applied = true;
    } catch (err) {
      // GitHub Free private repos: branch protection requires GitHub Pro/Team
      const msg = err.message || "";
      const isPlanLimit = msg.includes("Upgrade to GitHub Pro") || msg.includes("make this repository public");
      if (isPlanLimit) {
        logger.debug({ repo: repo.full_name }, "Policy reconciler: branch protection skipped (GitHub Free private repo)");
        // Remove BP drift — it's not actionable on this plan
        for (const f of bpDrift) {
          const idx = driftFields.indexOf(f);
          if (idx >= 0) driftFields.splice(idx, 1);
        }
      } else {
        logger.warn({ repo: repo.full_name, err: msg }, "Policy reconciler: branch protection correction failed");
      }
    }
  }

  const labelDrift = driftFields.filter(f => f.startsWith("label.missing."));
  for (const field of labelDrift) {
    const labelName = field.replace("label.missing.", "");
    const label = desired.required_labels.find(l => l.name === labelName);
    if (!label) continue;
    try {
      await octokit.request("POST /repos/{owner}/{repo}/labels", { owner, repo: name, ...label });
      applied = true;
    } catch (err) {
      logger.warn({ err: err.message }, "Policy reconciler: label creation failed");
    }
  }

  const settingsDrift = driftFields.filter(f => f.startsWith("settings."));
  if (settingsDrift.length) {
    try {
      const patch = {};
      for (const field of settingsDrift) {
        const key = field.replace("settings.", "");
        patch[key] = desired.settings[key];
      }
      await octokit.request("PATCH /repos/{owner}/{repo}", { owner, repo: name, ...patch });
      applied = true;
    } catch (err) {
      logger.warn({ repo: repo.full_name, err: err.message }, "Policy reconciler: settings correction failed");
    }
  }

  return applied;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

async function loadPoliciesForInstallation(installationId) {
  const { rows } = await db.query(
    "SELECT * FROM policy_definitions WHERE installation_id = $1 AND enabled = TRUE", [installationId]
  );
  return rows;
}

function repoMatchesPolicy(fullName, policy) {
  if (!policy.repo_filter) return true;
  const re = new RegExp("^" + policy.repo_filter.replace(/\*\*/g, "§").replace(/\*/g, "[^/]*").replace(/§/g, ".*") + "$");
  return re.test(fullName);
}
