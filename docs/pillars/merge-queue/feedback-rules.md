# Feedback Rules

Configure notifications for merge queue and pipeline events.

## Creating a Rule

```bash
curl -X POST https://gitwire.yourdomain.com/api/phase2/feedback \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "slack-on-failure",
    "event_type": "merge_failure",
    "repo_filter": "*",
    "post_pr_comment": true,
    "slack_webhook": "https://hooks.slack.com/services/...",
    "include_log_link": true,
    "include_diff_preview": false,
    "enabled": true
  }'
```

## Rule Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | TEXT | Human-readable rule name |
| `event_type` | TEXT | Event to trigger on (see below) |
| `repo_filter` | TEXT | Glob pattern for repo matching (`*` = all) |
| `post_pr_comment` | BOOLEAN | Post a comment on the PR |
| `slack_webhook` | TEXT | Slack webhook URL (optional) |
| `teams_webhook` | TEXT | Microsoft Teams webhook URL (optional) |
| `include_log_link` | BOOLEAN | Include CI log link in notification |
| `include_diff_preview` | BOOLEAN | Include diff preview |
| `enabled` | BOOLEAN | Enable/disable the rule |

## Event Types

| Event | When It Triggers |
|-------|------------------|
| `merge_success` | PR merged successfully |
| `merge_failure` | Merge failed |
| `merge_blocked` | PR blocked by checks |
| `queue_admitted` | PR admitted to queue |
| `rollback` | Merge was rolled back |

## Managing Rules

```bash
# List all rules
curl https://gitwire.yourdomain.com/api/phase2/feedback \
  -H "Authorization: Bearer YOUR_API_KEY"

# Update a rule
curl -X PUT https://gitwire.yourdomain.com/api/phase2/feedback/1 \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'

# Delete a rule
curl -X DELETE https://gitwire.yourdomain.com/api/phase2/feedback/1 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

→ [AI Review Gate](/pillars/review-gate/ai-review-gate)
