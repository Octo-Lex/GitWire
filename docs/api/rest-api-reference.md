# REST API Reference

GitWire exposes a REST API with 154 endpoints across 25 route files.

## Authentication

All API endpoints (except `/health` and `/webhooks`) require authentication. Two methods are supported:

**API Key (Bearer token):**

```bash
curl https://gitwire.yourdomain.com/api/repos \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Session cookie (dashboard login):**

Dashboard login creates a Redis-backed session stored in an httpOnly cookie (`gitwire-session`). The cookie is automatically sent with subsequent requests.

Set your API key via the `API_KEY` or `API_KEYS` environment variable. See [Environment Variables](/installation/environment-variables).

## Pagination

List endpoints support pagination via query parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `page` | 1 | Page number |
| `per_page` | 20 | Items per page (max 100) |

Response includes pagination metadata:

```json
{
  "data": [...],
  "meta": {
    "page": 1,
    "per_page": 20,
    "total": 142,
    "total_pages": 8
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

API requests are rate-limited via Redis. Default: 100 requests per minute per IP. Health endpoint exempt.

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
| `ciRuns.js` | `/api/ci` | 5 | [CI Runs](/api/ci-runs) |
| `insights.js` | `/api/insights` | 5 | [Insights](/api/insights) |
| `fix.js` | `/api/fix` | 3 | [Fix Attempts](/api/fix-attempts) |
| `healHistory.js` | `/api/heal` | 4 | [Heal History](/api/heal-history) |
| `duplicates.js` | `/api/duplicates` | 7 | [Duplicates](/api/duplicates) |
| `maintainer.js` | `/api/maintainer` | 17 | [Maintainer](/api/maintainer) |
| `enforcement.js` | `/api/enforcement` | 12 | [Enforcement](/api/enforcement) |
| `phase2.js` | `/api/phase2` | 15 | [Merge Queue](/api/phase2) |
| `phase3.js` | `/api/phase3` | 16 | [Trust](/api/phase3) |
| `phase4.js` | `/api` | 13 | [Intelligence](/api/phase4) |
| `actions.js` | `/api/actions` | 6 | Actions |
| `activity.js` | `/api/activity` | 2 | Activity Feed |
| `auth.js` | `/api/auth` | 4 | Auth (login/logout/session) |
| `config.js` | `/api/config` | 8 | Config |
| `decisions.js` | `/api/decisions` | 2 | [Decisions](/api/decisions) |
| `gates.js` | `/api/gates` | 8 | [Quality Gates](/api/gates) |
| `githubRelay.js` | `/api/github` | 3 | GitHub API Relay |
| `readiness.js` | `/api/readiness` | 2 | Repo Readiness |
| `transfers.js` | `/api/transfers` | 3 | Repo Transfers |
| `waivers.js` | `/api/waivers` | 4 | [Waivers](/api/waivers) |
| `webhookDeliveries.js` | `/api/deliveries` | 5 | Webhook Deliveries |
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
- [Decisions](/api/decisions)
- [Maintainer](/api/maintainer)
- [Enforcement](/api/enforcement)
- [Merge Queue & Automation](/api/phase2)
- [Trust & Dependencies](/api/phase3)
- [Intelligence & Audit](/api/phase4)
- [Quality Gates](/api/gates)
- [Waivers](/api/waivers)
- [Webhooks](/api/webhooks)

> **Last validated:** v0.13.0
