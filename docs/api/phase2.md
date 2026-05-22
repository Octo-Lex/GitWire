# Merge Queue & Automation API

14 endpoints for merge queue management, feedback rules, telemetry, and rollbacks.

## Merge Queue

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase2/queue` | List all queue entries |
| `GET` | `/api/phase2/queue/:owner/:repo` | Queue for a repo |
| `POST` | `/api/phase2/queue/:owner/:repo/config` | Set queue config |
| `POST` | `/api/phase2/queue/:owner/:repo/:pr/admit` | Admit PR to queue |
| `POST` | `/api/phase2/queue/:owner/:repo/:pr/remove` | Remove PR from queue |

## Feedback Rules

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase2/feedback` | List feedback rules |
| `POST` | `/api/phase2/feedback` | Create feedback rule |
| `PUT` | `/api/phase2/feedback/:id` | Update rule |
| `DELETE` | `/api/phase2/feedback/:id` | Delete rule |

## Telemetry

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase2/telemetry/summary` | Queue health summary |
| `GET` | `/api/phase2/telemetry/events` | Pipeline events |
| `GET` | `/api/phase2/telemetry/throughput` | Merge throughput |
| `GET` | `/api/phase2/telemetry/ci-health` | CI health stats |

## Rollbacks

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/phase2/rollbacks` | Rollback history |

→ [Trust & Dependencies API](/api/phase3)
