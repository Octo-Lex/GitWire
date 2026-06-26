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
import { redis } from "../lib/queue.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { evaluateAndExecuteCustomRules } from "../services/customRulesService.js";
import { evaluateGatesForPR as evaluateQualityGates } from "../services/qualityGateService.js";
import { notifyCustomRule, notifyGateResult } from "../services/telegramNotifyService.js";
import { createGitwireCheck, updateGitwireCheck, buildCheckSummary, conclusionFromDecision } from "../lib/checkStatus.js";
import { sanitizeWebhookPayload } from "../lib/githubSanitize.js";
import { routeWebhookToQueue } from "../lib/webhookHandlers/index.js";

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

    // ── 3. Create GitWire check for PR open events BEFORE queuing jobs ───
    // Only create on open/reopen/ready — NOT on every pull_request event.
    // Labels, edits, syncs etc. will trigger pull_request webhooks that would
    // create duplicate orphaned check runs.
    if (
      eventName === "pull_request" &&
      ["opened", "reopened", "ready_for_review"].includes(payload.action) &&
      payload.pull_request?.head?.sha
    ) {
      try {
        const octokit = wrapOctokit(await getInstallationClient(payload.installation?.id));
        if (octokit) {
          const checkRunId = await createGitwireCheck({
            octokit,
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            headSha: payload.pull_request.head.sha,
            status: "queued",
            title: "GitWire \u2014 evaluating\u2026",
            summary: "GitWire is processing this PR. Results will appear here shortly.",
          });
          if (checkRunId) {
            const checkKey = "gitwire:check:" + payload.repository.id + ":" + payload.pull_request.number + ":" + payload.pull_request.head.sha;
            await redis.setex(checkKey, 86400, String(checkRunId));
            logger.debug({ checkRunId, pr: payload.pull_request.number }, "GitWire check created and stored in Redis");
          }
        }
      } catch (err) {
        logger.warn({ err: err.message }, "Failed to create GitWire check on PR (non-fatal)");
      }
    }

    // ── 4. Enqueue based on event type ────────────────────────────────────
    await routeWebhookToQueue(eventName, payload, deliveryId);

    // ── 4a. Evaluate custom rules ────────────────────────────────────────────
    if (["issues", "pull_request", "issue_comment"].includes(eventName)) {
      try {
        const customResults = await evaluateAndExecuteCustomRules(eventName, payload, payload.installation);
        if (customResults.length > 0) {
          logger.info(
            { deliveryId, rules: customResults.map((r) => r.name) },
            "Custom rules executed"
          );
          // Notify Telegram subscribers (non-blocking but caught)
          for (const r of customResults) {
            notifyCustomRule(payload.repository.full_name, {
              rule_name: r.name,
              action_type: r.actions?.[0]?.type,
              matched: true,
            }).catch((err) => {
              logger.warn({ err: err.message }, "Telegram custom rule notification failed (non-fatal)");
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
            // Notify Telegram subscribers (non-blocking but caught)
            const allPassed = failed.length === 0;
            notifyGateResult(payload.repository.full_name, {
              pr_number: pr.number,
              passed: allPassed,
              gate_name: gateResults.map((g) => g.name).join(", "),
              summary: allPassed ? "All gates passed" : `${failed.length} gate(s) failed`,
            }).catch((err) => {
              logger.warn({ err: err.message }, "Telegram gate result notification failed (non-fatal)");
            });
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, deliveryId }, "Quality gate evaluation failed (non-fatal)");
      }
    }

    // ── 5. Log delivery for audit ──────────────────────────────────────────
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

// routeWebhookToQueue is now in ../lib/webhookHandlers/index.js
// Each event type has its own handler file in ../lib/webhookHandlers/.

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
