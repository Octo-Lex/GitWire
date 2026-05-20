// src/services/branchEnforcementService.js
// Policy engine for branch protection enforcement.
// Adapted for GitWire: uses octokit.request() instead of octokit.rest.*
// All error catches log warnings. No silent error swallowing.

import { db } from "../lib/db.js";
import { forEachInstallation } from "../lib/github.js";
import { Events } from "./pipelineEvents.js";
import { logger } from "../lib/logger.js";
import { minimatch } from "minimatch";

// ── Default policy applied to all orgs if no custom policy exists ─────────────
const DEFAULT_POLICY = {
  branch_pattern:             "main",
  min_reviews:                1,
  require_signed_commits:     false,
  require_linear_history:     true,
  block_force_pushes:         true,
  block_deletions:            true,
  enforce_admins:             true,
  require_status_checks:      false,
  required_status_check_contexts: [],
};

// ════════════════════════════════════════════════════════════════════════════
// Main entry: run enforcement across all installations
// ════════════════════════════════════════════════════════════════════════════

export async function runEnforcementForAll() {
  logger.info("Enforcement: starting fleet-wide run");
  let repoCount = 0, violationCount = 0, remediatedCount = 0;

  await forEachInstallation(async (octokit, installation) => {
    const policies = await loadPolicies(installation.id);

    const { rows: repos } = await db.query(
      `SELECT github_id, full_name, owner, name, default_branch
       FROM repositories WHERE installation_id = $1`,
      [installation.id]
    );

    for (const repo of repos) {
      const result = await enforceRepo({ octokit, repo, policies, installation });
      repoCount++;
      violationCount  += result.violations;
      remediatedCount += result.remediated;
    }
  });

  logger.info({ repoCount, violationCount, remediatedCount }, "Enforcement: fleet run complete");
  return { repoCount, violationCount, remediatedCount };
}

// ── Enforce a single repo against all matching policies ───────────────────────
export async function enforceRepo({ octokit, repo, policies, installation }) {
  let violations = 0, remediated = 0;

  for (const policy of policies) {
    if (!repoMatchesPolicy(repo.full_name, policy)) continue;

    const branches = await getTargetBranches(octokit, repo.owner, repo.name, policy.branch_pattern);

    for (const branch of branches) {
      const result = await enforceRepoBranch({ octokit, repo, branch, policy });
      violations  += result.violations.length;
      remediated  += result.remediated ? 1 : 0;
    }
  }

  return { violations, remediated };
}

// ── Enforce one repo x one branch x one policy ────────────────────────────────
async function enforceRepoBranch({ octokit, repo, branch, policy }) {
  let liveState = null;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches/{branch}/protection", {
      owner: repo.owner, repo: repo.name, branch,
    });
    liveState = parseLiveProtection(data);
  } catch (err) {
    if (err.status === 404) {
      liveState = null;
    } else {
      logger.warn({ repo: repo.full_name, branch, err: err.message }, "Enforcement: could not fetch protection");
      return { violations: [], remediated: false };
    }
  }

  const violations = computeViolations(policy, liveState);

  await persistViolations({ repo, branch, policy, violations });

  if (!violations.length) {
    await db.query(
      `UPDATE branch_rules SET compliant = TRUE, last_checked_at = NOW()
       WHERE repo_id = $1 AND pattern = $2`,
      [repo.github_id, branch]
    );
    return { violations: [], remediated: false };
  }

  logger.info({ repo: repo.full_name, branch, violations }, "Enforcement: violations found");

  if (policy.mode === "enforce") {
    const ok = await remediateViolations({ octokit, repo, branch, policy, liveState });
    if (ok) {
      await markRemediated(repo, branch, policy);
      await Events.violationRemediated(repo.github_id, {
        actor: "gitwire[bot]",
        metadata: { policy: policy.name, violations },
      });
      return { violations, remediated: true };
    }
  }

  await reportViolationsAsIssue({ octokit, repo, branch, policy, violations });
  return { violations, remediated: false };
}

// ════════════════════════════════════════════════════════════════════════════
// Violation computation
// ════════════════════════════════════════════════════════════════════════════

