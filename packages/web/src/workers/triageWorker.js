// src/workers/triageWorker.js
// Processes issues and PRs from the triage queue.
// Uses Claude to classify, suggest labels, and recommend assignees.

import Anthropic from "@anthropic-ai/sdk";
import { createWorker, QUEUES } from "../lib/queue.js";
import { getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { issueService } from "../services/issueService.js";
import { detectDuplicates } from "../services/duplicateDetectionService.js";
import { getConfigForRepo } from "../services/configService.js";
import { isPillarEnabled, isDryRun, shouldTrigger } from "@gitwire/rules";
import { config } from "../../config/index.js";
import { logger } from "../lib/logger.js";
// recordAction deprecated — all actions go through actionStateMachine
import { logDecision } from "../services/decisionLogService.js";
import { checkAndMark } from "../services/idempotencyService.js";
import {
  beginOperation,
  completeOperation,
  abandonOperation,
  buildTriageOperationKey,
} from "../services/idempotencyService.js";
import { isWaived } from "../services/waiverService.js";
import { notifyTriage } from "../services/telegramNotifyService.js";
import { propose, approve, execute, succeed, fail, cancel, findCompletedTriageAction } from "../services/actionStateMachine.js";
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";
import { classifyTriageFailure, isPermanentFailure, sanitizeForRetention } from "../services/triageFailureService.js";
import { postMarkedComment, buildMarker } from "../lib/commentMarkers.js";

const anthropic = new Anthropic({ 
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

export function startTriageWorker() {
  return createWorker(QUEUES.TRIAGE, async (job) => {
    try {
      switch (job.name) {
        case "triage-issue":
          await triageIssue(job.data, job);
          break;
        case "triage-pr":
          await triagePR(job.data, job);
          break;
      }
    } catch (err) {
      // Classify, sanitize, and retain failure metadata on the job before
      // letting BullMQ move it to the failed set. Permanent auth failures
      // are discarded so they don't consume pointless retries; transient
      // failures fall through to BullMQ's normal retry/backoff.
      const classification = classifyTriageFailure(err);
      const priorFailure = job.data?.gitwireFailure;
      const attempts = (priorFailure?.attempts ?? 0) + 1;
      const firstFailedAt = priorFailure?.firstFailedAt ?? classification.failedAt;
      const retained = sanitizeForRetention(classification, { attempts, firstFailedAt });

      try {
        await job.updateData({ ...job.data, gitwireFailure: retained });
      } catch (updateErr) {
        logger.warn({ err: updateErr.message || updateErr }, "Failed to retain gitwireFailure on job data");
      }

      // Record terminal failure in the durable decision log.
      try {
        const repo = job.data?.payload?.repository?.full_name;
        const targetNumber = job.data?.payload?.issue?.number ?? job.data?.payload?.pull_request?.number;
        const targetType = job.data?.payload?.pull_request ? "pr" : "issue";
        if (repo && targetNumber) {
          await logDecision({
            repoId: job.data?.payload?.repository?.id,
            source: "triage",
            triggerEvent: job.name,
            targetType,
            targetNumber,
            pillar: "triage",
            decision: "failed",
            reason: `${classification.failureClass}: ${retained.safeMessage}`,
          });
        }
      } catch (logErr) {
        logger.warn({ err: logErr.message || logErr }, "Failed to record triage failure decision");
      }

      if (isPermanentFailure(classification) && typeof job.discard === "function") {
        logger.warn(
          { failureClass: classification.failureClass, statusCode: classification.statusCode, jobId: job.id },
          "Triage job permanently failed — discarding to prevent pointless retries",
        );
        await job.discard();
      }

      throw err; // BullMQ moves the job to failed and applies retry/backoff
    }
  });
}

// Exported for Wave 2 integration testing (issue #94).
export { triageIssue, triagePR };

// ── Issue triage ─────────────────────────────────────────────────────────────
async function triageIssue({ payload }, job = null) {
  const { issue, repository, installation } = payload;
  if (!issue || !installation) return;

  // Wave 2: resolve trusted installation principal from the webhook-verified
  // installation.id. The sender login from the payload is non-authoritative.
  const adoption = await adoptWorker({
    workerId: "worker:triage",
    permission: "issue:update",
    resourceType: "repository",
    installationId: installation.id,
    jobData: { payload },
    legacyActor: issue.user?.login,
  });
  const principalId = workerPrincipalId(adoption.context);

  logger.info({ repo: repository?.full_name, issue: issue.number }, "Triaging issue");

  // ── Success-bound idempotency lifecycle ─────────────────────────────────
  // The operation key is repository-scoped to prevent cross-repo collisions
  // on shared issue numbers. The complete marker is written only on full
  // success; failures release the active lease so retries can proceed.
  const operationKey = buildTriageOperationKey({
    targetType: "issue",
    repoId: repository.id,
    targetId: issue.id ?? issue.number,
    action: payload.action || "opened",
  });

  const lease = await beginOperation("triage", operationKey);
  if (!lease.acquired) {
    if (lease.alreadyComplete) {
      logger.info({ repo: repository.full_name, issue: issue.number }, "Triage already complete — safe no-op");
    } else {
      logger.info({ repo: repository.full_name, issue: issue.number }, "Triage in progress elsewhere — skipping");
    }
    return;
  }

  // From here on, any thrown error must release the lease before propagating.
  // Intentional skips mark the operation complete so they don't retry forever.
  try {
    // ── Check .gitwire.yml pillar config ────────────────────────────────
    const repoConfig = await getConfigForRepo(repository.full_name);
    if (!isPillarEnabled("triage", repoConfig)) {
      logger.info({ repo: repository.full_name, issue: issue.number }, "Triage disabled for repo — skipping");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
        targetType: "issue", targetNumber: issue.number, pillar: "triage",
        decision: "skipped", reason: "Pillar triage disabled in config",
        conditions: [{ check: "pillar_enabled(triage)", result: false }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    // ── Trigger filter: author ─────────────────────────────────────────
    if (!shouldTrigger("triage", { author: issue.user?.login }, repoConfig)) {
      logger.info({ issue: issue.number, author: issue.user?.login }, "Trigger filter: triage skipped for author");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
        targetType: "issue", targetNumber: issue.number, pillar: "triage",
        decision: "skipped", reason: "Trigger filter: author ignored",
        conditions: [{ check: "trigger_filter(triage)", result: false, author: issue.user?.login }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    // ── Policy waiver check ──────────────────────────────────────────────
    const waiver = await isWaived({ repoId: repository.id, pillar: "triage" });
    if (waiver) {
      logger.info({ issue: issue.number, waiverId: waiver.id }, "Policy waived — skipping triage");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
        targetType: "issue", targetNumber: issue.number, pillar: "triage",
        decision: "skipped",
        reason: "Policy waived: " + waiver.reason + " (by " + waiver.granted_by + ")",
        conditions: [{ check: "waiver_active(" + waiver.id + ")", result: true }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    let octokit;
    try {
      octokit = wrapOctokit(await getInstallationClient(installation.id));
    } catch (err) {
      logger.error({ err, installationId: installation.id }, "Failed to get installation client");
      throw err;
    }

    if (!octokit?.request) {
      throw new Error("Invalid Octokit client — check GitHub App credentials");
    }

    // Fetch existing labels for this repo so Claude can choose from them
    const { data: repoLabels } = await octokit.request('GET /repos/{owner}/{repo}/labels', {
      owner: repository.owner.login,
      repo:  repository.name,
      per_page: 100,
    });

    const labelNames = repoLabels.map((l) => l.name);

    // ── Ask Claude to classify the issue ──────────────────────────────────────
    const prompt = buildIssueTriagePrompt(issue, labelNames);
    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages:   [{ role: "user", content: prompt }],
      system:
        "You are a GitHub triage assistant. Respond only with valid JSON matching the schema in the user prompt. No explanation, no markdown.",
    });

    let classification;
    try {
      let raw = message.content[0].text.trim();
      // Strip markdown code fences if Claude wrapped the JSON
      if (raw.startsWith('```')) {
        raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }
      classification = JSON.parse(raw);
    } catch (err) {
      logger.error({ err, raw: message.content[0].text }, "Failed to parse Claude triage response");
      throw err;
    }

    logger.info({ issue: issue.number, classification }, "Issue classified");

    // ── Apply labels ──────────────────────────────────────────────────────────
    const triageOpts = repoConfig.pillars?.triage || {};
    const labelsToApply = classification.labels.filter((l) =>
      labelNames.includes(l)
    );

    if (labelsToApply.length > 0 && triageOpts.auto_label !== false) {
      if (isDryRun(repoConfig)) {
        logger.info({ issue: issue.number, labels: labelsToApply }, "DRY RUN: would apply labels");
      } else {
        // Deterministic action key for label dedup. Before creating a new
        // GitHub mutation, check whether a prior attempt already succeeded or
        // was reconciled for the same repo + issue + label set. If so, recover
        // as a no-op — the labels are already on the issue.
        const labelActionKey = `triage:label:issue:${issue.number}:${labelsToApply.slice().sort().join(",")}`;
        const priorCompleted = await findCompletedTriageAction({
          repoFullName: repository.full_name,
          targetType: "issue",
          targetNumber: issue.number,
          actionKey: labelActionKey,
        }).catch((err) => {
          logger.warn({ err: err.message || err, issue: issue.number }, "Label dedup check failed — proceeding with mutation");
          return null;
        });

        if (priorCompleted) {
          // Recovery: a prior attempt applied these labels but the complete
          // marker wasn't written. Recover as a no-op — GitHub label-set
          // semantics are idempotent, so the labels are already present.
          logger.info(
            { issue: issue.number, actionId: priorCompleted.id, labels: labelsToApply },
            "Label action already succeeded on prior attempt — recovering as no-op",
          );
          // Record recovery evidence through the decision log.
          await logDecision({
            repoId: repository.id, source: "triage-recovery", triggerEvent: "issues." + payload.action,
            targetType: "issue", targetNumber: issue.number, pillar: "triage",
            decision: "succeeded",
            reason: "Label mutation recovered as no-op after prior completed action",
            conditions: [{ check: "completed_action_found(" + priorCompleted.id + ")", result: true }],
            principalId,
          }).catch(() => {});
        } else {
          // Propose + approve the labeling action
          const action = await propose({
            repoFullName: repository.full_name,
            pillar: "triage",
            actionType: "add-label",
            source: "ai_triage",
            evidence: { issue_number: issue.number, labels: labelsToApply, classification, principalId, surfaceId: "worker:triage" },
            repoId: repository.id,
            targetType: "issue",
            targetNumber: issue.number,
            actionKey: labelActionKey,
          });
          await approve(action.id, { auto_label: true, confidence: classification.confidence });
          await execute(action.id);

          try {
            await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
              owner:  repository.owner.login,
              repo:   repository.name,
              issue_number: issue.number,
              labels: labelsToApply,
            });
            await succeed(action.id, { labels: labelsToApply });
          } catch (err) {
            await fail(action.id, err.message).catch(() => {});
          }
        }
      }
    }

    // ── Persist triage result to database ────────────────────────────────────
    await issueService.saveTriage(issue.id, {
      type:     classification.type,
      priority: classification.priority,
      summary:  classification.triage_summary,
      repoId:   repository.id,
      number:   issue.number,
      title:    issue.title,
      state:    issue.state || 'open',
      labels:   issue.labels?.map((l) => l.name) || [],
    });

    logger.info({ issue: issue.number, type: classification.type, priority: classification.priority }, "Issue triage persisted");

    // Notify Telegram subscribers (non-blocking but caught)
    notifyTriage(repository.full_name, {
      issue_number: issue.number,
      priority: classification.priority,
      triage_type: classification.type,
    }).catch((err) => {
      logger.warn({ err: err.message, repo: repository.full_name }, "Telegram triage notification failed (non-fatal)");
    });

    // ── Log decision ──────────────────────────────────────────────────────────
    await logDecision({
      repoId: repository.id, source: "triage", triggerEvent: "issues." + payload.action,
      targetType: "issue", targetNumber: issue.number, pillar: "triage",
      decision: labelsToApply.length > 0 ? (isDryRun(repoConfig) ? "dry_run" : "acted") : "skipped",
      reason: labelsToApply.length > 0
        ? "Classified as " + classification.type + " (" + classification.priority + "), applied labels: " + labelsToApply.join(", ")
        : "Classified as " + classification.type + " (" + classification.priority + "), no labels to apply",
      conditions: [
        { check: "pillar_enabled(triage)", result: true },
        { check: "auto_label", result: triageOpts.auto_label !== false },
        { check: "is_dry_run()", result: isDryRun(repoConfig) },
        { check: "labels_match_repo(" + labelsToApply.length + ")", result: labelsToApply.length > 0 },
      ],
      configUsed: { auto_label: triageOpts.auto_label !== false },
      principalId,
    });

    // ── Post triage comment if needed (marker-backed) ──────────────────────────
    // Uses the existing commentMarkers machinery so a retry after a partial
    // failure finds and UPDATES the existing comment instead of creating a
    // duplicate. An ambiguous marker (multiple matches) is treated as a
    // blocking processing error rather than creating another comment.
    if ((classification.needs_more_info || classification.duplicate_hint) && triageOpts.auto_comment !== false) {
      if (isDryRun(repoConfig)) {
        logger.info({ issue: issue.number }, "DRY RUN: would post triage comment");
      } else {
        const commentMarkerId = `${repository.id}:${issue.number}`;
        const commentBody = buildTriageComment(classification);
        const result = await postMarkedComment(
          octokit,
          repository.owner.login,
          repository.name,
          issue.number,
          "triage",
          commentMarkerId,
          commentBody,
        );

        if (result.action === "blocked") {
          // Ambiguous marker — multiple existing comments matched. This is an
          // unsafe state; do not create another comment. Throw so the job
          // retries (transient) and the operator can clean up the duplicates.
          throw new Error(`Triage comment marker ambiguous (${result.detail?.matchCount} matches) — refusing to create another comment`);
        }

        // Managed action via state machine. Associate with the existing
        // GitHub comment ID (created or updated) so the ledger stays accurate
        // even when the comment was recovered from a prior attempt.
        const commentAction = await propose({
          repoFullName: repository.full_name, pillar: "triage", actionType: "add-comment",
          source: "ai_triage", evidence: { summary: classification.triage_summary, principalId, surfaceId: "worker:triage" },
          repoId: repository.id, targetType: "issue", targetNumber: issue.number,
          actionKey: `triage:comment:issue:${issue.number}`,
        });
        await approve(commentAction.id, { auto_comment: true });
        await execute(commentAction.id);
        await succeed(commentAction.id, { githubId: result.comment_id, action: result.action });
      }
    }

    // ── Run duplicate detection (best-effort) ────────────────────────────────
    // Runs after classification so the embedding is stored alongside triage data.
    // detectDuplicates handles its own GitHub comment — separate from triage comment.
    // Controlled by pillars.triage.duplicate_detection in .gitwire.yml.
    if (triageOpts.duplicate_detection === false) {
      logger.debug({ issue: issue.number }, "Duplicate detection disabled for repo — skipping");
    } else {
      try {
        const { duplicates, related } = await detectDuplicates({
          issue,
          repository,
          octokit,
        });

        if (duplicates.length) {
          logger.info(
            { issue: issue.number, topMatch: duplicates[0].number, similarity: duplicates[0].similarity.toFixed(3) },
            "Duplicate detected"
          );
        } else if (related.length) {
          logger.info(
            { issue: issue.number, relatedCount: related.length },
            "Related issues found"
          );
        }
      } catch (err) {
        // Duplicate detection is best-effort — never fail the triage job over it
        logger.warn({ err: err.message, issue: issue.number }, "Duplicate detection failed (non-fatal)");
      }
    }

    // ── Full success: mark the operation complete ───────────────────────────
    await completeOperation("triage", operationKey, lease.token);
  } catch (err) {
    // Release the active lease so a retry (manual or BullMQ) can re-acquire it.
    // The complete marker is NOT written — the operation did not finish.
    await abandonOperation("triage", operationKey, lease.token).catch((abandonErr) => {
      logger.warn({ err: abandonErr.message || abandonErr, repo: repository.full_name, issue: issue.number }, "Failed to abandon triage lease");
    });
    throw err;
  }
}

// ── PR triage ────────────────────────────────────────────────────────────────
async function triagePR({ payload }, job = null) {
  const { pull_request: pr, repository, installation } = payload;
  if (!pr || !installation) return;

  // Wave 2: resolve trusted installation principal.
  const adoption = await adoptWorker({
    workerId: "worker:triage",
    permission: "issue:update",
    resourceType: "repository",
    installationId: installation.id,
    jobData: { payload },
    legacyActor: pr.user?.login,
  });
  const principalId = workerPrincipalId(adoption.context);

  logger.info({ repo: repository.full_name, pr: pr.number }, "Triaging PR");

  // ── Success-bound idempotency lifecycle ─────────────────────────────────
  const operationKey = buildTriageOperationKey({
    targetType: "pr",
    repoId: repository.id,
    targetId: pr.id ?? pr.number,
    action: payload.action || "opened",
  });

  const lease = await beginOperation("triage", operationKey);
  if (!lease.acquired) {
    if (lease.alreadyComplete) {
      logger.info({ repo: repository.full_name, pr: pr.number }, "PR triage already complete — safe no-op");
    } else {
      logger.info({ repo: repository.full_name, pr: pr.number }, "PR triage in progress elsewhere — skipping");
    }
    return;
  }

  try {
    // Guard 2: Pillar enabled
    const repoConfig = await getConfigForRepo(repository.full_name);
    if (!isPillarEnabled("triage", repoConfig)) {
      logger.info({ repo: repository.full_name, pr: pr.number }, "Triage disabled for repo - skipping PR");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "pull_request." + payload.action,
        targetType: "pr", targetNumber: pr.number, pillar: "triage",
        decision: "skipped", reason: "Pillar triage disabled in config",
        conditions: [{ check: "pillar_enabled(triage)", result: false }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    // Guard 3: Trigger filter
    if (!shouldTrigger("triage", { author: pr.user?.login, branch: pr.head?.ref }, repoConfig)) {
      logger.info({ pr: pr.number, author: pr.user?.login }, "Trigger filter: triage skipped for author/branch");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "pull_request." + payload.action,
        targetType: "pr", targetNumber: pr.number, pillar: "triage",
        decision: "skipped", reason: "Trigger filter: author/branch not matched",
        conditions: [{ check: "trigger_filter(triage)", result: false }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    // Guard 4: Policy waiver
    const waiver = await isWaived({ repoId: repository.id, pillar: "triage", scope: "target_type", scopeValue: "pr" });
    if (waiver) {
      logger.info({ pr: pr.number, waiverId: waiver.id }, "Policy waived - skipping PR triage");
      await logDecision({
        repoId: repository.id, source: "triage", triggerEvent: "pull_request." + payload.action,
        targetType: "pr", targetNumber: pr.number, pillar: "triage",
        decision: "skipped",
        reason: "Policy waived: " + waiver.reason + " (by " + waiver.granted_by + ")",
        conditions: [{ check: "waiver_active(" + waiver.id + ")", result: true }],
        principalId,
      });
      await completeOperation("triage", operationKey, lease.token);
      return;
    }

    let octokit;
    try {
      octokit = wrapOctokit(await getInstallationClient(installation.id));
    } catch (err) {
      logger.error({ err, installationId: installation.id }, "Failed to get installation client");
      throw err;
    }
    if (!octokit?.request) {
      throw new Error("Invalid Octokit client");
    }

    const message = await anthropic.messages.create({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 512,
      messages:   [{ role: "user", content: buildPRTriagePrompt(pr) }],
      system:
        "You are a GitHub triage assistant. Respond only with valid JSON matching the schema in the user prompt. No explanation, no markdown.",
    });

    let classification;
    try {
      let raw = message.content[0].text.trim();
      if (raw.startsWith("```")) {
        raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
      }
      classification = JSON.parse(raw);
    } catch (err) {
      logger.error({ err, raw: message.content[0].text }, "Failed to parse Claude PR triage response");
      throw err;
    }

    logger.info({ pr: pr.number, classification }, "PR classified");

    // Apply size label with full lifecycle + dedup guard
    const triageOpts = repoConfig.pillars?.triage || {};
    if (classification.size_label && triageOpts.auto_label !== false) {
      if (isDryRun(repoConfig)) {
        logger.info({ pr: pr.number, label: classification.size_label }, "DRY RUN: would apply size label");
      } else {
        // Deterministic action key scoped by repo + PR + label
        const sizeActionKey = `triage:label:pr:${pr.number}:${classification.size_label}`;
        const priorCompleted = await findCompletedTriageAction({
          repoFullName: repository.full_name,
          targetType: "pr",
          targetNumber: pr.number,
          actionKey: sizeActionKey,
        }).catch((err) => {
          logger.warn({ err: err.message || err, pr: pr.number }, "PR label dedup check failed — proceeding");
          return null;
        });

        if (priorCompleted) {
          logger.info(
            { pr: pr.number, actionId: priorCompleted.id, label: classification.size_label },
            "PR label action already succeeded on prior attempt — recovering as no-op",
          );
          await logDecision({
            repoId: repository.id, source: "triage-recovery", triggerEvent: "pull_request." + payload.action,
            targetType: "pr", targetNumber: pr.number, pillar: "triage",
            decision: "succeeded",
            reason: "PR label mutation recovered as no-op after prior completed action",
            conditions: [{ check: "completed_action_found(" + priorCompleted.id + ")", result: true }],
            principalId,
          }).catch(() => {});
        } else {
          const sizeAction = await propose({
            repoFullName: repository.full_name, pillar: "triage", actionType: "add-label",
            source: "ai_triage", evidence: { size_label: classification.size_label, classification, principalId, surfaceId: "worker:triage" },
            repoId: repository.id, targetType: "pr", targetNumber: pr.number,
            actionKey: sizeActionKey,
          });
          await approve(sizeAction.id, { auto_label: true });
          await execute(sizeAction.id);
          try {
            await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
              owner: repository.owner.login,
              repo: repository.name,
              issue_number: pr.number,
              labels: [classification.size_label],
            });
            await succeed(sizeAction.id, { label: classification.size_label });
          } catch (err) {
            await fail(sizeAction.id, err.message).catch(() => {});
          }
        } // end else (no prior completed action)
      }
    }

    // Log decision
    await logDecision({
      repoId: repository.id, source: "triage", triggerEvent: "pull_request." + payload.action,
      targetType: "pr", targetNumber: pr.number, pillar: "triage",
      decision: classification.size_label ? (isDryRun(repoConfig) ? "dry_run" : "acted") : "skipped",
      reason: classification.size_label
        ? "PR classified as " + (classification.type || "unknown") + ", size: " + classification.size_label + ", risk: " + (classification.risk || "?")
        : "PR classified as " + (classification.type || "unknown") + ", no size label to apply",
      conditions: [
        { check: "pillar_enabled(triage)", result: true },
        { check: "auto_label", result: triageOpts.auto_label !== false },
        { check: "is_dry_run()", result: isDryRun(repoConfig) },
      ],
      configUsed: { auto_label: triageOpts.auto_label !== false },
      principalId,
    });

    notifyTriage(repository.full_name, {
      pr_number: pr.number,
      risk: classification.risk,
      triage_type: classification.type,
    }).catch((err) => {
      logger.warn({ err: err.message, repo: repository.full_name }, "Telegram triage notification failed (non-fatal)");
    });

    // ── Full success: mark the operation complete ───────────────────────────
    await completeOperation("triage", operationKey, lease.token);
  } catch (err) {
    await abandonOperation("triage", operationKey, lease.token).catch((abandonErr) => {
      logger.warn({ err: abandonErr.message || abandonErr, repo: repository.full_name, pr: pr.number }, "Failed to abandon PR triage lease");
    });
    throw err;
  }
}

// ── Prompt builders ──────────────────────────────────────────────────────────
function buildIssueTriagePrompt(issue, availableLabels) {
  return `Classify this GitHub issue and return JSON:

Title: ${issue.title}
Body: ${(issue.body || "").slice(0, 1500)}

Available labels: ${availableLabels.join(", ")}

Return this exact JSON schema:
{
  "type": "bug" | "feature" | "question" | "documentation" | "other",
  "priority": "critical" | "high" | "medium" | "low",
  "labels": [<pick 1-3 from available labels that fit best>],
  "needs_more_info": true | false,
  "duplicate_hint": "<null or brief reason if looks like a duplicate>",
  "triage_summary": "<one sentence summary for maintainers>"
}`;
}

function buildPRTriagePrompt(pr) {
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;
  const total = additions + deletions;
  const sizeLabel =
    total < 10   ? "size/XS" :
    total < 50   ? "size/S"  :
    total < 200  ? "size/M"  :
    total < 500  ? "size/L"  : "size/XL";

  return `Classify this GitHub pull request and return JSON:

Title: ${pr.title}
Body: ${(pr.body || "").slice(0, 1000)}
Changed lines: +${additions} -${deletions}

Return this exact JSON schema:
{
  "type": "feature" | "bugfix" | "refactor" | "chore" | "docs" | "test",
  "size_label": "${sizeLabel}",
  "risk": "low" | "medium" | "high",
  "triage_summary": "<one sentence for reviewers>"
}`;
}

function buildTriageComment(classification) {
  const lines = ["👋 **Automated triage**", ""];

  if (classification.triage_summary) {
    lines.push(`_${classification.triage_summary}_`, "");
  }
  if (classification.needs_more_info) {
    lines.push(
      "⚠️ This issue may need more information to reproduce or act on. Could you provide:",
      "- Steps to reproduce",
      "- Expected vs actual behaviour",
      "- Environment details (OS, version, etc.)",
      ""
    );
  }
  if (classification.duplicate_hint) {
    lines.push(`🔍 **Possible duplicate:** ${classification.duplicate_hint}`, "");
  }

  lines.push("_Labels applied automatically. A maintainer will review shortly._");
  return lines.join("\n");
}
