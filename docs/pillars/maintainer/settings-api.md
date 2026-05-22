# Settings API

Read and update per-repository maintainer settings.

## Get Settings

```bash
curl https://gitwire.yourdomain.com/api/maintainer/owner/repo/settings \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Response:

```json
{
  "repo_id": 12345,
  "stale_issue_days": 60,
  "stale_pr_days": 30,
  "stale_warn_days": 7,
  "cleanup_branches": true,
  "enabled": true
}
```

## Update Settings

```bash
curl -X PATCH https://gitwire.yourdomain.com/api/maintainer/owner/repo/settings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "stale_issue_days": 90,
    "stale_pr_days": 45,
    "stale_warn_days": 14,
    "cleanup_branches": true,
    "enabled": true
  }'
```

## Settings Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `stale_issue_days` | INT | 60 | Days before an issue is considered stale |
| `stale_pr_days` | INT | 30 | Days before a PR is considered stale |
| `stale_warn_days` | INT | 7 | Days after warning before closing |
| `cleanup_branches` | BOOLEAN | `true` | Enable automatic branch cleanup |
| `enabled` | BOOLEAN | `true` | Enable all maintainer features for this repo |

## Default Settings

When a repo is first synced, default settings are created automatically. No manual setup needed — defaults work for most repositories.

## Audit Trail

Settings changes are logged in the `audit_log` table:

```json
{
  "actor": "admin",
  "action": "settings.update",
  "target_type": "repo",
  "target_id": "owner/repo"
}
```

→ [Multi-Repo Insights](/pillars/insights/multi-repo-insights)