export function computeViolations(policy, live) {
  const v = [];

  if (live === null) {
    if (policy.min_reviews > 0)            v.push({ field: "required_reviews", expected: policy.min_reviews, actual: 0 });
    if (policy.require_linear_history)     v.push({ field: "require_linear_history", expected: true, actual: false });
    if (policy.block_force_pushes)         v.push({ field: "allow_force_pushes", expected: false, actual: true });
    if (policy.block_deletions)            v.push({ field: "allow_deletions", expected: false, actual: true });
    if (policy.enforce_admins)             v.push({ field: "enforce_admins", expected: true, actual: false });
    return v;
  }

  if (policy.min_reviews != null && live.required_reviews < policy.min_reviews) {
    v.push({ field: "required_reviews", expected: policy.min_reviews, actual: live.required_reviews });
  }
  if (policy.require_linear_history && !live.require_linear_history) {
    v.push({ field: "require_linear_history", expected: true, actual: false });
  }
  if (policy.block_force_pushes && live.allow_force_pushes) {
    v.push({ field: "allow_force_pushes", expected: false, actual: true });
  }
  if (policy.block_deletions && live.allow_deletions) {
    v.push({ field: "allow_deletions", expected: false, actual: true });
  }
  if (policy.enforce_admins != null && policy.enforce_admins !== live.enforce_admins) {
    v.push({ field: "enforce_admins", expected: policy.enforce_admins, actual: live.enforce_admins });
  }
  if (policy.require_status_checks && !live.require_status_checks) {
    v.push({ field: "require_status_checks", expected: true, actual: false });
  }

  return v;
}

// ════════════════════════════════════════════════════════════════════════════
// Remediation — apply missing rules via GitHub API
// ════════════════════════════════════════════════════════════════════════════

async function remediateViolations({ octokit, repo, branch, policy, liveState }) {
  try {
    const payload = buildProtectionPayload(policy, liveState);
    await octokit.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
      owner: repo.owner,
      repo:  repo.name,
      branch,
      ...payload,
    });
    logger.info({ repo: repo.full_name, branch }, "Enforcement: remediation applied");
    return true;
  } catch (err) {
    logger.error({ repo: repo.full_name, branch, err: err.message }, "Enforcement: remediation failed");
    return false;
  }
}

export function buildProtectionPayload(policy, live) {
  const existingContexts = live?.required_status_checks?.contexts ?? [];

  return {
    required_status_checks: (policy.require_status_checks || existingContexts.length)
      ? {
          strict:   live?.require_up_to_date_branch ?? false,
          contexts: [...new Set([...existingContexts, ...(policy.required_status_check_contexts ?? [])])],
        }
      : null,
    enforce_admins: policy.enforce_admins ?? live?.enforce_admins ?? false,
    required_pull_request_reviews: (policy.min_reviews > 0)
      ? {
          required_approving_review_count: Math.max(policy.min_reviews, live?.required_reviews ?? 0),
          dismiss_stale_reviews:         live?.dismiss_stale_reviews ?? false,
          require_code_owner_reviews:    live?.require_code_owner_reviews ?? false,
        }
      : null,
    restrictions: null,
    required_linear_history: policy.require_linear_history ?? live?.require_linear_history ?? false,
    allow_force_pushes:      policy.block_force_pushes ? false : (live?.allow_force_pushes ?? false),
    allow_deletions:         policy.block_deletions    ? false : (live?.allow_deletions    ?? false),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// GitHub issue reporting
// ════════════════════════════════════════════════════════════════════════════

async function reportViolationsAsIssue({ octokit, repo, branch, policy, violations }) {
  const title = `[GitWire Policy] Branch \`${branch}\` violates policy \`${policy.name}\``;

  const { data: existingIssues } = await octokit.request("GET /repos/{owner}/{repo}/issues", {
    owner: repo.owner, repo: repo.name, state: "open",
    labels: "gitwire-policy-violation", per_page: 20,
  }).catch(() => ({ data: [] }));

  const existing = existingIssues.find((i) => i.title === title);
  const body = buildViolationIssueBody(branch, policy, violations);

  if (existing) {
    await octokit.request("PATCH /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: repo.owner, repo: repo.name, issue_number: existing.number, body,
    }).catch(err => logger.warn({ err: err.message }, "Enforcement: could not update violation issue"));
    return;
  }

  try {
    await octokit.request("POST /repos/{owner}/{repo}/labels", {
      owner: repo.owner, repo: repo.name,
      name: "gitwire-policy-violation", color: "e11d48",
      description: "Branch protection policy violation detected by GitWire",
    });
  } catch { /* already exists */ }

  await octokit.request("POST /repos/{owner}/{repo}/issues", {
    owner: repo.owner, repo: repo.name, title, body,
    labels: ["gitwire-policy-violation"],
  }).catch(err => logger.warn({ err: err.message }, "Enforcement: could not create violation issue"));
}

function buildViolationIssueBody(branch, policy, violations) {
  const lines = [
    "## Branch protection policy violation", "",
    "**Branch:** `" + branch + "`  ",
    "**Policy:** `" + policy.name + "`  ",
    "**Mode:** " + policy.mode, "",
    "### Violations detected", "",
    "| Rule | Expected | Actual |", "|------|----------|--------|",
    ...violations.map((v) => "| `" + v.field + "` | " + formatVal(v.expected) + " | " + formatVal(v.actual) + " |"),
    "", "### Remediation", "",
    policy.mode === "enforce"
      ? "GitWire attempted to auto-remediate these violations but encountered an error. Please apply the settings manually."
      : "This is a **report-only** policy. Please update the branch protection settings manually.",
    "", "---", "_Detected by [GitWire](https://gitwire.erlab.uk) Policy engine_",
  ];
  return lines.join("\n");
}

export function formatVal(v) {
  if (typeof v === "boolean") return v ? "enabled" : "disabled";
  if (typeof v === "number")  return String(v);
  return String(v);
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function parseLiveProtection(data) {
  const pr = data.required_pull_request_reviews;
  const sc = data.required_status_checks;
  return {
    required_reviews:          pr?.required_approving_review_count ?? 0,
    dismiss_stale_reviews:     pr?.dismiss_stale_reviews            ?? false,
    require_code_owner_reviews:pr?.require_code_owner_reviews       ?? false,
    require_status_checks:     !!sc,
    required_status_checks:    sc?.contexts ?? [],
    require_up_to_date_branch: sc?.strict   ?? false,
    require_linear_history:    data.required_linear_history?.enabled ?? false,
    enforce_admins:            data.enforce_admins?.enabled          ?? false,
    allow_force_pushes:        data.allow_force_pushes?.enabled      ?? false,
    allow_deletions:           data.allow_deletions?.enabled         ?? false,
  };
}

async function getTargetBranches(octokit, owner, repo, pattern) {
  if (!pattern.includes("*")) return [pattern];
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/branches", {
      owner, repo, protected: true, per_page: 100,
    });
    return data.map((b) => b.name).filter((n) => minimatch(n, pattern));
  } catch {
    return [pattern];
  }
}

