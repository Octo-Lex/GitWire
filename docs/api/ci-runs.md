# CI Runs API

CI run listing, statistics, workflow re-runs, and manual CI-heal admission.

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
| `repo` | TEXT | Exact repository `owner/name` |
| `branch` | TEXT | Exact branch name |

## Get Repo CI Runs

```
GET /api/ci/:owner/:repo
```

CI runs for a specific repository.

## CI Statistics

```
GET /api/ci/stats
```

The response contains a seven-day summary, failure-type breakdown, and a
14-day daily pass-rate trend:

```json
{
  "summary": {
    "total_runs": "234",
    "passed": "187",
    "failed": "42",
    "cancelled": "5",
    "pass_rate": "80",
    "auto_healed": "28",
    "heal_attempted": "9",
    "heal_failed": "5"
  },
  "by_failure_type": [
    { "failure_type": "test_failure", "count": "20" },
    { "failure_type": "unknown", "count": "12" }
  ],
  "trend": []
}
```

> **Capability-truth note:** in the current legacy CI-heal pipeline,
> `heal_status = "healed"` is written when GitWire successfully creates a heal
> pull request. It is not, by itself, independent proof that the proposed repair
> later passed CI or was merged. Heal-PR outcome tracking is separate.

## Re-run a GitHub workflow

```
POST /api/ci/:runId/retry
```

Re-runs the GitHub Actions workflow represented by a stored GitWire CI row.
For this endpoint, `runId` is the GitWire `ci_runs.id` value.

```bash
curl -X POST https://gitwire.yourdomain.com/api/ci/12345/retry \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This endpoint asks GitHub to re-run the workflow. It does **not** directly
queue GitWire's CI-healing worker.

## Request CI healing

```
POST /api/ci/:runId/heal
```

Requests evaluation by GitWire's CI-healing worker. `runId` may be either:

- the GitWire `ci_runs.id`, or
- the stored GitHub workflow-run ID (`ci_runs.github_run_id`).

GitWire resolves the identifier against server-owned CI/repository state. If
an identifier could refer to two different stored rows across those namespaces,
the request fails closed with `409 Ambiguous run identifier`.

Before queueing, GitWire re-fetches the workflow run from GitHub using the
server-resolved repository and installation. The run must currently be
`status = completed` and `conclusion = failure`; otherwise the request is
rejected with `409`.

```bash
curl -X POST https://gitwire.yourdomain.com/api/ci/30123456789/heal \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Successful admission returns HTTP `202`:

```json
{
  "status": "queued",
  "ci_run_id": "12345",
  "github_run_id": "30123456789",
  "run_id": "30123456789",
  "job_id": "..."
}
```

`202` means the validated heal command was admitted to the queue. It does not
mean a repair was generated or applied. The worker still evaluates GitWire's
existing CI-heal safeguards such as self-activity suppression, circuit breaker,
pillar configuration, attempt limits, trigger filters, waivers, dry-run and
its current idempotency behavior.

The legacy `installation_id` query parameter is ignored as an authority source;
repository and installation identity are derived from server-owned state.
Malformed `heal-run` jobs are validated at both producer and worker-consumer
boundaries and fail visibly rather than being treated as successful no-ops.

→ [Insights API](/api/insights)
