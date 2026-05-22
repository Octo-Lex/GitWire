# CI Runs API

CI run listing, statistics, and healing retry.

## List CI Runs

```
GET /api/ci
```

All CI runs across all repos. Supports pagination and filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | INT | Page number |
| `limit` | INT | Items per page |
| `conclusion` | TEXT | `success`, `failure`, `cancelled`, etc. |
| `heal_status` | TEXT | `pending`, `attempted`, `healed`, `failed`, `skipped` |

## Get Repo CI Runs

```
GET /api/ci/:owner/:repo
```

CI runs for a specific repository.

## CI Statistics

```
GET /api/ci/stats
```

```json
{
  "total": 234,
  "success": 187,
  "failure": 42,
  "success_rate": 0.82,
  "healed": 28,
  "heal_success_rate": 0.67
}
```

## Retry Healing

```
POST /api/ci/:runId/retry
```

Re-trigger healing for a specific CI run. Useful when the first attempt failed due to a transient error.

```bash
curl -X POST https://gitwire.yourdomain.com/api/ci/12345/retry \
  -H "Authorization: Bearer YOUR_API_KEY"
```

→ [Insights API](/api/insights)
