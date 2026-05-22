# Pull Requests API

Pull request listing and statistics.

## List Pull Requests

```
GET /api/pull-requests
```

All PRs across all repos. Supports pagination.

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | INT | Page number |
| `limit` | INT | Items per page |
| `state` | TEXT | `open`, `closed`, or `merged` |

## Get Repo Pull Requests

```
GET /api/pull-requests/:owner/:repo
```

## PR Statistics

```
GET /api/pull-requests/stats
```

```json
{
  "total": 67,
  "open": 12,
  "merged": 48,
  "closed": 7,
  "avg_merge_time_hours": 36
}
```

→ [CI Runs API](/api/ci-runs)
