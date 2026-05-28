// src/routes/webhooks.js
// Receives all GitHub webhook events at POST /webhooks/github.
//
// Flow:
//   1. Verify the X-Hub-Signature-256 header (rejects forged payloads)
//   2. Parse the event type + payload
//   3. Enqueue the raw event for async processing (respond 200 fast)
//
// We enqueue rather than process inline so GitHub gets a <2s response
// and never retries due to processing timeouts.

import { Router } from "express";
import { getWebhookApp, getInstallationClient } from "../lib/github.js";
import { wrapOctokit } from "../lib/githubWrapper.js";
import { webhookQueue, triageQueue, ciHealQueue, maintainerQueue, issueFixQueue, phase2Queue, phase3Queue, phase4Queue } from "../lib/queue.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { parseGitwireCommand, resolveCommandAction, buildCommandResponse } from "../lib/commentRouter.js";
import { invalidateConfigCache } from "../services/configService.js";
import { evaluateAndExecuteCustomRules } from "../services/customRulesService.js";
import { evaluateGatesForPR as evaluateQualityGates } from "../services/qualityGateService.js";
import { notifyCustomRule, notifyGateResult } from "../services/telegramNotifyService.js";
import { createGitwireCheck, updateGitwireCheck, buildCheckSummary, conclusionFromDecision } from "../lib/checkStatus.js";
import { sanitizeWebhookPayload } from "../lib/githubSanitize.js";

export const webhookRouter = Router();

