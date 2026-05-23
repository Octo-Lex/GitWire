# Decision Log

Every GitWire worker records **why** it made its decision. This is the foundation of the "prove" pillar.

## Overview

When a worker processes an event, it logs one of three decisions:

| Decision | Meaning |
|----------|---------|
| `acted` | GitWire performed an action (labeled, commented, created PR, etc.) |
| `skipped` | GitWire chose not to act (disabled, filtered, waived, low confidence) |
| `blocked` | GitWire wanted to act but was prevented (dry run, policy block) |

Each decision includes structured conditions showing what was checked.

## Schema

```sql
decision_log (
  id             BIGSERIAL PRIMARY KEY,
  repo_id        BIGINT REFERENCES repositories(github_id),
  source         TEXT,           -- 'ci_heal', 'triage', 'ai_review', etc.
  trigger_event  TEXT,           -- 'issues.opened', 'workflow_run.completed'
  target_type    TEXT,           -- 'issue' or 'pr'
  target_number  INTEGER,        -- issue/PR number
  pillar         TEXT,           -- pillar name
  decision       TEXT,           -- 'acted', 'skipped', 'blocked'
  reason         TEXT,           -- human-readable explanation
  conditions     JSONB,          -- array of { check, result } objects
  config_used    JSONB,          -- resolved config snapshot
  commit_sha     TEXT,
  actor          TEXT,           -- who/what triggered the decision
  created_at     TIMESTAMPTZ
)
```

## Conditions

Each decision includes an array of checks that were evaluated:

```json
[
  { "check": "pillar_enabled(ci_healing)", "result": true },
  { "check": "trigger_filter(ci_healing)", "result": true },
  { "check": "waiver_active", "result": false },
  { "check": "confidence(high) >= threshold(medium)", "result": true },
  { "check": "is_dry_run()", "result": false }
]
```

This gives a complete audit trail of the decision pipeline.

## API

### List Decisions

```
GET /api/decisions?source=ci_heal&decision=skipped&page=1&per_page=20
```

**Query parameters:**

| Param | Description |
|-------|-------------|
| `source` | Filter by worker source |
| `decision` | Filter by decision type (`acted`, `skipped`, `blocked`) |
| `page` | Page number (default: 1) |
| `per_page` | Results per page (default: 20) |

### Decision Summary

```
GET /api/decisions/summary
```

Returns counts grouped by source and decision type.

## Dashboard

The **Decisions** page (`/decisions`) shows recent decisions with:

- Source filter bar (all workers)
- Decision type filter (acted/skipped/blocked)
- Color-coded badges
- Pagination
- Condition details in expandable rows

## Integration Points

Decisions are logged at these worker checkpoints:

| Worker | Decision Points |
|--------|----------------|
| CI Heal | pillar disabled, trigger filtered, waiver active, confidence too low, healed successfully |
| Triage | pillar disabled, trigger filtered, waiver active, labels applied, dry run |
