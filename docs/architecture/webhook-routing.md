# Webhook Routing

How GitWire dispatches incoming GitHub webhooks to handler functions.

## The Problem

The original webhook router was a single function in `routes/webhooks.js` with cyclomatic complexity 46. Every event type, action filter, and queue dispatch lived in one giant switch-case.

## The Solution: Handler Registry

The router was refactored (v0.13.0) using the **extract-dispatch-delegate** pattern:

1. **Extract** — each event type's logic moved to its own file in `lib/webhookHandlers/`
2. **Dispatch** — a registry lookup replaces the switch-case
3. **Delegate** — each handler focuses on a single event type

## Registry Pattern

```javascript
// lib/webhookHandlers/index.js
const handlers = {
  issues:               handleIssues,
  pull_request:         handlePullRequest,
  pull_request_review:  handlePullRequestReview,
  check_suite:          handleCheckSuite,
  workflow_run:         handleWorkflowRun,
  installation:         handleInstallation,
  installation_repositories: handleInstallation,
  push:                 handlePush,
  issue_comment:        handleIssueComment,
};

export async function routeWebhookToQueue(eventName, payload, deliveryId) {
  const handler = handlers[eventName];
  if (handler) {
    await handler(payload, deliveryId, ctx);
  } else {
    await ctx.webhookQueue.add("generic-event", jobData);
  }
}
```

The main dispatcher is now CC ~3 — just a lookup and try/catch.

## Handler Files

```
lib/webhookHandlers/
├── index.js                    # Registry + dispatcher
├── handleIssues.js             # issues → triage queue
├── handlePullRequest.js        # pull_request → triage + phase4 + reconcile
├── handlePullRequestReview.js  # pull_request_review → phase2 (merge queue)
├── handleCheckSuite.js         # check_suite → phase2 check
├── handleWorkflowRun.js        # workflow_run → ci-heal + phase2 + rollback
├── handleInstallation.js       # installation → sync queue
├── handlePush.js               # push → config cache invalidation
├── handleIssueComment.js       # issue_comment → comment command router
└── commentCommands/
    ├── handleManualRun.js      # /gitwire run [pillar]
    ├── handleFixCommand.js     # /gitwire fix
    └── handleWaiverCommand.js  # /gitwire waive/unwaive
```

## Shared Context

Each handler receives a shared `ctx` object instead of importing queues directly:

| Field | Source | Purpose |
|-------|--------|---------|
| `triageQueue` | BullMQ | Triage jobs |
| `ciHealQueue` | BullMQ | CI healing jobs |
| `issueFixQueue` | BullMQ | Issue fix pipeline |
| `phase2Queue` | BullMQ | Merge queue + error recovery |
| `phase3Queue` | BullMQ | Trust + deps + policy |
| `phase4Queue` | BullMQ | AI review + audit |
| `redis` | ioredis | Idempotency keys, caching |
| `db` | pg | Database queries |
| `logger` | pino | Structured logging |
| `getInstallationClient` | @octokit/app | Per-installation GitHub client |
| `wrapOctokit` | githubWrapper.js | Cache + rate limit + sanitize wrapper |

## Why This Pattern

| Before (monolith) | After (registry) |
|-------------------|-----------------|
| CC 46 | CC ~3 (dispatcher), CC 3-8 (handlers) |
| 548 lines in one file | ~60 lines per handler |
| Any change risks all events | Changes isolated to one handler |
| Hard to test individual events | Each handler testable independently |

→ [Webhook Worker](/workers/webhook-worker) | [Data Flow](/architecture/data-flow) | [Comment Commands](/pillars/triage/comment-commands)

> **Last validated:** v0.13.0
