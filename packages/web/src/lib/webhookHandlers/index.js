// src/lib/webhookHandlers/index.js
// Extracted handlers for each GitHub webhook event type.
//
// Each handler receives (payload, deliveryId, ctx) where ctx contains
// shared queue references and utility functions.
// The main routeWebhookToQueue dispatcher lives here as a thin lookup.

import { webhookQueue, triageQueue, ciHealQueue, maintainerQueue, issueFixQueue, phase2Queue, phase3Queue, phase4Queue, redis } from "../../lib/queue.js";
import { db } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { parseGitwireCommand, resolveCommandAction, buildCommandResponse } from "../../lib/commentRouter.js";
import { invalidateConfigCache } from "../../services/configService.js";
import { wrapOctokit } from "../../lib/githubWrapper.js";
import { getInstallationClient } from "../../lib/github.js";

import { handleIssues } from "./handleIssues.js";
import { handlePullRequest } from "./handlePullRequest.js";
import { handlePullRequestReview } from "./handlePullRequestReview.js";
import { handleCheckSuite } from "./handleCheckSuite.js";
import { handleWorkflowRun } from "./handleWorkflowRun.js";
import { handleInstallation } from "./handleInstallation.js";
import { handlePush } from "./handlePush.js";
import { handleIssueComment } from "./handleIssueComment.js";
import { handleRelease } from "./handleRelease.js";

// Shared context passed to every handler — avoids importing queues in each file.
const ctx = {
  webhookQueue,
  triageQueue,
  ciHealQueue,
  maintainerQueue,
  issueFixQueue,
  phase2Queue,
  phase3Queue,
  phase4Queue,
  redis,
  db,
  logger,
  getInstallationClient,
  wrapOctokit,
};

const handlers = {
  issues:               handleIssues,
  pull_request:         handlePullRequest,
  pull_request_review:  handlePullRequestReview,
  check_suite:          handleCheckSuite,
  workflow_run:         handleWorkflowRun,
  installation:               handleInstallation,
  installation_repositories:  handleInstallation,
  push:                 handlePush,
  issue_comment:        handleIssueComment,
  release:              handleRelease,
};

/**
 * Thin dispatcher — routes webhook events to the appropriate handler.
 * CC target: ~3 (just a lookup + try/catch)
 */
export async function routeWebhookToQueue(eventName, payload, deliveryId) {
  const handler = handlers[eventName];

  if (handler) {
    await handler(payload, deliveryId, ctx);
  } else {
    const jobData = { eventName, payload, deliveryId, receivedAt: Date.now() };
    await ctx.webhookQueue.add("generic-event", jobData, { priority: 10 });
  }
}

// Re-export ctx for individual handler tests
export { ctx };
