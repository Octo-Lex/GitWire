// src/workers/ciHealWorker.js
// Processes failed CI runs from the ci-healing queue.
// Flow: upsert run -> fetch logs -> diagnose -> generate patch -> create PR.

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { ciService } from "../services/ciService.js";
import { getConfigForRepo } from "../services/configService.js";
import { HEALABLE_TYPES } from "@gitwire/core";
import { isPillarEnabled, isFileAllowed, isDryRun, meetsConfidence, getMinPatchConfidence, scoreCIRisk, shouldTrigger } from "@gitwire/rules";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
import { db } from "../lib/db.js";
import { recordAction, cleanupPR } from "../services/managedActionService.js";
import { logDecision } from "../services/decisionLogService.js";
import { checkAndMark } from "../services/idempotencyService.js";
import { emitWorkerEvent } from "../services/workerEvents.js";
import { isWaived } from "../services/waiverService.js";
import { Trail } from "../services/auditTrailService.js";
import { notifyCIFailure } from "../services/telegramNotifyService.js";
import { propose, approve, execute, succeed, fail, cancel } from "../services/actionStateMachine.js";

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

// Code fence regex for stripping ```json blocks from Claude responses
const FENCE_RE = /^```(?:json)?\s*\n?/i;
const FENCE_END_RE = /\n?```\s*$/i;

export function stripCodeFences(raw) {
  return raw.replace(FENCE_RE, "").replace(FENCE_END_RE, "").trim();
}

export function startCIHealWorker() {
  return createWorker(QUEUES.CI_HEALING, async (job) => {
    if (job.name === "heal-run") {
      await healWorkflowRun(job.data);
    } else if (job.name === "reconcile-pr") {
      await reconcilePR(job.data);
    }
  });
}

// ── Reconcile managed actions on PR synchronize ────────────────────────────

async function reconcilePR({ payload }) {
  const { repository, pull_request, installation } = payload;
  if (!pull_request || !installation) return;

  const octokit = await getInstallationClient(installation.id);
  const owner = repository.owner.login;
  const repo = repository.name;
  const repoId = repository.id;
  const prNumber = pull_request.number;

  const { getActiveActions, deactivateAction } = await import("../services/managedActionService.js");
  const activeActions = await getActiveActions(repoId, prNumber, "ci_heal");

  for (const action of activeActions) {
    try {
      if (action.action_type === "label") {
        // Remove stale label from PR
        try {
          await octokit.request("DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", {
            owner, repo, issue_number: prNumber, name: action.action_value,
          });
        } catch (_e) {
          // Label may already be gone — non-fatal
        }
      } else if (action.action_type === "comment" && action.github_id) {
        // Minimize stale comment (not deletable by app)
        try {
          await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
            owner, repo, comment_id: action.github_id,
            body: "~~" + action.action_value + "~~\n\n_Edit: Conditions changed, this diagnosis is stale._",
          });
        } catch (_e) {
          // Comment may be gone — non-fatal
        }
      }
      await deactivateAction(action.id);
    } catch (err) {
      logger.warn({ actionId: action.id, err: err.message }, "Reconciliation failed for action (non-fatal)");
    }
  }

  if (activeActions.length > 0) {
    logger.info({ repo: repository.full_name, prNumber, reconciled: activeActions.length }, "Reconciled CI heal actions");
  }
}

// ── Main heal flow ────────────────────────────────────────────────────────────

