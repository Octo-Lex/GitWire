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
import { getWebhookApp } from "../lib/github.js";
import { webhookQueue, triageQueue, ciHealQueue, maintainerQueue } from "../lib/queue.js";
import { db } from "../lib/db.js";
import { logger } from "../lib/logger.js";
import { parseGitwireCommand, resolveCommandAction } from "../lib/commentRouter.js";

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

    // ── 3. Enqueue based on event type ────────────────────────────────────
    await routeWebhookToQueue(eventName, payload, deliveryId);

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

    // Pull requests → triage queue
    case "pull_request":
      if (["opened", "reopened", "ready_for_review"].includes(payload.action)) {
        await triageQueue.add("triage-pr", jobData, { priority: 2 });
        logger.info({ action: payload.action, pr: payload.pull_request?.number }, "PR queued for triage");
      }
      break;

    // CI failures → self-healing queue
    case "workflow_run":
      if (payload.action === "completed" && payload.workflow_run?.conclusion === "failure") {
        await ciHealQueue.add("heal-run", jobData, { priority: 1 });
        logger.info(
          { runId: payload.workflow_run?.id, repo: payload.repository?.full_name },
          "Failed CI run queued for healing"
        );
      }
      break;

    // App installation events → general queue (store installation info)
    case "installation":
    case "installation_repositories":
      await webhookQueue.add("sync-installation", jobData);
      break;

    // Push events → trigger incremental sync
    case "push":
      await webhookQueue.add("sync-repo", jobData, { priority: 3 });
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