// GitHub sends the raw body — we need it as a Buffer for signature verification.
// Make sure express.json() is NOT applied to this route (handled in index.js).
webhookRouter.post(
  "/github",
  express_raw_body_middleware(),
  async (req, res) => {
    const eventName  = req.headers["x-github-event"];
    const deliveryId = req.headers["x-github-delivery"];
    const signature  = req.headers["x-hub-signature-256"];
    const rawBody    = req.rawBody; // populated by our middleware below

    if (!eventName || !signature || !rawBody) {
      return res.status(400).json({ error: "Missing required webhook headers" });
    }

    // ── 1. Verify signature ────────────────────────────────────────────────
    const webhookApp = getWebhookApp();
    if (!webhookApp) {
      return res.status(503).json({ error: "GitHub App not configured" });
    }

    try {
      await webhookApp.webhooks.verifyAndReceive({
        id:        deliveryId,
        name:      eventName,
        signature: signature,
        payload:   rawBody.toString("utf8"),
      });
    } catch (err) {
      logger.warn({ deliveryId, err: err.message }, "Webhook signature invalid");
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    // ── 2. Parse payload ───────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    logger.info(
      { event: eventName, deliveryId, action: payload.action },
      "Webhook received"
    );

    // ── 2b. Sanitize payload (strip token-scoped fields) ──────────────────
    payload = sanitizeWebhookPayload(payload);

    // ── 3. Enqueue based on event type ────────────────────────────────────
    await routeWebhookToQueue(eventName, payload, deliveryId);

    // ── 3a. Evaluate custom rules ────────────────────────────────────────────
    if (["issues", "pull_request", "issue_comment"].includes(eventName)) {
      try {
        const customResults = await evaluateAndExecuteCustomRules(eventName, payload, payload.installation);
        if (customResults.length > 0) {
          logger.info(
            { deliveryId, rules: customResults.map((r) => r.name) },
            "Custom rules executed"
          );
          // Notify Telegram subscribers
          for (const r of customResults) {
            notifyCustomRule(payload.repository.full_name, {
              rule_name: r.name,
              action_type: r.actions?.[0]?.type,
              matched: true,
            });
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, deliveryId }, "Custom rules evaluation failed (non-fatal)");
      }
    }

    // ── 3a-2. Evaluate quality gates for PR events ──────────────────────────
    if (eventName === "pull_request" && payload.pull_request) {
      try {
        const pr = payload.pull_request;
        const octokit = wrapOctokit(await getInstallationClient(payload.installation?.id));
        if (octokit && pr.head?.sha) {
          const gateResults = await evaluateQualityGates({
            repoId: payload.repository.id,
            repoFullName: payload.repository.full_name,
            headSha: pr.head.sha,
            prNumber: pr.number,
            octokit,
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
          });
          if (gateResults.length > 0) {
            const failed = gateResults.filter((r) => r.result === "failed" && r.block_on_fail);
            logger.info(
              { deliveryId, pr: pr.number, gateResults: gateResults.length, failed: failed.length },
              "Quality gates evaluated"
            );
            // Notify Telegram subscribers
            const allPassed = failed.length === 0;
            notifyGateResult(payload.repository.full_name, {
              pr_number: pr.number,
              passed: allPassed,
              gate_name: gateResults.map((g) => g.name).join(", "),
              summary: allPassed ? "All gates passed" : `${failed.length} gate(s) failed`,
            });
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, deliveryId }, "Quality gate evaluation failed (non-fatal)");
      }
    }

    // ── 3b. Create GitWire check for PR events ──────────────────────────────
    if (eventName === "pull_request" && payload.pull_request?.head?.sha) {
      try {
        const octokit = wrapOctokit(await getInstallationClient(payload.installation?.id));
        if (octokit) {
          const checkRunId = await createGitwireCheck({
            octokit,
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            headSha: payload.pull_request.head.sha,
            status: "queued",
            title: "GitWire — evaluating…",
            summary: "GitWire is processing this PR. Results will appear here shortly.",
          });
          // Store check run ID for workers to update (best-effort)
          if (checkRunId) {
            logger.debug({ checkRunId, pr: payload.pull_request.number }, "GitWire check created for PR");
          }
        }
      } catch (err) {
        logger.warn({ err: err.message }, "Failed to create GitWire check on PR (non-fatal)");
      }
    }

    // ── 4. Log delivery for audit ──────────────────────────────────────────
    await db.query(
      `INSERT INTO webhook_deliveries (delivery_id, event_name, action, repo, processed, received_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW())
       ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, eventName, payload.action ?? null, payload.repository?.full_name ?? null]
    ).catch((err) => {
      logger.error({ err, deliveryId }, "Failed to log webhook delivery");
    });

    // Respond immediately — processing happens asynchronously
    res.status(202).json({ queued: true, deliveryId });
  }
);

// ── Routing logic: which queue gets which events ─────────────────────────────
async function routeWebhookToQueue(eventName, payload, deliveryId) {
  const jobData = { eventName, payload, deliveryId, receivedAt: Date.now() };

  switch (eventName) {
    // Issues → triage queue
    case "issues":
      if (["opened", "reopened", "edited"].includes(payload.action)) {
        await triageQueue.add("triage-issue", jobData, { priority: 1 });
        logger.info({ action: payload.action, issue: payload.issue?.number }, "Issue queued for triage");
      }
      break;

    // Pull requests → triage + AI review + merge queue
    case "pull_request":
      if (["opened", "reopened", "ready_for_review"].includes(payload.action)) {
        await triageQueue.add("triage-pr", jobData, { priority: 2 });
        logger.info({ action: payload.action, pr: payload.pull_request?.number }, "PR queued for triage");

        // Phase 4: AI review on PR open/sync/ready
        await phase4Queue.add("ai-review", {
          pr:           payload.pull_request,
          repository:   payload.repository,
          installation: payload.installation,
        }, { priority: 1 });
      }
      // Managed actions: reconcile stale actions on force-push
      if (payload.action === "synchronize") {
        await ciHealQueue.add("reconcile-pr", {
          payload: {
            repository:   payload.repository,
            pull_request: payload.pull_request,
            installation: payload.installation,
          },
        }, { priority: 5 });
        logger.info({ pr: payload.pull_request?.number }, "PR synchronize — reconcile job queued");
      }
      // Managed actions: cleanup when PR is closed/merged
      if (payload.action === "closed") {
        try {
          const { cleanupPR } = await import("../services/managedActionService.js");
          const deactivated = await cleanupPR(payload.repository?.id, payload.pull_request?.number);
          if (deactivated.length > 0) {
            logger.info({ pr: payload.pull_request?.number, deactivated: deactivated.length }, "Cleaned up managed actions on PR close");
          }
        } catch (err) {
          logger.warn({ err: err.message }, "Managed action cleanup failed (non-fatal)");
        }
      }
      // Phase 2: auto-merge label → merge queue
      if (payload.action === "labeled" && payload.label?.name === "auto-merge") {
        await phase2Queue.add("pr-labeled-auto-merge", jobData, { priority: 1 });
      }
      // Phase 2: closed/unlabeled → merge queue cleanup
      if (payload.action === "closed" || payload.action === "unlabeled") {
        await phase2Queue.add("pr-closed-or-unlabeled", jobData, { priority: 2 });
      }
      break;

    // PR review submitted → check if eligible for merge queue
    case "pull_request_review":
      if (payload.action === "submitted" && payload.review?.state === "approved") {
        await phase2Queue.add("review-submitted", jobData, { priority: 2 });
      }
      break;

    // Check suite completed → merge queue gate
    case "check_suite":
      if (payload.action === "completed") {
        await phase2Queue.add("checks-updated", jobData, { priority: 1 });
      }
      break;

    // CI results → healing queue (failure) + merge queue gate + rollback + test ingestion
    case "workflow_run":
      if (payload.action === "completed") {
        if (payload.workflow_run?.conclusion === "failure") {
          await ciHealQueue.add("heal-run", jobData, { priority: 1 });
          logger.info(
            { runId: payload.workflow_run?.id, repo: payload.repository?.full_name },
            "Failed CI run queued for healing"
          );
        }
        // Phase 2: notify merge queue of check completion
        await phase2Queue.add("checks-updated", jobData, { priority: 1 });
        // Phase 2: post-merge deploy failure → rollback evaluation
        await phase2Queue.add("eval-rollback", jobData, { priority: 1 });
        // Phase 3: ingest test results for flakiness detection
        if (payload.workflow_run?.conclusion === "success" || payload.workflow_run?.conclusion === "failure") {
          await phase3Queue.add("ingest-test-results", {
            run: payload.workflow_run,
            repository: payload.repository,
            installation: payload.installation,
          }, { priority: 3 });
        }
      }
      break;

    // App installation events → general queue (store installation info)
    case "installation":
    case "installation_repositories":
      await webhookQueue.add("sync-installation", jobData);
      break;

    // Push events → trigger incremental sync + config validation
    case "push":
      await webhookQueue.add("sync-repo", jobData, { priority: 3 });
      await webhookQueue.add("validate-configs", jobData, { priority: 2 });

      // Invalidate .gitwire.yml cache if it changed in this push
      const changed = [
        ...(payload.head_commit?.added || []),
        ...(payload.head_commit?.modified || []),
      ];
      if (changed.some((f) => f === ".gitwire.yml" || f === ".github/.gitwire.yml")) {
        await invalidateConfigCache(payload.repository.full_name);
      }
      break;

    // Issue comment → check for /gitwire commands
    case "issue_comment":
      if (payload.action === "created" && payload.comment) {
        const parsed = parseGitwireCommand(payload.comment.body, {
          repo: payload.repository?.full_name,
          issueNumber: payload.issue?.number,
          commentId: payload.comment.id,
          authorAssociation: payload.comment.author_association,
          authorLogin: payload.comment.user?.login,
        });
        if (parsed) {
          const action = resolveCommandAction(parsed);
          if (action) {
            // /gitwire run — manual re-evaluation
            if (action.action === "manual_run") {
              const isPR = !!payload.issue?.pull_request;
              const pillar = action.pillar;
              const repoFullName = payload.repository?.full_name;
              const issueNumber = parsed.issueNumber;
              const installationId = payload.installation?.id;
              const clearedIdemKeys = [];

              // Clear idempotency keys so re-run actually processes
              const { clearIdempotencyKey } = await import("../services/idempotencyService.js");

              if (isPR) {
                // It's a PR (GitHub uses "issue" for PR comments too)
                if (pillar === "all" || pillar === "review") {
                  await clearIdempotencyKey("ai_review", "pr-" + issueNumber + "-" + (payload.issue?.pull_request?.url || "unknown"));
                  await phase4Queue.add("ai-review", {
                    pr: { number: issueNumber, base: { ref: payload.issue?.pull_request?.base?.ref }, user: payload.issue?.user },
                    repository: payload.repository,
                    installation: payload.installation,
                  }, { priority: 1 });
                }
                if (pillar === "all" || pillar === "triage") {
                  await clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
                  await triageQueue.add("triage-issue", { payload }, { priority: 1 });
                }
                if (pillar === "heal") {
                  await clearIdempotencyKey("ci_heal", "heal-pr-" + issueNumber);
                  logger.info({ repo: repoFullName, pr: issueNumber }, "/gitwire run heal — CI heal requires a failed workflow_run event");
                }
              } else {
                // It's an issue
                if (pillar === "all" || pillar === "triage") {
                  await clearIdempotencyKey("triage", "issue-" + issueNumber + "-reopened");
                  await triageQueue.add("triage-issue", { payload }, { priority: 1 });
                }
                if (pillar === "all" || pillar === "fix") {
                  await clearIdempotencyKey("issue_fix", "issue-" + issueNumber);
                  await issueFixQueue.add("fix-issue", {
                    repo: repoFullName,
                    issueNumber,
                    installationId,
                    triggeredBy: parsed.authorLogin,
                  }, { priority: 1 });
                }
              }

              logger.info({ command: "run", pillar, repo: repoFullName, issue: issueNumber, isPR }, "/gitwire run queued");

            // fix_issue goes to the issue-fix queue; all others to maintainer
            } else if (action.action === "fix_issue") {
              await issueFixQueue.add("fix-issue", {
                repo: payload.repository?.full_name,
                issueNumber: parsed.issueNumber,
                installationId: payload.installation?.id,
                triggeredBy: parsed.authorLogin,
              }, { priority: 1 });
              logger.info({ command: "fix", repo: payload.repository?.full_name, issue: parsed.issueNumber }, "Fix command queued");

            // /gitwire waive/unwaive — handle directly with DB
            } else if (action.action === "grant_waiver" || action.action === "revoke_waiver") {
              const { grantWaiver, revokeWaiver } = await import("../services/waiverService.js");
              const repoFullName = payload.repository?.full_name;
              const { rows: [repoRow] } = await db.query(
                "SELECT github_id FROM repositories WHERE full_name = $1",
                [repoFullName]
              );

              let waiverResult;
              if (action.action === "grant_waiver") {
                if (!repoRow) {
                  waiverResult = { error: "Repository not found" };
                } else {
                  waiverResult = await grantWaiver({
                    repoId: repoRow.github_id,
                    pillar: action.pillar,
                    scope: action.scope,
                    scopeValue: action.scopeValue,
                    reason: action.reason,
                    grantedBy: parsed.authorLogin,
                    expiresAt: action.expiresAt,
                  });
                }
              } else {
                waiverResult = await revokeWaiver(action.waiverId, parsed.authorLogin);
              }

              // Post response comment
              const respBody = buildCommandResponse(action.action, {
                waiver: waiverResult,
                waiverId: action.waiverId,
              });
              if (respBody && payload.installation?.id) {
                try {
                  const octokit = wrapOctokit(await getInstallationClient(payload.installation.id));
                  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
                    owner: repoFullName.split("/")[0],
                    repo: repoFullName.split("/")[1],
                    issue_number: parsed.issueNumber,
                    body: respBody,
                  });
                } catch (commentErr) {
                  logger.warn({ err: commentErr.message }, "Failed to post waiver response comment");
                }
              }
              logger.info({ command: action.action, repo: repoFullName }, "Waiver command processed");

            } else {
              await maintainerQueue.add("comment-command", {
                ...action,
                installationId: payload.installation?.id,
                repoFullName: payload.repository?.full_name,
                issueNumber: parsed.issueNumber,
                commentId: parsed.commentId,
                authorLogin: parsed.authorLogin,
              }, { priority: 1 });
              logger.info({ command: parsed.command, repo: payload.repository?.full_name }, "Gitwire comment command queued");
            }
          }
        }
      }
      break;

    // All other events → general queue for logging / future use
    default:
      await webhookQueue.add("generic-event", jobData, { priority: 10 });
  }
}

// ── Middleware: capture raw body for signature verification ──────────────────
// Express's built-in json() middleware consumes the body stream.
// We need the raw Buffer to verify the HMAC signature correctly.
function express_raw_body_middleware() {
  return (req, _res, next) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", next);
  };
}
