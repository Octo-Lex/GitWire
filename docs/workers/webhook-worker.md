# Webhook Worker

Receives and routes all incoming GitHub webhooks.

## Queue: `webhook-events`

## Event Routing

The webhook worker receives every GitHub webhook, verifies its signature, and routes it to the appropriate downstream queue:

| Incoming Event | Routed To | Trigger |
|---------------|-----------|---------|
| `issues` (opened, labeled) | `triage` | New issue to classify |
| `issue_comment` (created) | Direct handler | Comment command |
| `pull_request` (opened, synchronize) | `triage`, `phase4` | PR triage + AI review |
| `push` | `phase2`, `phase3` | Config validation |
| `workflow_run` (completed, failure) | `ci-healing` | CI failure to diagnose |
| `repository` (created, deleted) | `sync` | New/deleted repo |
| `installation` (created) | `sync` | New installation |
| `installation_repositories` (added) | `sync` | New repos added |

## Webhook Verification

Every webhook is verified using HMAC-SHA256 with the `GITHUB_WEBHOOK_SECRET`. Invalid signatures are rejected with 401.

## Delivery Logging

All webhooks are logged in `webhook_deliveries` with:
- Delivery ID, event name, action
- Processing status (success/failed)
- Error message if failed

→ [Triage Worker](/workers/triage-worker)