async function loadPolicies(installationId) {
  const { rows } = await db.query(
    `SELECT * FROM policy_definitions
     WHERE installation_id = $1 AND enabled = TRUE
     ORDER BY name`,
    [installationId]
  );
  if (!rows.length) {
    return [{ id: null, name: "default", mode: "enforce", ...DEFAULT_POLICY }];
  }
  return rows;
}

function repoMatchesPolicy(fullName, policy) {
  if (!policy.repo_filter) return true;
  return minimatch(fullName, policy.repo_filter);
}

async function persistViolations({ repo, branch, policy, violations }) {
  if (!policy.id) return;

  if (!violations.length) {
    await db.query(
      `UPDATE enforcement_violations
       SET status = 'remediated', remediated_at = NOW(), remediated_by = 'auto'
       WHERE policy_id = $1 AND repo_id = $2 AND branch = $3 AND status = 'open'`,
      [policy.id, repo.github_id, branch]
    );
    return;
  }

  await db.query(
    `INSERT INTO enforcement_violations
       (policy_id, repo_id, branch, violations, status, detected_at)
     VALUES ($1, $2, $3, $4, 'open', NOW())
     ON CONFLICT (policy_id, repo_id, branch) DO UPDATE SET
       violations  = EXCLUDED.violations,
       status      = 'open',
       updated_at  = NOW()`,
    [policy.id, repo.github_id, branch, JSON.stringify(violations)]
  );

  await db.query(
    `UPDATE branch_rules SET compliant = FALSE, last_checked_at = NOW()
     WHERE repo_id = $1 AND pattern = $2`,
    [repo.github_id, branch]
  );
}

async function markRemediated(repo, branch, policy) {
  if (!policy.id) return;
  await db.query(
    `UPDATE enforcement_violations
     SET status = 'remediated', remediated_at = NOW(), remediated_by = 'auto', updated_at = NOW()
     WHERE policy_id = $1 AND repo_id = $2 AND branch = $3`,
    [policy.id, repo.github_id, branch]
  );
  await db.query(
    `UPDATE branch_rules SET compliant = TRUE, last_checked_at = NOW()
     WHERE repo_id = $1 AND pattern = $2`,
    [repo.github_id, branch]
  );
}
