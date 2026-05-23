# Managed Actions

Tracking every GitHub mutation GitWire creates — labels, comments, reviewers, branch refs.

## Overview

GitWire doesn't just decide what to do — it tracks every action it takes on GitHub. The `managed_actions` table records each mutation so GitWire can:

1. **Reconcile** — detect stale actions when PRs are force-pushed
2. **Cleanup** — remove all actions when a PR is closed/merged
3. **Audit** — prove exactly what GitWire did, when, and why

## Action Types

Each action has an `action_type` and `action_key` following a convention:

| Action Type | Key Convention | Example |
|-------------|---------------|---------|
| Label | `label:{name}` | `label:ci-heal` |
| Comment | `comment:{source}:{purpose}` | `comment:ci_heal:diagnosis` |
| Reviewer | `reviewer:{login}` | `reviewer:octocat` |
| Approval | `approval:{source}` | `approval:ai_review` |
| Branch Ref | `branch_ref:{purpose}` | `branch_ref:heal_pr` |

## Reconciliation

When a PR receives a `synchronize` event (force-push or new commits), GitWire:

1. Fetches all active managed actions for that PR
2. Compares `context_hash` against the new head SHA
3. Marks stale actions as `active = false`
4. Logs deactivated count to the decision log

This ensures GitWire doesn't leave orphaned labels or comments on updated PRs.

## Cleanup

When a PR is closed or merged, GitWire:

1. Fetches all active managed actions for that PR
2. Marks them all as `active = false` with `deactivated_at = NOW()`
3. Optionally removes labels that GitWire added

## Schema

```sql
managed_actions (
  id              BIGSERIAL PRIMARY KEY,
  repo_id         BIGINT REFERENCES repositories(github_id),
  source          TEXT,           -- 'ci_heal', 'triage', etc.
  source_id       TEXT,           -- unique ID from the source system
  pr_number       INTEGER,
  issue_number    INTEGER,
  action_type     TEXT,           -- 'label', 'comment', 'reviewer', etc.
  action_key      TEXT,           -- 'label:ci-heal', 'comment:heal:diagnosis'
  action_value    TEXT,           -- label name, comment text, etc.
  github_id       BIGINT,        -- GitHub's ID for the created resource
  context_hash    TEXT,           -- head SHA at time of creation
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ,
  deactivated_at  TIMESTAMPTZ
)
```

## Integration

Managed actions are recorded by:

| Worker | Actions Recorded |
|--------|-----------------|
| CI Heal | Labels (`ci-heal`), comments (diagnosis), heal PR branch ref |
| Triage | Labels (AI-suggested), comments (triage summary) |

## Audit Trail

Managed actions are cross-referenced in the audit trail's evidence bundles:

```json
{
  "actions_taken": [
    { "type": "label", "key": "label:ci-heal", "value": "ci-heal" },
    { "type": "branch_ref", "key": "heal_pr", "value": "fix/ci-heal-12345" }
  ]
}
```
