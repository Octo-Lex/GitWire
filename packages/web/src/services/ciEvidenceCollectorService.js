// src/services/ciEvidenceCollectorService.js
// Trusted CI failure evidence collection for repair proposals.
//
// When a GitHub Actions workflow run fails, this service:
// 1. Validates the event is authentic and eligible
// 2. Creates or retrieves a repair proposal (idempotent)
// 3. Fetches bounded CI evidence from GitHub API
// 4. Redacts, truncates, and hashes all evidence
// 5. Attaches evidence through a service-authorized path
// 6. Transitions the proposal to evidence_collected
//
// This is the ONLY code path allowed to attach CI-source evidence.
//
// Collection limits:
//   Max failed jobs:           3
//   Max failed steps per job:  5
//   Max excerpt body per step: 4 KB (content body, marker reserved separately)
//   Max total excerpt content: 20 KB
//   Max evidence refs:         20

import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../lib/redact.js";
import { contentHash } from "./repairProposalService.js";
import {
  createProposal,
  getProposal,
  recordCiEvidenceCollection,
  computeFingerprint,
  validateEnvelope,
} from "./repairProposalService.js";
import {
  ACTOR_KINDS,
  canCreateProposal,
  canAttachField,
  canTransitionTo,
} from "./repairAuthorityService.js";

const ACTOR = ACTOR_KINDS.CI_EVIDENCE_COLLECTOR;

// ── Collection limits ───────────────────────────────────────────────────────
export const LIMITS = Object.freeze({
  MAX_FAILED_JOBS:         3,
  MAX_FAILED_STEPS:        5,
  MAX_EXCERPT_BYTES:       4096,
  MAX_TOTAL_EXCERPT_BYTES: 20480,
  MAX_EVIDENCE_REFS:       20,
});

// ── Evidence type extensions ────────────────────────────────────────────────
export const CI_EVIDENCE_TYPES = new Set([
  "workflow_run",
  "ci_job",
  "ci_log_excerpt",
  "workflow_file",
]);

// ── Truncation marker ───────────────────────────────────────────────────────
const TRUNCATION_MARKER = "\n...[truncated]";

// ════════════════════════════════════════════════════════════════════════════
// PURE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Truncate a string so that output (content + marker) fits within maxBytes.
 * Reserves marker bytes before slicing to guarantee the output is within limit.
 */
export function truncateExcerpt(text, maxBytes = LIMITS.MAX_EXCERPT_BYTES) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;

  // Reserve space for the truncation marker
  const contentBudget = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf-8");
  const truncated = buf.subarray(0, Math.max(0, contentBudget)).toString("utf-8");
  return truncated + TRUNCATION_MARKER;
}

/**
 * Redact secrets from log content before persistence.
 */
export function redactLogContent(text) {
  if (!text) return "";
  const redacted = redactSecrets({ content: text });
  let result = redacted.content;

  // Inline patterns common in CI logs
  result = result.replace(/gh[ps]_[A-Za-z0-9]{36,}/g, "[REDACTED]");
  result = result.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer [REDACTED]");
  result = result.replace(/xox[bpoa]-[A-Za-z0-9-]+/g, "[REDACTED]");
  result = result.replace(/AKIA[A-Z0-9]{16}/g, "[REDACTED]");

  return result;
}

/**
 * Validate the eligibility of a GitHub workflow_run webhook payload.
 * Returns { eligible: true } or { eligible: false, reason: string }.
 */
export function checkEligibility(payload) {
  if (!payload || typeof payload !== "object") {
    return { eligible: false, reason: "Payload is required" };
  }

  if (payload.action !== "completed") {
    return { eligible: false, reason: "Action must be 'completed'" };
  }

  const run = payload.workflow_run;
  if (!run) {
    return { eligible: false, reason: "workflow_run is missing" };
  }

  if (run.conclusion !== "failure") {
    return { eligible: false, reason: "Workflow conclusion must be 'failure'" };
  }

  if (!run.head_sha) {
    return { eligible: false, reason: "head_sha is missing" };
  }

  if (!run.id) {
    return { eligible: false, reason: "workflow_run.id is missing" };
  }

  const repo = payload.repository;
  if (!repo || !repo.full_name) {
    return { eligible: false, reason: "repository.full_name is missing" };
  }

  if (!payload.installation || !payload.installation.id) {
    return { eligible: false, reason: "installation.id is missing" };
  }

  return { eligible: true };
}

/**
 * Build a task envelope from a GitHub workflow_run event.
 * The envelope is server-derived — never from the request body.
 */
