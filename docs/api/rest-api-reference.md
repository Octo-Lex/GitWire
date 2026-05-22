# REST API Reference

GitWire exposes a REST API with 102 endpoints across 15 route files.

## Authentication

All API endpoints (except `/health` and `/webhooks`) require an API key:

```bash
curl https://gitwire.yourdomain.com/api/repos \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Set your API key via the `API_KEY` or `API_KEYS` environment variable. See [Environment Variables](/installation/environment-variables).

## Pagination

List endpoints support pagination via query parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number |
| `limit` | 50 | Items per page (max 100) |

Response includes pagination metadata:

```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 50,
    "total": 142,
    "pages": 3
  }
}
```

## Error Format

All errors follow this structure:

```json
{
  "error": "Not Found",
  "message": "Repository owner/repo not found",
  "status": 404
}
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request (missing parameters) |
| 401 | Unauthorized (missing/invalid API key) |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Internal server error |

## Rate Limiting

API requests are rate-limited via Redis. Default: 100 requests per minute per IP.

## Base URL

All endpoints are relative to your GitWire instance:

```
https://gitwire.yourdomain.com/api
```

## Endpoint Summary

| Route File | Prefix | Endpoints | Section |
|------------|--------|-----------|---------|
| `repos.js` | `/api/repos` | 3 | [Repos](/api/repos) |
| `issues.js` | `/api/issues` | 3 | [Issues](/api/issues) |
| `pullRequests.js` | `/api/pull-requests` | 3 | [Pull Requests](/api/pull-requests) |
| `ciRuns.js` | `/api/ci` | 4 | [CI Runs](/api/ci-runs) |
| `insights.js` | `/api/insights` | 4 | [Insights](/api/insights) |
| `fix.js` | `/api/fix` | 3 | [Fix Attempts](/api/fix-attempts) |
| `healHistory.js` | `/api/heal` | 4 | [Heal History](/api/heal-history) |
| `duplicates.js` | `/api/duplicates` | 7 | [Duplicates](/api/duplicates) |
| `maintainer.js` | `/api/maintainer` | 17 | [Maintainer](/api/maintainer) |
| `enforcement.js` | `/api/enforcement` | 11 | [Enforcement](/api/enforcement) |
| `phase2.js` | `/api/phase2` | 14 | [Merge Queue](/api/phase2) |
| `phase3.js` | `/api/phase3` | 15 | [Trust](/api/phase3) |
| `phase4.js` | `/api` | 13 | [Intelligence](/api/phase4) |
| `webhooks.js` | `/webhooks` | 1 | [Webhooks](/api/webhooks) |

## In This Section

- [Repos](/api/repos)
- [Issues](/api/issues)
- [Pull Requests](/api/pull-requests)
- [CI Runs](/api/ci-runs)
- [Insights](/api/insights)
- [Fix Attempts](/api/fix-attempts)
- [Heal History](/api/heal-history)
- [Duplicates](/api/duplicates)
- [Maintainer](/api/maintainer)
- [Enforcement](/api/enforcement)
- [Merge Queue & Automation](/api/phase2)
- [Trust & Dependencies](/api/phase3)
- [Intelligence & Audit](/api/phase4)
- [Webhooks](/api/webhooks)
