// src/workers/ciHealWorker.js
// Processes failed CI runs from the ci-healing queue.
// Flow: upsert run → fetch logs → ask Claude for root cause → attempt automated fix.

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { ciService } from "../services/ciService.js";
import { HEALABLE_TYPES } from "@gitwire/core";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/db.js";

const anthropic = new Anthropic({ 
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

export function startCIHealWorker() {
  return createWorker(QUEUES.CI_HEALING, async (job) => {
    if (job.name === "heal-run") {
      await healWorkflowRun(job.data);
    }
  });
}

async function healWorkflowRun({ payload }) {
  const { workflow_run: run, repository, installation } = payload;
  if (!run || !installation) return;

  const octokit = await getInstallationClient(installation.id);
  const owner   = repository.owner.login;
  const repo    = repository.name;

  logger.info({ runId: run.id, repo: repository.full_name }, "Attempting CI heal");

  // ── 0. Upsert the CI run row so saveHealResult can UPDATE it ────────────
  await upsertCIRun(run, repository);

  // ── 1. Fetch the failed job logs ─────────────────────────────────────────
  const logs = await fetchFailedJobLogs(octokit, owner, repo, run.id);
  if (!logs) {
    logger.warn({ runId: run.id }, "Could not retrieve run logs");
    await ciService.saveHealResult(run.id, {
      status: "skipped", failureType: "unknown",
      rootCause: "Could not retrieve logs", fixApplied: null, confidence: "low",
    });
    return;
  }

  // ── 2. Ask Claude to diagnose ─────────────────────────────────────────────
  const diagnosis = await diagnoseWithClaude(logs, run, repository);
  if (!diagnosis) {
    await ciService.saveHealResult(run.id, {
      status: "failed", failureType: "unknown",
      rootCause: "Claude diagnosis failed", fixApplied: null, confidence: "low",
    });
    return;
  }

  logger.info({ runId: run.id, diagnosis }, "CI failure diagnosed");

  // ── 3. Attempt to heal ────────────────────────────────────────────────────
  if (HEALABLE_TYPES.has(diagnosis.failure_type)) {
    await attemptHeal(octokit, owner, repo, run, diagnosis);
  } else {
    // Non-healable: leave a detailed comment on the commit
    await postDiagnosisComment(octokit, owner, repo, run, diagnosis);

    // Persist: skipped (not auto-healable)
    await ciService.saveHealResult(run.id, {
      status:       "skipped",
      failureType:  diagnosis.failure_type,
      rootCause:    diagnosis.root_cause,
      fixApplied:   null,
      confidence:   diagnosis.confidence,
    });
  }
}

// ── Upsert ci_runs row from webhook payload ───────────────────────────────────
async function upsertCIRun(run, repository) {
  // Resolve repo_id from repositories table
  const { rows } = await db.query(
    `SELECT github_id FROM repositories WHERE full_name = $1`,
    [repository.full_name]
  );
  const repoId = rows[0]?.github_id;
  if (!repoId) {
    logger.warn({ repo: repository.full_name }, "Repo not found in DB — skipping CI run upsert");
    return;
  }

  await db.query(
    `INSERT INTO ci_runs
       (github_run_id, repo_id, workflow_name, branch, head_sha, conclusion, heal_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())
     ON CONFLICT (github_run_id) DO UPDATE SET
       conclusion = EXCLUDED.conclusion,
       updated_at = NOW()`,
    [run.id, repoId, run.name, run.head_branch, run.head_sha, run.conclusion, run.created_at]
  );
}

// ── Fetch logs from the first failed job ─────────────────────────────────────
async function fetchFailedJobLogs(octokit, owner, repo, runId) {
  try {
    const { data: jobs } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner,
      repo,
      run_id: runId,
    });

    const failedJob = jobs.jobs.find((j) => j.conclusion === "failure");
    if (!failedJob) return null;

    const { data: logsText } = await octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
      owner,
      repo,
      job_id: failedJob.id,
    });

    // Trim to last 6000 chars — most useful error info is at the bottom
    const trimmed = String(logsText).slice(-6000);
    return { jobName: failedJob.name, logs: trimmed };
  } catch (err) {
    logger.error({ err }, "Failed to fetch CI logs");
    return null;
  }
}