export function buildEnvelopeFromEvent(payload) {
  const run = payload.workflow_run;
  const repo = payload.repository;

  return {
    task_type: "ci_repair",
    source: {
      repository: repo.full_name,
      workflow_run_id: run.id,
      job_id: null,
      head_sha: run.head_sha,
      base_sha: null,
      failure_type: "ci_failure",
    },
    risk: {
      can_write_repository: false,
      requires_approval: true,
      max_files: 3,
      max_changed_lines: 120,
    },
    allowed_tools: ["read_ci_logs", "read_workflow_file", "read_repository_file"],
    blocked_paths: [".env*", "secrets/**", "*.pem", "*.key"],
    required_validation: ["policy_scope_check", "test_or_build_result"],
  };
}

/**
 * Extract the workflow path from a GitHub webhook payload.
 * Returns null if not determinable.
 */
export function extractWorkflowPath(payload) {
  // workflow_run.path contains the workflow file path (e.g. ".github/workflows/ci.yml")
  if (payload?.workflow_run?.path) return payload.workflow_run.path;
  // Fallback: payload.workflow.path
  if (payload?.workflow?.path) return payload.workflow.path;
  // Fallback: derive from workflow name
  const wfName = payload?.workflow?.name;
  if (wfName) return ".github/workflows/" + wfName;
  return null;
}

/**
 * Extract job-level error excerpt from a full job log blob.
 *
 * Note: GitHub Actions job logs don't have reliable step-level delimiters
 * in the API response. This extracts job-level error lines, not step-specific
 * content. The evidence description labels this as a job-level excerpt.
 *
 * @param {string} fullLog - Full job log text from GitHub API
 * @returns {string} Extracted error lines, capped at 10
 */
export function extractJobErrorExcerpt(fullLog) {
  if (!fullLog || typeof fullLog !== "string") return "";

  const lines = fullLog.split("\n");
  const errorLines = [];

  for (const line of lines) {
    if (
      line.includes("##[error]") ||
      line.includes("Error:") ||
      line.includes("FAIL") ||
      line.includes("error:")
    ) {
      errorLines.push(line);
      if (errorLines.length >= 10) break;
    }
  }

  if (errorLines.length > 0) {
    return errorLines.join("\n");
  }

  // No error markers found — return last 20 lines as fallback
  return lines.slice(-20).join("\n");
}

/**
 * Collect all evidence refs from a failed workflow run.
 * This is the core function that fetches from GitHub API.
 *
 * @param {object} octokit - Authenticated GitHub API client
 * @param {object} params
 * @param {string} params.repoFullName - "owner/repo"
 * @param {number} params.runId - workflow_run.id
 * @param {string} params.headSha - commit SHA
 * @param {string|null} [params.workflowPath] - workflow file path (e.g. ".github/workflows/ci.yml")
 * @param {number} [params.installationId] - GitHub App installation ID
 * @returns {Promise<object>} { evidence_refs, correlation_id }
 */
export async function collectEvidenceRefs(octokit, params) {
  const { repoFullName, runId, headSha, workflowPath = null } = params;
  const [owner, repo] = repoFullName.split("/");

  const evidenceRefs = [];
  let totalExcerptBytes = 0;
  const correlationId = "ci-evidence-" + runId + "-" + Date.now();

  // ── 1. Workflow run metadata ────────────────────────────────────────────
  evidenceRefs.push({
    type: "workflow_run",
    source: "github:workflow_run:" + runId,
    excerpt_hash: contentHash({
      repo: repoFullName,
      run_id: runId,
      head_sha: headSha,
      conclusion: "failure",
    }),
    description: "Workflow CI failed on head SHA " + headSha.substring(0, 12),
  });

  // ── 2. Fetch failed jobs ────────────────────────────────────────────────
  let jobs = [];
  try {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
      { owner, repo, run_id: runId, per_page: 30 }
    );
    jobs = (data.jobs || []).filter(j => j.conclusion === "failure");
  } catch (err) {
    logger.warn({ err: err.message, runId }, "Failed to fetch workflow jobs");
  }

  // Cap at MAX_FAILED_JOBS
  const failedJobs = jobs.slice(0, LIMITS.MAX_FAILED_JOBS);

  for (const job of failedJobs) {
    if (evidenceRefs.length >= LIMITS.MAX_EVIDENCE_REFS) break;

    // ── 3. Job metadata ──────────────────────────────────────────────────
    evidenceRefs.push({
      type: "ci_job",
      source: "github:job:" + job.id,
      excerpt_hash: contentHash({
        job_id: job.id,
        name: job.name,
        conclusion: job.conclusion,
        started_at: job.started_at,
        completed_at: job.completed_at,
      }),
      description: "Failed job: " + job.name,
    });

    // ── 4. Job-level log excerpt ─────────────────────────────────────────
    // Collect a single job-level excerpt rather than per-step, since GitHub
    // Actions logs via API don't have reliable step-level delimiters.
    let logExcerpt = "";
    try {
      const { data: logData } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        { owner, repo, job_id: job.id }
      );
      logExcerpt = extractJobErrorExcerpt(logData);
    } catch (err) {
      logger.debug({ err: err.message, jobId: job.id }, "Could not fetch job logs");
    }

    // Redact and truncate
    const redacted = redactLogContent(logExcerpt);
    const truncated = truncateExcerpt(redacted);

    // Track total bytes — only count non-empty excerpts
    if (truncated) {
      totalExcerptBytes += Buffer.byteLength(truncated, "utf-8");
      if (totalExcerptBytes > LIMITS.MAX_TOTAL_EXCERPT_BYTES) {
        logger.info({ runId, totalExcerptBytes }, "Excerpt size cap reached");
        break;
      }

      evidenceRefs.push({
        type: "ci_log_excerpt",
        source: "github:job:" + job.id,
        excerpt_hash: contentHash({
          job_id: job.id,
          excerpt: truncated,
        }),
        excerpt: truncated,
        description: "Redacted, truncated job-level failure excerpt for: " + job.name,
      });
    }
  }

  // ── 5. Workflow file reference ──────────────────────────────────────────
  if (evidenceRefs.length < LIMITS.MAX_EVIDENCE_REFS && workflowPath) {
    evidenceRefs.push({
      type: "workflow_file",
      source: workflowPath + "@" + headSha.substring(0, 12),
      excerpt_hash: contentHash({ path: workflowPath, sha: headSha }),
      description: "Workflow definition evaluated by the failed run",
    });
  }

  return { evidence_refs: evidenceRefs, correlation_id: correlationId };
}

