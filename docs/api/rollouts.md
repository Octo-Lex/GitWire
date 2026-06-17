# Policy Rollout API

The rollout API provides controlled policy lifecycle management — from proposed plan to live policy with full audit trail.

## Authentication

All endpoints require `Authorization: Bearer <API_KEY>` header or `gitwire-session` cookie.

---

## Lifecycle

```text
draft → validated → review_ready → approved → promoted
                                    ↘ rejected
   ↘ cancelled (from draft, validated, approved)
promoted → rolled_back
```

Terminal states: `rolled_back`, `rejected`, `cancelled`

---

## POST /api/rollouts

Create a new rollout plan in `draft` state.

### Request

```json
{
  "repo": "Octo-Lex/GitWire",
  "proposed_config": {
    "dry_run": true,
    "pillars": {
      "triage": { "enabled": true }
    }
  },
  "created_by": "nalajmah"
}
```

### Response (201)

Returns the created plan with redacted normalized config.

---

## GET /api/rollouts

List rollout plans with optional filters.

### Query parameters

| Param | Type | Default | Description |
|---|---|---|---|
| `repo` | string | — | Filter by repo full_name |
| `status` | string | — | Filter by lifecycle status |
| `created_by` | string | — | Filter by creator |
| `limit` | number | 50 | Max results (capped at 200) |
| `offset` | number | 0 | Pagination offset |

### Response

```json
{
  "data": [...],
  "total": 5
}
```

---

## GET /api/rollouts/:id

Get a single rollout plan by ID.

Returns full plan with all metadata, evidence, and config snapshots (redacted).

---

## PATCH /api/rollouts/:id/evidence

Attach evidence summaries to a plan. Only allowed in `draft` or `validated` state.

### Request

```json
{
  "validation_result": { "valid": true, ... },
  "simulation_summary": { "would_act": 4, ... },
  "diff_impact_summary": { "changes": { ... }, ... },
  "recommendations_summary": { "summary": { "critical": 0, ... }, ... }
}
```

---

## POST /api/rollouts/:id/approve

Approve a rollout plan. Requires all evidence and critical recommendation acknowledgement.

### Approval rules

| Check | Rule |
|---|---|
| State | Must be `review_ready` |
| Evidence | All 4 types attached |
| Validation | Must be valid |
| Critical recommendations | Must be explicitly acknowledged |

### Request

```json
{
  "actor": "nalajmah",
  "reason": "Reviewed all evidence. Rolling out in dry-run first.",
  "acknowledged_recommendations": [
    "enable-dry-run-for-new-risky-policy"
  ]
}
```

### Response

Returns plan with `approved_by`, `approved_at`, `approval_reason`, `acknowledged_recommendations`, and `reviewed_evidence` audit snapshot.

---

## POST /api/rollouts/:id/reject

Reject a rollout plan. Transitions to `rejected` (terminal).

### Request

```json
{
  "actor": "nalajmah",
  "reason": "Critical risk not mitigated."
}
```

---

## POST /api/rollouts/:id/promote

**The only path that writes policy.** Promotes the approved proposed config as the active repo policy.

### Promotion rules

| Check | Rule |
|---|---|
| State | Must be `approved` |
| Approval metadata | `approved_by`, `approved_at` present |
| Evidence | All 4 types attached |
| Validation | Still valid |
| Proposed config | Present |

### Execution sequence

1. Capture previous config snapshot
2. Write proposed config via `setConfigOverrides`
3. If write fails → state remains `approved` (no transition)
4. Transition to `promoted`

### Request

```json
{
  "actor": "nalajmah",
  "reason": "Promoting approved dry-run policy after successful review."
}
```

### Response

Returns plan with `promoted_by`, `promoted_at`, `promotion_reason`, and `previous_config` snapshot.

---

## POST /api/rollouts/:id/rollback

Restore the previous policy captured before promotion.

### Rollback rules

| Check | Rule |
|---|---|
| State | Must be `promoted` |
| Previous config | Snapshot must exist |
| Actor | Required |
| Reason | Required |

### Execution sequence

1. Capture current config as replaced evidence
2. Write `previous_config` back as active policy
3. If write fails → state remains `promoted` (no transition)
4. Transition to `rolled_back` (terminal)

### Rollback evidence

```json
{
  "restored_previous_config": true,
  "replaced_config_captured": true,
  "previous_config_hash": "sha0:abc12345",
  "promoted_config_hash": "sha0:def67890",
  "replaced_config_hash": "sha0:ghi13579"
}
```

### Request

```json
{
  "actor": "nalajmah",
  "reason": "Observed unexpected live behavior after promotion."
}
```

---

## POST /api/rollouts/:id/transition

Generic transition endpoint for non-specialized transitions (`validated`, `review_ready`, `cancelled`).

Blocks `approved`, `rejected`, `promoted`, `rolled_back` — those must go through dedicated endpoints.

---

## Dashboard

The `/rollouts` dashboard page provides:
- List view with filters and state badges
- Detail view with lifecycle timeline, evidence cards, audit trail
- State-driven actions with confirmation modal
- Critical recommendation acknowledgement on approve
- Collapsible redacted config snapshots