// ── Claude diagnosis ──────────────────────────────────────────────────────────
async function diagnoseWithClaude(logData, run, repository) {
  const prompt = `Analyze this failed GitHub Actions log and diagnose the root cause.

Repository: ${repository.full_name}
Workflow: ${run.name}
Branch: ${run.head_branch}
Job: ${logData.jobName}

Log output (last 6000 chars):
\`\`\`
${logData.logs}
\`\`\`

Return ONLY this JSON schema, no explanation:
{
  "failure_type": "lint_error" | "type_error" | "test_flaky" | "test_permanent" | "dependency_missing" | "format_error" | "build_error" | "infra_error" | "unknown",
  "root_cause": "<one sentence description of what went wrong>",
  "failing_file": "<filename if identifiable, or null>",
  "failing_line": <line number if identifiable, or null>,
  "suggested_fix": "<concrete action to fix this, e.g. 'Run npm run lint --fix' or 'Pin dependency X to version Y'>",
  "auto_fixable": true | false,
  "confidence": "high" | "medium" | "low"
}`;

  try {
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages:   [{ role: "user", content: prompt }],
      system:
        "You are a CI failure analysis expert. Analyze logs precisely and return only valid JSON.",
    });

    const raw = message.content[0].text;
    // Strip markdown code fences if present (Claude sometimes wraps in ```json ... ```)
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err }, "Claude diagnosis failed");
    return null;
  }
}

// ── Attempt automated fix ───────────────────────────────────────────────────
async function attemptHeal(octokit, owner, repo, run, diagnosis) {
  if (diagnosis.failure_type === "test_flaky" && diagnosis.confidence !== "low") {
    // Re-trigger the workflow run
    try {
      await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun', {
        owner,
        repo,
        run_id: run.id,
      });

      logger.info({ runId: run.id }, "Flaky test detected — workflow re-triggered");

      await postComment(octokit, owner, repo, run,
        `🔄 **Self-healing CI:** Flaky test detected\n\n` +
        `**Root cause:** ${diagnosis.root_cause}\n\n` +
        `Automatically re-triggered the workflow. If it fails again, manual intervention is needed.\n\n` +
        `_Confidence: ${diagnosis.confidence}_`
      );

      await ciService.saveHealResult(run.id, {
        status:       "attempted",
        failureType:  diagnosis.failure_type,
        rootCause:    diagnosis.root_cause,
        fixApplied:   "re-run: flaky test detected",
        confidence:   diagnosis.confidence,
      });
    } catch (err) {
      logger.error({ err }, "Failed to re-trigger workflow");

      await ciService.saveHealResult(run.id, {
        status:       "failed",
        failureType:  diagnosis.failure_type,
        rootCause:    diagnosis.root_cause,
        fixApplied:   null,
        confidence:   diagnosis.confidence,
      });
    }
    return;
  }

  // Other healable types: post fix instructions
  await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);

  await ciService.saveHealResult(run.id, {
    status:       "attempted",
    failureType:  diagnosis.failure_type,
    rootCause:    diagnosis.root_cause,
    fixApplied:   diagnosis.suggested_fix,
    confidence:   diagnosis.confidence,
  });
}

// ── Post a comment on the commit that triggered the run ──────────────────────
async function postDiagnosisComment(octokit, owner, repo, run, diagnosis, healable = false) {
  const emoji = healable ? "🔧" : "🤖";
  const body = [
    `${emoji} **GitWire Self-healing CI — diagnosis**`,
    "",
    `**Failure type:** \`${diagnosis.failure_type}\``,
    `**Root cause:** ${diagnosis.root_cause}`,
    diagnosis.failing_file ? `**Location:** \`${diagnosis.failing_file}\`${diagnosis.failing_line ? `:${diagnosis.failing_line}` : ""}` : null,
    "",
    `**Suggested fix:** ${diagnosis.suggested_fix}`,
    "",
    `_Confidence: ${diagnosis.confidence} · Workflow: ${run.name} · Branch: ${run.head_branch}_`,
  ].filter(Boolean).join("\n");

  await postComment(octokit, owner, repo, run, body);
}

async function postComment(octokit, owner, repo, run, body) {
  try {
    await octokit.request('POST /repos/{owner}/{repo}/commits/{commit_sha}/comments', {
      owner,
      repo,
      commit_sha: run.head_sha,
      body,
    });
    logger.info({ owner, repo, sha: run.head_sha }, "Diagnosis comment posted on commit");
  } catch (err) {
    logger.error({ err }, "Failed to post CI heal comment");
  }
}