async function healWorkflowRun({ payload }) {
  const { workflow_run: run, repository, installation } = payload;
  if (!run || !installation) return;

  const octokit = await getInstallationClient(installation.id);
  const owner   = repository.owner.login;
  const repo    = repository.name;

  logger.info({ runId: run.id, repo: repository.full_name }, "Attempting CI heal");

  // ── Idempotency: skip duplicate heal attempts ──────────────────────────
  if (!(await checkAndMark("ci_heal", "run-" + run.id))) {
    return;
  }

  // ── Check .gitwire.yml pillar config ────────────────────────────────────
  const repoConfig = await getConfigForRepo(repository.full_name);
  if (!isPillarEnabled("ci_healing", repoConfig)) {
    logger.info({ runId: run.id, repo: repository.full_name }, "CI healing disabled for repo — skipping");
    await logDecision({
      repoId: repository.id, source: "ci_heal", triggerEvent: "workflow_run.completed",
      targetType: "pr", targetNumber: 0, pillar: "ci_healing",
      decision: "skipped", reason: "Pillar ci_healing disabled in config",
      conditions: [{ check: "pillar_enabled(ci_healing)", result: false }],
    });
    return;
  }

  // ── Trigger filter: branch/author ──────────────────────────────────────
  if (!shouldTrigger("ci_healing", { branch: run.head_branch, author: run.head_commit?.author?.name }, repoConfig)) {
    logger.info({ runId: run.id, branch: run.head_branch }, "Trigger filter: CI heal skipped for branch/author");
    await logDecision({
      repoId: repository.id, source: "ci_heal", triggerEvent: "workflow_run.completed",
      targetType: "pr", targetNumber: 0, pillar: "ci_healing",
      decision: "skipped", reason: "Trigger filter: branch/author not matched",
      conditions: [{ check: "trigger_filter(ci_healing)", result: false, branch: run.head_branch }],
    });
    return;
  }

  // ── Policy waiver check ──────────────────────────────────────────────
  const waiver = await isWaived({ repoId: repository.id, pillar: "ci_healing", scope: "branch", scopeValue: run.head_branch });
  if (waiver) {
    logger.info({ runId: run.id, waiverId: waiver.id, reason: waiver.reason }, "Policy waived — skipping CI heal");
    await logDecision({
      repoId: repository.id, source: "ci_heal", triggerEvent: "workflow_run.completed",
      targetType: "pr", targetNumber: 0, pillar: "ci_healing",
      decision: "skipped",
      reason: "Policy waived: " + waiver.reason + " (by " + waiver.granted_by + ")",
      conditions: [{ check: "waiver_active(" + waiver.id + ")", result: true }],
    });
    return;
  }

  // 0. Upsert the CI run row
  await upsertCIRun(run, repository);

  // 1. Fetch the failed job logs
  const logs = await fetchFailedJobLogs(octokit, owner, repo, run.id);
  if (!logs) {
    logger.warn({ runId: run.id }, "Could not retrieve run logs");
    await ciService.saveHealResult(run.id, {
      status: "skipped", failureType: "unknown",
      rootCause: "Could not retrieve logs", fixApplied: null, confidence: "low",
    });
    await logDecision({
      repoId: repository.id, source: "ci_heal", triggerEvent: "workflow_run.completed",
      targetType: "pr", targetNumber: 0, pillar: "ci_healing",
      decision: "skipped", reason: "Could not retrieve CI run logs",
      conditions: [{ check: "logs_available", result: false }],
      commitSha: run.head_sha,
    });
    return;
  }
  const diagnosis = await diagnoseWithClaude(logs, run, repository);
  if (!diagnosis) {
    await ciService.saveHealResult(run.id, {
      status: "failed", failureType: "unknown",
      rootCause: "Claude diagnosis failed", fixApplied: null, confidence: "low",
    });
    return;
  }

  logger.info({ runId: run.id, diagnosis }, "CI failure diagnosed");

  // 3. Route based on healability + risk scoring
  if (HEALABLE_TYPES.has(diagnosis.failure_type) && diagnosis.auto_fixable !== false) {
    // Risk scoring
    var risk = scoreCIRisk(diagnosis);
    var minConf = getMinPatchConfidence(repoConfig);
    logger.info({ runId: run.id, riskScore: risk.score, riskLevel: risk.level, minConfidence: minConf }, "CI risk assessment");

    // If confidence doesn't meet threshold, skip patching
    if (!meetsConfidence(diagnosis.confidence, minConf)) {
      logger.info({ runId: run.id, confidence: diagnosis.confidence, minConfidence: minConf }, "Confidence below threshold");
      await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
      await ciService.saveHealResult(run.id, {
        status: "skipped", failureType: diagnosis.failure_type,
        rootCause: diagnosis.root_cause + " (confidence " + diagnosis.confidence + " below " + minConf + ")",
        fixApplied: null, confidence: diagnosis.confidence,
      });
      await logDecision({
        repoId: repository.id, source: "ci_heal", triggerEvent: "workflow_run.completed",
        targetType: "pr", targetNumber: 0, pillar: "ci_healing",
        decision: "blocked", reason: "Confidence " + diagnosis.confidence + " below threshold " + minConf,
        conditions: [
          { check: "pillar_enabled(ci_healing)", result: true },
          { check: "healable_type(" + diagnosis.failure_type + ")", result: true },
          { check: "risk_score(" + risk.score + ")", result: true },
          { check: "confidence(" + diagnosis.confidence + ") >= threshold(" + minConf + ")", result: false },
        ],
        configUsed: { min_confidence: minConf, risk_level: risk.level },
        commitSha: run.head_sha,
      });
      return;
    }

    await attemptHeal(octokit, owner, repo, run, diagnosis, logs, repository, repoConfig);
  } else {
    await postDiagnosisComment(octokit, owner, repo, run, diagnosis);
    await ciService.saveHealResult(run.id, {
      status: "skipped",
      failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause,
      fixApplied: null,
      confidence: diagnosis.confidence,
    });
  }
}

