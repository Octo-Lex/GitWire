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
import { adoptWorker, workerPrincipalId } from "../services/auth/workerAdoption.js";

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

    // ── 2c. Wave 2: resolve trusted installation principal ────────────────
    // The webhook HMAC proves ingress authenticity. The installation_id comes
    // from the verified payload, NOT from a client-supplied field. The sender
    // login is retained only as non-authoritative compatibility metadata.
    const webhookAdoption = await adoptWorker({
      workerId: "webhook:github",
      permission: "installation:read",
      resourceType: "installation",
      installationId: payload.installation?.id,
      jobData: { payload },
      legacyActor: payload.sender?.login,
    });
    const webhookPrincipalId = workerPrincipalId(webhookAdoption.context);

    // ── 3. Create GitWire check for PR open events BEFORE queuing jobs ───
    // Only create on open/reopen/ready — NOT on every pull_request event.
    // Labels, edits, syncs etc. will trigger pull_request webhooks that would
    // create duplicate orphaned check runs.
    let checkRunId = null;
    if (
      eventName === "pull_request" &&
      ["opened", "reopened", "ready_for_review"].includes(payload.action) &&
      payload.pull_request?.head?.sha
    ) {
      try {
        const octokit = wrapOctokit(await getInstallationClient(payload.installation?.id));
        if (octokit) {
          checkRunId = await createGitwireCheck({
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
    await routeWebhookToQueue(eventName, payload, deliveryId, { checkRunId });

    // ── 4a. Evaluate custom rules ────────────────────────────────────────────
    if (["issues", "pull_request", "issue_comment"].includes(eventName)) {
      try {
        const customResults = await evaluateAndExecuteCustomRules(eventName, payload, payload.installation, webhookPrincipalId);
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
//
// #10 resource-exhaustion guard: GitHub's documented webhook payload ceiling
// is 25 MB — nothing legitimate can exceed it, so the stream is rejected
// WHILE READING once the received byte count passes the cap. Content-Length
// is checked first as an early-out optimization only; it is client-supplied
// and never the enforcement. Oversized requests get 413 without HMAC
// verification, JSON parsing, or dispatch.
const WEBHOOK_MAX_BODY_BYTES = 25 * 1024 * 1024;

export function express_raw_body_middleware() {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isInteger(declared) && declared > WEBHOOK_MAX_BODY_BYTES) {
      // The body was never read, but the client may keep transmitting its
      // declared body after the response. Explicit disposition mirrors the
      // streaming path: close the connection (the socket reaps once the
      // peer finishes or drops) and detach from the stream entirely — no
      // data listener is attached, so nothing can buffer.
      res.setHeader("connection", "close");
      res.status(413).json({ error: "Payload too large" });
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      req.resume();
      return;
    }

    const chunks = [];
    let received = 0;
    let settled = false;

    const detach = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };

    const onData = (chunk) => {
      received += chunk.length;
      if (received > WEBHOOK_MAX_BODY_BYTES) {
        settled = true;
        detach();
        // Respond once and discard the rest of the stream without
        // buffering. Destroying the socket instead would race an RST
        // against the in-flight 413 and the peer could lose the response;
        // draining bounds memory while the closed connection reaps the
        // socket when the peer finishes.
        res.setHeader("connection", "close");
        res.status(413).json({ error: "Payload too large" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      detach();
      // Byte-exact: the accepted body reaches HMAC verification unchanged.
      req.rawBody = Buffer.concat(chunks);
      next();
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      detach();
      next(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  };
}
