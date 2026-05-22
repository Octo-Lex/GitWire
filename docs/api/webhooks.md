# Webhooks API

GitHub webhook receiver endpoint.

## Receive Webhook

```
POST /webhooks/github
```

This endpoint receives webhooks from GitHub. It is called automatically by GitHub when events occur on installed repositories.

**You should not call this endpoint directly.** GitHub sends events here based on your GitHub App configuration.

### Webhook Verification

All incoming webhooks are verified using the `GITHUB_WEBHOOK_SECRET` environment variable. The signature is validated using HMAC-SHA256.

### Event Routing

The webhook worker routes events based on the `X-GitHub-Event` header:

| Event | Actions | Routed To |
|-------|---------|-----------|
| `issues` | opened, labeled, closed | Triage worker |
| `issue_comment` | created | Comment router |
| `pull_request` | opened, synchronize | Triage worker, AI Review |
| `pull_request_review` | submitted | Feedback processing |
| `push` | — | Config validation |
| `repository` | created, deleted | Sync worker |
| `workflow_run` | completed | CI Heal worker |
| `installation` | created, deleted | Sync worker |
| `installation_repositories` | added, removed | Sync worker |

### Webhook Delivery Logging

Every webhook delivery is logged in the `webhook_deliveries` table:

| Field | Description |
|-------|-------------|
| `delivery_id` | GitHub's unique delivery ID |
| `event_name` | Event type (e.g. `issues`) |
| `action` | Event action (e.g. `opened`) |
| `repo` | Repository full name |
| `processed` | Whether the webhook was handled |
| `error` | Error message if processing failed |

→ [Database Schema](/database/database-schema)