/**
 * Full collection pipeline: create proposal → collect evidence → attach → transition.
 *
 * @param {object} octokit - Authenticated GitHub API client
 * @param {object} payload - Sanitized webhook payload
 * @param {string} [deliveryId] - Webhook delivery ID for dedup
 * @returns {Promise<object>} updated proposal
 */
export async function collectForFailedRun(octokit, payload, deliveryId) {
  // ── 1. Validate eligibility ──────────────────────────────────────────────
  const eligibility = checkEligibility(payload);
  if (!eligibility.eligible) {
    throw new Error("Not eligible for evidence collection: " + eligibility.reason);
  }

  const run = payload.workflow_run;
  const repoFullName = payload.repository.full_name;

  // ── 2. Build server-derived envelope ─────────────────────────────────────
  const envelope = buildEnvelopeFromEvent(payload);

  // ── 3. Create or retrieve proposal (idempotent) ──────────────────────────
  const proposal = await createProposal({
    repo: repoFullName,
    envelope,
    created_by: ACTOR,
    actor_kind: ACTOR,
  });

  logger.info({ proposal_id: proposal.id, repo: repoFullName, runId: run.id }, "Proposal for CI failure");

  // ── 4. Check authority ───────────────────────────────────────────────────
  if (!canCreateProposal(ACTOR)) {
    throw new Error("Actor not authorized to create repair proposals");
  }

  // ── 5. Resolve workflow path from payload ────────────────────────────────
  const workflowPath = extractWorkflowPath(payload);

  // ── 6. Collect evidence from GitHub API ──────────────────────────────────
  const { evidence_refs, correlation_id } = await collectEvidenceRefs(octokit, {
    repoFullName,
    runId: run.id,
    headSha: run.head_sha,
    workflowPath,
    installationId: payload.installation?.id,
  });

  if (evidence_refs.length === 0) {
    throw new Error("No evidence collected for workflow run " + run.id);
  }

  // ── 7. Record evidence atomically (replay-safe, single transaction) ─────
  // recordCiEvidenceCollection replaces the old two-step attach + transition.
  // It locks the row, checks status, and either no-ops (replay) or does
  // attach + transition + event recording in one atomic transaction.
  const result = await recordCiEvidenceCollection(
    proposal.id,
    { evidence_refs },
    {
      actor: ACTOR,
      actor_kind: ACTOR,
      expected_version: proposal.version,
      correlation_id,
      source_delivery_id: deliveryId,
    }
  );

  logger.info({ proposal_id: proposal.id, evidence_count: evidence_refs.length, correlation_id }, "CI evidence collected");
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// Internal helpers (authorized paths replaced by recordCiEvidenceCollection)
// ════════════════════════════════════════════════════════════════════════════

function filterAllowedFieldsSafe(actorKind, evidence) {
  const allowed = {};
  const denied = [];

  for (const [field, value] of Object.entries(evidence)) {
    if (value === undefined) continue;
    if (canAttachField(actorKind, field)) {
      allowed[field] = value;
    } else {
      denied.push(field);
    }
  }

  return { allowed, denied };
}
