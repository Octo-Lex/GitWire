# Quality Gates API

## Endpoints

### GET /api/gates

Fleet-wide gate summary across all repos.

**Response:**
```json
{
  "total_repos": 3,
  "passed": 2,
  "failed": 1,
  "repos": [
    {
      "repo": "org/repo",
      "repoId": 12345,
      "overall": "passed",
      "gates": [
        {
          "name": "default",
          "result": "passed",
          "score": 100,
          "block_on_fail": true,
          "evaluated_at": "2026-05-24T00:00:00Z"
        }
      ]
    }
  ]
}
```

### GET /api/gates/:owner/:repo

Get gate definitions and latest evaluation results for a repo.

**Response:**
```json
{
  "repo": "org/repo",
  "overall": "passed",
  "gates": [
    {
      "id": 1,
      "name": "default",
      "is_default": true,
      "conditions": [
        { "metric": "ci_failure_rate_7d", "operator": "<", "threshold": 0.3 }
      ],
      "block_on_fail": true,
      "latest_evaluation": {
        "result": "passed",
        "score": 100,
        "passed_count": 3,
        "failed_count": 0,
        "total_count": 3,
        "conditions": [
          {
            "metric": "ci_failure_rate_7d",
            "operator": "<",
            "threshold": 0.3,
            "actual": 0.15,
            "passed": true
          }
        ],
        "evaluated_at": "2026-05-24T00:00:00Z"
      }
    }
  ],
  "total": 1
}
```

### POST /api/gates/:owner/:repo

Create or update a gate definition.

**Body:**
```json
{
  "name": "strict",
  "conditions": [
    { "metric": "ci_failure_rate_7d", "operator": "<", "threshold": 0.1 },
    { "metric": "triage_coverage", "operator": ">=", "threshold": 0.8 }
  ],
  "block_on_fail": true,
  "is_default": false
}
```

**Response:** `201` with the created gate row.

### DELETE /api/gates/:owner/:repo/:name

Delete a gate definition.

**Response:** `{ "deleted": true }`

### POST /api/gates/:owner/:repo/evaluate

Trigger manual gate evaluation.

**Body (optional):**
```json
{
  "head_sha": "abc123...",
  "pr_number": 42
}
```

If `head_sha` is provided, GitWire will also post a GitHub check.

**Response:**
```json
{
  "repo": "org/repo",
  "results": [
    {
      "name": "default",
      "result": "passed",
      "conditions": [...],
      "score": 100
    }
  ]
}
```

### GET /api/gates/:owner/:repo/history

Evaluation history for a repo.

**Query params:**
- `limit` — max results (default 20, max 100)
- `pr` — filter by PR number

**Response:**
```json
{
  "repo": "org/repo",
  "total": 15,
  "evaluations": [
    {
      "id": 42,
      "gate_name": "default",
      "result": "passed",
      "score": 100,
      "passed_count": 3,
      "failed_count": 0,
      "total_count": 3,
      "head_sha": "abc123...",
      "pr_number": 42,
      "block_on_fail": true,
      "conditions": [...],
      "evaluated_at": "2026-05-24T00:00:00Z",
      "duration_ms": 150
    }
  ]
}
```

### GET /api/gates/:owner/:repo/metrics

Raw metric values for a repo.

**Response:**
```json
{
  "repo": "org/repo",
  "metrics": {
    "ci_failure_rate_7d": 0.15,
    "ci_failure_rate_30d": 0.22,
    "triage_coverage": 0.85,
    "open_issues": 12,
    "open_security_issues": 0,
    "stale_issues_7d": 3,
    "heal_success_rate_7d": 0.67,
    "heal_success_rate_30d": 0.55,
    "fix_success_rate_7d": 0.5,
    "duplicate_rate": 0.08,
    "avg_triage_time_hours": 4.2,
    "avg_heal_time_hours": 12.5,
    "readiness_score": 75,
    "webhook_events_7d": 142
  }
}
```
