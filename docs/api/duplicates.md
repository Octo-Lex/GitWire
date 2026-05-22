# Duplicates API

Duplicate detection signal management and embedding operations.

## Statistics

```
GET /api/duplicates/stats
```

```json
{
  "total_signals": 24,
  "confirmed": 8,
  "dismissed": 6,
  "pending": 10,
  "embedding_coverage": 1.0
}
```

## List Duplicate Signals

```
GET /api/duplicates
```

All duplicate signals. Supports pagination.

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | TEXT | `pending`, `confirmed`, `dismissed` |
| `page` | INT | Page number |
| `limit` | INT | Items per page |

## Signals by Repo

```
GET /api/duplicates/:owner/:repo
```

## Signals by Issue

```
GET /api/duplicates/issue/:githubIssueId
```

All duplicate signals for a specific issue.

## Confirm Duplicate

```
POST /api/duplicates/:id/confirm
```

Confirm that a signal is a genuine duplicate.

```bash
curl -X POST https://gitwire.yourdomain.com/api/duplicates/1/confirm \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Dismiss Signal

```
POST /api/duplicates/:id/dismiss
```

Dismiss a false positive signal.

## Backfill Embeddings

```
POST /api/duplicates/backfill/:owner/:repo
```

Generate embeddings for all existing issues in a repository. Useful when enabling duplicate detection on a repo with pre-existing issues.

```bash
curl -X POST https://gitwire.yourdomain.com/api/duplicates/backfill/owner/repo \
  -H "Authorization: Bearer YOUR_API_KEY"
```

→ [Maintainer API](/api/maintainer)