// ── Attempt automated heal via patch PR ───────────────────────────────────────

async function attemptHeal(octokit, owner, repo, run, diagnosis, logs, repository, repoConfig) {
  // Flaky test: just re-run
  if (diagnosis.failure_type === "test_flaky" && diagnosis.confidence !== "low") {
    await healByRerun(octokit, owner, repo, run, diagnosis, repoConfig);
    return;
  }

  // Patch-PR path: lint, type, format, dependency errors
  //   Check auto_patch and file-allowlist from .gitwire.yml
  if (diagnosis.failing_file) {
    const ciOpts = repoConfig.pillars?.ci_healing || {};
    if (ciOpts.auto_patch === false) {
      logger.info({ runId: run.id }, "Auto-patch disabled — posting diagnosis only");
      await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
      await ciService.saveHealResult(run.id, {
        status: "skipped", failureType: diagnosis.failure_type,
        rootCause: diagnosis.root_cause, fixApplied: null, confidence: diagnosis.confidence,
      });
      return;
    }
    if (!isFileAllowed(diagnosis.failing_file, repoConfig)) {
      logger.info({ runId: run.id, file: diagnosis.failing_file }, "File blocked by .gitwire.yml — posting diagnosis only");
      await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
      await ciService.saveHealResult(run.id, {
        status: "skipped", failureType: diagnosis.failure_type,
        rootCause: diagnosis.root_cause + " (file blocked by policy)", fixApplied: null, confidence: diagnosis.confidence,
      });
      return;
    }
    await healByPatchPR(octokit, owner, repo, run, diagnosis, logs, repository, repoConfig);
  } else {
    // No file identified — fall back to comment-only
    await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
    await ciService.saveHealResult(run.id, {
      status: "attempted",
      failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause,
      fixApplied: diagnosis.suggested_fix,
      confidence: diagnosis.confidence,
    });
  }
}

// ── Heal strategy: re-run for flaky tests ─────────────────────────────────────

async function healByRerun(octokit, owner, repo, run, diagnosis, repoConfig) {
  if (isDryRun(repoConfig)) {
    logger.info({ runId: run.id, type: diagnosis.failure_type }, "DRY RUN: would re-run workflow");
    return;
  }
  try {
    await octokit.request("POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun", {
      owner, repo, run_id: run.id,
    });

    logger.info({ runId: run.id }, "Flaky test — workflow re-triggered");

    await postComment(octokit, owner, repo, run,
      "🔄 **GitWire Self-healing CI:** Flaky test detected\n\n" +
      "**Root cause:** " + diagnosis.root_cause + "\n\n" +
      "Automatically re-triggered the workflow. If it fails again, manual intervention is needed.\n\n" +
      "_Confidence: " + diagnosis.confidence + "_"
    );

    await ciService.saveHealResult(run.id, {
      status: "attempted", failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause, fixApplied: "re-run: flaky test",
      confidence: diagnosis.confidence,
    });
  } catch (err) {
    logger.error({ err }, "Failed to re-trigger workflow");
    await ciService.saveHealResult(run.id, {
      status: "failed", failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause, fixApplied: null,
      confidence: diagnosis.confidence,
    });
  }
}

// ── Heal strategy: create a patch PR with the fix ─────────────────────────────

