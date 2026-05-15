// src/workers/ciHealWorker.js
// Processes failed CI runs from the ci-healing queue.
// Flow: fetch logs → ask Claude for root cause → attempt automated fix.

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { ciService } from "../services/ciService.js";
import { HEALABLE_TYPES } from "@gitwire/core";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

// Healable failure types imported from @gitwire/core

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

  // ── 1. Fetch the failed job logs ─────────────────────────────────────────
  const logs = await fetchFailedJobLogs(octokit, owner, repo, run.id);
  if (!logs) {
    logger.warn({ runId: run.id }, "Could not retrieve run logs");
    return;
  }

  // ── 2. Ask Claude to diagnose ─────────────────────────────────────────────
  const diagnosis = await diagnoseWithClaude(logs, run, repository);
  if (!diagnosis) return;

  logger.info({ runId: run.id, diagnosis }, "CI failure diagnosed");

  // ── 3. Attempt to heal ────────────────────────────────────────────────────
  if (HEALABLE_TYPES.has(diagnosis.failure_type)) {
    await attemptHeal(octokit, owner, repo, run, diagnosis);
  } else {
    // Non-healable: leave a detailed comment on the commit / PR
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

// ── Fetch logs from the first failed job ─────────────────────────────────────
async function fetchFailedJobLogs(octokit, owner, repo, runId) {
  try {
    const { data: jobs } = await octokit.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: runId,
    });

    const failedJob = jobs.jobs.find((j) => j.conclusion === "failure");
    if (!failedJob) return null;

    const { data: logsText } = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
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

    return JSON.parse(message.content[0].text);
  } catch (err) {
    logger.error({ err }, "Claude diagnosis failed");
    return null;
  }
}

// ── Attempt automated fix via a new PR ───────────────────────────────────────
async function attemptHeal(octokit, owner, repo, run, diagnosis) {
  // For now: trigger a re-run for flaky tests, post detailed comment for others.
  // Full automated patch-PR creation is added in Step 5 (CI healing module).

  if (diagnosis.failure_type === "test_flaky" && diagnosis.confidence !== "low") {
    // Re-trigger the workflow run
    try {
      await octokit.rest.actions.reRunWorkflow({
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

      // Persist: attempted (re-triggered)
      await ciService.saveHealResult(run.id, {
        status:       "attempted",
        failureType:  diagnosis.failure_type,
        rootCause:    diagnosis.root_cause,
        fixApplied:   "re-run: flaky test detected",
        confidence:   diagnosis.confidence,
      });
    } catch (err) {
      logger.error({ err }, "Failed to re-trigger workflow");

      // Persist: failed (re-trigger error)
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

  // Other healable types: post fix instructions + label
  await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);

  // Persist: attempted (fix instructions posted)
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
    `${emoji} **Self-healing CI — diagnosis**`,
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
    await octokit.rest.repos.createCommitComment({
      owner,
      repo,
      commit_sha: run.head_sha,
      body,
    });
  } catch (err) {
    logger.error({ err }, "Failed to post CI heal comment");
  }
}
