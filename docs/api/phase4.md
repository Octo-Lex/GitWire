# Intelligence & Audit API

13 endpoints for AI code review and audit trail management.

## AI Review

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/review/stats` | Review statistics |
| `GET` | `/api/review/results` | All review results |
| `GET` | `/api/review/results/:owner/:repo` | Reviews for a repo |
| `GET` | `/api/review/config/:owner/:repo` | Get review config |
| `POST` | `/api/review/config/:owner/:repo` | Update review config |
| `POST` | `/api/review/trigger/:owner/:repo/:pr` | Trigger manual review |

## Audit Trail

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit/stats` | Audit statistics |
| `GET` | `/api/audit/entries` | Audit trail entries |
| `GET` | `/api/audit/verify` | Verify SHA-256 chain integrity |
| `POST` | `/api/audit/export` | Export audit data |

## Compliance Reports

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/audit/reports` | List compliance reports |
| `POST` | `/api/audit/reports` | Generate a report |
| `GET` | `/api/audit/reports/:id` | Get a specific report |

→ [Webhooks API](/api/webhooks)