async function healByPatchPR(octokit, owner, repo, run, diagnosis, logs, repository, repoConfig) {
  const repoFullName = repository.full_name;

  // Propose the action
  const action = await propose({
    repoFullName,
    pillar: "ci_healing",
    actionType: "create-patch-pr",
    source: "ai_heal",
    evidence: {
      run_id: run.id,
      failure_type: diagnosis.failure_type,
      failing_file: diagnosis.failing_file,
      confidence: diagnosis.confidence,
      head_branch: run.head_branch,
    },
    repoId: repository.id,
    targetType: "pr",
  });

  if (isDryRun(repoConfig)) {
    await cancel(action.id, "Dry-run mode");
    logger.info({ runId: run.id, failingFile: diagnosis.failing_file, rootCause: diagnosis.root_cause }, "DRY RUN: would create patch PR");
    return;
  }

  // Approve the action (confidence + policy checks passed)
  await approve(action.id, {
    confidence: diagnosis.confidence,
    min_confidence: getMinPatchConfidence(repoConfig),
    dry_run: false,
  });
  const branchName = "gitwire/heal-" + run.id;
  const failingFile = diagnosis.failing_file;

  logger.info({ runId: run.id, failingFile }, "Attempting patch PR");

  // Mark as executing
  await execute(action.id);

  try {
    // 1. Fetch the failing file content
    const { data: fileData } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner, repo, path: failingFile, ref: run.head_branch,
    });

    const originalContent = Buffer.from(fileData.content, "base64").toString("utf8");
    const fileSha = fileData.sha;

    // 2. Ask Claude to generate the fix
    const fix = await generateFixWithClaude(originalContent, failingFile, logs, diagnosis, repository);

    if (!fix || !fix.fixed_content) {
      logger.warn({ runId: run.id }, "Claude could not generate a fix");
      await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
      await ciService.saveHealResult(run.id, {
        status: "attempted", failureType: diagnosis.failure_type,
        rootCause: diagnosis.root_cause, fixApplied: "AI could not generate patch",
        confidence: diagnosis.confidence,
      });
      return;
    }

    logger.info({ runId: run.id, failingFile, explanation: fix.explanation }, "Fix generated by Claude");

    // 3. Create a branch from the current HEAD
    const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/heads/{branch}", {
      owner, repo, branch: run.head_branch,
    });

    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner, repo,
      ref: "refs/heads/" + branchName,
      sha: ref.object.sha,
    });

    logger.info({ branch: branchName }, "Heal branch created");

    // 4. Commit the fixed file to the branch
    const fixedContent = Buffer.from(fix.fixed_content).toString("base64");

    await octokit.request("PUT /repos/{owner}/{repo}/contents/{path}", {
      owner, repo,
      path: failingFile,
      message: "fix(" + failing_file_ext(failingFile) + "): " + truncate(diagnosis.root_cause, 72) + "\n\nApplied by GitWire AI self-healing CI.\n\n" + fix.explanation,
      content: fixedContent,
      sha: fileSha,
      branch: branchName,
    });

    logger.info({ runId: run.id, failingFile }, "Fixed file committed to heal branch");

    // 5. Open a Pull Request
    var prTitle = "🔧 [GitWire] Fix " + diagnosis.failure_type.replace(/_/g, " ") + " in " + failingFile;

    var prBody = [
      "## 🔧 GitWire Auto-Heal PR",
      "",
      "**Workflow:** " + run.name,
      "**Branch:** " + run.head_branch,
      "**Failure type:** " + diagnosis.failure_type,
      "**Confidence:** " + diagnosis.confidence,
      "",
      "### Root Cause",
      diagnosis.root_cause,
      "",
      "### What Changed",
      fix.explanation,
      "",
      "---",
      "*This PR was automatically generated by [GitWire](https://gitwire.erlab.uk) self-healing CI.*",
      "*Review the changes carefully before merging.*",
    ].join("\n");

    const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner, repo,
      title: prTitle,
      body: prBody,
      head: branchName,
      base: run.head_branch,
    });

    logger.info({ runId: run.id, prNumber: pr.number, prUrl: pr.html_url }, "Patch PR created");

    // Mark action as succeeded
    await succeed(action.id, { pr_number: pr.number, pr_url: pr.html_url, branch: branchName });

    // Notify Telegram subscribers
    notifyCIFailure(repository.full_name, {
      pr_number: pr.number,
      failure_type: diagnosis.failure_type,
      confidence: diagnosis.confidence,
      healed: true,
    });

    // 6. Add labels and request review from last committer
    try {
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner, repo, issue_number: pr.number,
        labels: ["ci-heal", diagnosis.failure_type],
      });
      // Managed action: record label additions
      const repoId = repository.id;
      await recordAction({ repoId, source: "ci_heal", prNumber: pr.number, actionType: "label", actionKey: "label:ci-heal", actionValue: "ci-heal", context: { runId: run.id, headSha: run.head_sha } });
      await recordAction({ repoId, source: "ci_heal", prNumber: pr.number, actionType: "label", actionKey: "label:" + diagnosis.failure_type, actionValue: diagnosis.failure_type, context: { runId: run.id, headSha: run.head_sha } });
    } catch (lblErr) {
      logger.warn({ err: lblErr.message }, "Failed to add labels to heal PR");
    }

    try {
      // Request review from the last committer if different from bot
      const { data: commits } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
        owner, repo, sha: run.head_sha, per_page: 1,
      });
      const lastCommitter = commits[0]?.author?.login;
      if (lastCommitter && !lastCommitter.includes("[bot]")) {
        await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers", {
          owner, repo, pull_number: pr.number, reviewers: [lastCommitter],
        });
        // Managed action: record reviewer request
        await recordAction({ repoId: repository.id, source: "ci_heal", prNumber: pr.number, actionType: "reviewer", actionKey: "reviewer:" + lastCommitter, actionValue: lastCommitter, context: { runId: run.id, headSha: run.head_sha } });
      }
    } catch (revErr) {
      logger.warn({ err: revErr.message }, "Failed to request review on heal PR");
    }

    // 7. Record heal PR in database
    try {
      const { rows: [ciRow] } = await db.query(
        "SELECT id FROM ci_runs WHERE github_run_id = $1", [run.id]
      );
      if (ciRow) {
        await db.query(
          `INSERT INTO heal_prs
             (ci_run_id, repo_id, github_pr_number, github_pr_url, heal_branch,
              failure_type, files_changed, pr_title, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open')
           ON CONFLICT DO NOTHING`,
          [ciRow.id, rows[0]?.github_id || repository.id, pr.number, pr.html_url,
           branchName, diagnosis.failure_type, [failingFile], prTitle]
        );

        // Also update ci_runs with PR link
        await db.query(
          `UPDATE ci_runs SET heal_pr_url = $1, heal_pr_number = $2 WHERE github_run_id = $3`,
          [pr.html_url, pr.number, run.id]
        );
      }
    } catch (dbErr) {
      logger.warn({ err: dbErr.message }, "Failed to record heal PR in DB");
    }

    // 8. Post a comment on the commit linking to the PR
    await postComment(octokit, owner, repo, run,
      "🔧 **GitWire created a fix PR:** [#" + pr.number + "](" + pr.html_url + ")\n\n" +
      "**Failure type:** " + diagnosis.failure_type + "\n" +
      "**Root cause:** " + diagnosis.root_cause + "\n" +
      "**Fix:** " + fix.explanation + "\n\n" +
      "_Confidence: " + diagnosis.confidence + " · Review and merge when ready._"
    );

    // Managed action: record the heal PR creation
    await recordAction({ repoId: repository.id, source: "ci_heal", prNumber: pr.number, actionType: "branch_ref", actionKey: "heal_pr", actionValue: branchName, context: { runId: run.id, headSha: run.head_sha, failureType: diagnosis.failure_type } });

    // Audit trail with evidence bundle
    var risk = scoreCIRisk(diagnosis);
    await Trail.ciHeal({
      repoFullName: repository.full_name,
      healType: "patch_pr",
      failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause,
      prNumber: pr.number,
      commitSha: run.head_sha,
      confidence: diagnosis.confidence,
      evidence: {
        decision: "acted",
        reason: "CI heal patch PR created",
        conditions: [
          { check: "pillar_enabled(ci_healing)", result: true },
          { check: "healable_type(" + diagnosis.failure_type + ")", result: true },
          { check: "confidence(" + diagnosis.confidence + ") >= threshold", result: true },
          { check: "risk_score(" + risk.score + ")", result: risk.level !== "high" },
          { check: "is_dry_run()", result: false },
        ],
        config_snapshot: {
          auto_patch: repoConfig.pillars?.ci_healing?.auto_patch !== false,
          pillar_enabled: true,
        },
        context: {
          run_id: run.id,
          failing_file: failingFile,
          branch: run.head_branch,
        },
        actions_taken: [
          { type: "label", key: "label:ci-heal", value: "ci-heal" },
          { type: "branch_ref", key: "heal_pr", value: branchName },
          { type: "pr_created", key: "heal_pr", value: "#" + pr.number },
        ],
      },
    });

    // 7. Save result
    await ciService.saveHealResult(run.id, {
      status: "healed",
      failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause,
      fixApplied: "PR #" + pr.number + ": " + fix.explanation,
      confidence: diagnosis.confidence,
    });

    // 8. Emit worker event for inter-worker chaining
    await emitWorkerEvent("heal_pr_created", {
      repo: repository.full_name,
      repoId: repository.id,
      prNumber: pr.number,
      branch: branchName,
      installationId: installation.id,
      failureType: diagnosis.failure_type,
    });

  } catch (err) {
    logger.error({ err, runId: run.id, failingFile }, "Patch PR creation failed");

    // Mark action as failed
    await fail(action.id, err.message).catch(() => {});

    // Fall back to comment-only
    await postDiagnosisComment(octokit, owner, repo, run, diagnosis, true);
    await ciService.saveHealResult(run.id, {
      status: "failed",
      failureType: diagnosis.failure_type,
      rootCause: diagnosis.root_cause,
      fixApplied: "Patch PR failed: " + err.message,
      confidence: diagnosis.confidence,
    });
  }
}

