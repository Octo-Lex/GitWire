# Decisions API

Query GitWire's decision log — why every worker acted, skipped, or was blocked.

## Endpoints

### List Decisions

```
GET /api/decisions
```

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | string | all | Filter by worker source (`ci_heal`, `triage`, `ai_review`) |
| `decision` | string | all | Filter by decision type (`acted`, `skipped`, `blocked`) |
| `page` | number | 1 | Page number |
| `per_page` | number | 20 | Results per page (max: 100) |

**Response:**

```json
{
  "data": [
    {
      "id": 1,
      "source": "ci_heal",
      "trigger_event": "workflow_run.completed",
      "target_type": "pr",
      "target_number": 0,
      "pillar": "ci_healing",
      "decision": "acted",
      "reason": "CI heal patch PR created",
      "conditions": [
        { "check": "pillar_enabled(ci_healing)", "result": true },
        { "check": "confidence(high) >= threshold(medium)", "result": true }
      ],
      "commit_sha": "abc123",
      "created_at": "2026-05-23T18:00:00Z"
    }
  ],
  "meta": {
    "total": 42,
    "page": 1,
    "perPage": 20,
    "totalPages": 3
  }
}
```

### Decision Summary

```
GET /api/decisions/summary
```

**Response:**

```json
{
  "data": [
    { "source": "ci_heal", "acted": 15, "skipped": 8, "blocked": 2 },
    { "source": "triage", "acted": 30, "skipped": 5, "blocked": 0 }
  ]
}
```

## Authentication

All endpoints require the `Authorization: Bearer <API_KEY>` header.
