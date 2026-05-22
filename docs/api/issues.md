# Issues API

Issue listing and triage statistics.

## List Issues

```
GET /api/issues
```

All issues across all repos. Supports pagination and filters.

| Parameter | Type | Description |
|-----------|------|-------------|
| `page` | INT | Page number (default 1) |
| `limit` | INT | Items per page (default 50) |
| `state` | TEXT | `open` or `closed` |
| `owner` | TEXT | Filter by repo owner |
| `repo` | TEXT | Filter by repo name |

## Get Repo Issues

```
GET /api/issues/:owner/:repo
```

Issues for a specific repository.

## Issue Statistics

```
GET /api/issues/stats
```

```json
{
  "total": 142,
  "open": 42,
  "closed": 100,
  "by_type": { "bug": 38, "feature": 22, "question": 15 },
  "by_priority": { "critical": 3, "high": 12, "medium": 18, "low": 9 }
}
```

→ [Pull Requests API](/api/pull-requests)