// ── Ask Claude to generate a fix for the failing file ─────────────────────────

async function generateFixWithClaude(fileContent, filePath, logs, diagnosis, repository) {
  // Build prompt with string concat to avoid backtick issues
  var fence = "```";
  var prompt = "You are fixing a CI failure. Apply the minimal fix to the file below.\n\n" +
    "Repository: " + repository.full_name + "\n" +
    "File: " + filePath + "\n" +
    "Failure type: " + diagnosis.failure_type + "\n" +
    "Root cause: " + diagnosis.root_cause + "\n\n" +
    "CI log (tail):\n" + logs.logs.slice(-3000) + "\n\n" +
    "Current file content:\n" + fence + "\n" + fileContent.slice(-8000) + "\n" + fence + "\n\n" +
    "Return ONLY a JSON object with this schema:\n" +
    '{"fixed_content": "the complete fixed file content as a string",\n' +
    ' "explanation": "one-line summary of what you changed"}\n\n' +
    "Rules:\n" +
    "- Return the COMPLETE file, not a diff\n" +
    "- Make only the minimal change needed to fix the CI failure\n" +
    '- If you cannot fix it, return {"fixed_content": null, "explanation": "reason"}';

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      system: "You are an expert software engineer. Fix CI failures with minimal, precise changes. Return only valid JSON.",
    });

    const raw = message.content[0].text;
    const cleaned = stripCodeFences(raw);
    const result = JSON.parse(cleaned);

    if (!result.fixed_content) return null;

    // Verify the fix is actually different
    if (result.fixed_content === fileContent) {
      logger.warn({ filePath }, "Claude returned identical content — no fix applied");
      return null;
    }

    return result;
  } catch (err) {
    logger.error({ err, filePath }, "Claude fix generation failed");
    return null;
  }
}

// ── Upsert ci_runs row from webhook payload ───────────────────────────────────

async function upsertCIRun(run, repository) {
  const { rows } = await db.query(
    "SELECT github_id FROM repositories WHERE full_name = $1",
    [repository.full_name]
  );
  const repoId = rows[0]?.github_id;
  if (!repoId) {
    logger.warn({ repo: repository.full_name }, "Repo not found in DB — skipping CI run upsert");
    return;
  }

  await db.query(
    "INSERT INTO ci_runs" +
    "  (github_run_id, repo_id, workflow_name, branch, head_sha, conclusion, heal_status, created_at, updated_at)" +
    " VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NOW())" +
    " ON CONFLICT (github_run_id) DO UPDATE SET" +
    "  conclusion = EXCLUDED.conclusion," +
    "  updated_at = NOW()",
    [run.id, repoId, run.name, run.head_branch, run.head_sha, run.conclusion, run.created_at]
  );
}

// ── Fetch logs from the first failed job ──────────────────────────────────────

async function fetchFailedJobLogs(octokit, owner, repo, runId) {
  try {
    const { data: jobs } = await octokit.request("GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs", {
      owner, repo, run_id: runId,
    });

    const failedJob = jobs.jobs.find((j) => j.conclusion === "failure");
    if (!failedJob) return null;

    const { data: logsText } = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
      owner, repo, job_id: failedJob.id,
    });

    return { jobName: failedJob.name, logs: String(logsText).slice(-6000) };
  } catch (err) {
    logger.error({ err }, "Failed to fetch CI logs");
    return null;
  }
}

// ── Claude diagnosis ──────────────────────────────────────────────────────────

async function diagnoseWithClaude(logData, run, repository) {
  var fence = "```";
  var prompt = "Analyze this failed GitHub Actions log and diagnose the root cause.\n\n" +
    "Repository: " + repository.full_name + "\n" +
    "Workflow: " + run.name + "\n" +
    "Branch: " + run.head_branch + "\n" +
    "Job: " + logData.jobName + "\n\n" +
    "Log output (last 6000 chars):\n" + fence + "\n" + logData.logs + "\n" + fence + "\n\n" +
    "Return ONLY this JSON schema, no explanation:\n" +
    '{"failure_type": "lint_error" | "type_error" | "test_flaky" | "test_permanent" | "dependency_missing" | "format_error" | "build_error" | "infra_error" | "unknown",\n' +
    ' "root_cause": "<one sentence>",\n' +
    ' "failing_file": "<filename or null>",\n' +
    ' "failing_line": "<line number or null>",\n' +
    ' "suggested_fix": "<concrete action>",\n' +
    ' "auto_fixable": true | false,\n' +
    ' "confidence": "high" | "medium" | "low"}\n\n' +
    "Important rules:\n" +
    "- If failure_type is lint_error, format_error, type_error, or dependency_missing, set auto_fixable to true\n" +
    "- Only set auto_fixable to false for test_permanent, infra_error, build_error, or unknown\n" +
    "- Always identify the failing_file if possible";

  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
      system: "You are a CI failure analysis expert. Analyze logs precisely and return only valid JSON.",
    });

    const raw = message.content[0].text;
    const cleaned = stripCodeFences(raw);
    return JSON.parse(cleaned);
  } catch (err) {
    logger.error({ err }, "Claude diagnosis failed");
    return null;
  }
}

// ── Post a diagnosis-only comment ──────────────────────────────────────────────

async function postDiagnosisComment(octokit, owner, repo, run, diagnosis, healable) {
  var emoji = healable ? "🔧" : "🤖";
  var body = [
    emoji + " **GitWire Self-healing CI — diagnosis**",
    "",
    "**Failure type:** " + diagnosis.failure_type,
    "**Root cause:** " + diagnosis.root_cause,
    diagnosis.failing_file ? "**Location:** " + diagnosis.failing_file + (diagnosis.failing_line ? ":" + diagnosis.failing_line : "") : null,
    "",
    "**Suggested fix:** " + diagnosis.suggested_fix,
    "",
    "_Confidence: " + diagnosis.confidence + " · Workflow: " + run.name + " · Branch: " + run.head_branch + "_",
  ].filter(Boolean).join("\n");

  await postComment(octokit, owner, repo, run, body);
}

async function postComment(octokit, owner, repo, run, body) {
  try {
    await octokit.request("POST /repos/{owner}/{repo}/commits/{commit_sha}/comments", {
      owner, repo, commit_sha: run.head_sha, body: body,
    });
    logger.info({ owner, repo, sha: run.head_sha }, "Comment posted on commit");
  } catch (err) {
    logger.error({ err }, "Failed to post comment");
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

export function failing_file_ext(path) {
  var parts = path.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "misc";
}

export function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}
