# Repo Reconciliation

Detecting and resolving orphaned repository data when repos move between GitHub accounts.

## The problem

When a GitHub repository is deleted and re-created under a different owner (e.g. `xjeddah/GitWire` → `Octo-Lex/GitWire`), GitWire ends up with **two rows** in the `repositories` table sharing the same repo name but with different `github_id` values.

This happens because:

1. GitHub assigns a new `github_id` when a repo is created
2. The webhook worker inserts a new row for each installation
3. The old row stays behind with stale references

### Not the same as a transfer

A true GitHub **transfer** keeps the same `github_id` — the webhook worker's `ON CONFLICT (github_id) DO UPDATE SET full_name = EXCLUDED.full_name` handles this automatically. No manual intervention needed.

The orphan case is different: the repo was **deleted and re-created**, or **forked and the original deleted**. Different `github_id`, same name, split data.

## Detection

GitWire automatically detects orphaned repos by finding `name` values that appear more than once in the active `repositories` table:

```sql
SELECT name
FROM repositories
WHERE deleted_at IS NULL
GROUP BY name
HAVING COUNT(*) > 1
```

For each duplicate, the system determines which variant is "live" (more recent webhook activity) and which is the "orphan."

## Resolution options

Two options are available for each orphan:

### Merge into live repo

Re-parents all data from the orphan to the live repo:

1. **FK re-parenting** — Updates `repo_id` in 32 tables from `orphan.github_id` to `live.github_id`
2. **Text backfill** — Updates denormalized `repo`/`repo_full_name` columns in 4 tables
3. **Soft-delete** — Marks the orphan row with `deleted_at = NOW()`

All changes happen in a single database transaction — either everything merges or nothing does.

### Discard

Soft-deletes the orphan row. Historical data remains in the database but is hidden from queries. The orphan row is marked with `deleted_at = NOW()`.

Use this when the old data is not worth preserving.

## Affected tables

### FK-linked tables (32)

These tables reference `repositories.github_id` via `repo_id`. Data is re-parented during merge:

| Table | Data |
|-------|------|
| `ai_review_config` | AI review settings per repo |
| `ai_reviews` | AI code review results |
| `branch_rules` | Branch protection rules |
| `ci_runs` | CI workflow run records |
| `config_history` | .gitwire.yml change history |
| `config_validation_results` | Config validation outcomes |
| `decision_log` | Governance decision records |
| `dependency_manifests` | Package dependency snapshots |
| `dependency_update_batches` | Batch dependency updates |
| `duplicate_signals` | Duplicate issue detection data |
| `enforcement_violations` | Policy enforcement records |
| `fix_attempts` | Issue fix attempt records |
| `flaky_tests` | Flaky test detection results |
| `gate_evaluations` | Quality gate check results |
| `heal_prs` | CI healing PR records |
| `issue_embeddings` | Issue text embeddings |
| `issues` | Tracked issues |
| `maintainer_actions` | Maintainer automation records |
| `maintainer_settings` | Per-repo maintainer config |
| `managed_actions` | Action lifecycle records |
| `merge_queue_config` | Merge queue settings |
| `merge_queue_entries` | Queue entries |
| `pipeline_events` | Pipeline processing events |
| `policy_repo_configs` | Policy config overrides |
| `policy_waivers` | Policy waiver records |
| `pull_requests` | Tracked pull requests |
| `quality_gates` | Quality gate definitions |
| `repo_collaborators` | Repository collaborators |
| `repo_config` | Per-repo GitWire config |
| `rollback_events` | Rollback event records |
| `test_results` | CI test results |
| `vulnerability_advisories` | Security vulnerability data |

### Denormalized text columns (4)

These tables store `repo_full_name` or `repo` as text. Updated during merge:

| Table | Column | Data |
|-------|--------|------|
| `managed_actions` | `repo_full_name` | Action records |
| `webhook_deliveries` | `repo` | Webhook delivery logs |
| `action_feed` | `repo` | Activity feed entries |
| `audit_trail_entries` | `repo_full_name` | Audit trail |

## API

### Detect orphans

```
GET /api/repos/reconcile
```

Returns detected orphan pairs with data counts:

```json
{
  "data": [
    {
      "orphan": {
        "github_id": "1240417604",
        "full_name": "xjeddah/GitWire",
        "delivery_count": 131
      },
      "live": {
        "github_id": "1242582513",
        "full_name": "Octo-Lex/GitWire",
        "delivery_count": 393
      },
      "data": {
        "fk_tables": { "ci_runs": 32, "issues": 2, "pull_requests": 5 },
        "fk_total": 53,
        "denorm_tables": { "webhook_deliveries": 131, "action_feed": 137 },
        "denorm_total": 274,
        "grand_total": 327
      }
    }
  ]
}
```

### Merge orphan into live repo

```
POST /api/repos/reconcile/merge
Body: { "orphan": "xjeddah/GitWire", "live": "Octo-Lex/GitWire" }
```

Returns merge results with per-table counts:

```json
{
  "status": "merged",
  "orphan": "xjeddah/GitWire",
  "live": "Octo-Lex/GitWire",
  "reparented": { "ci_runs": 32, "issues": 2, "pull_requests": 5 },
  "backfilled": { "webhook_deliveries": 131, "action_feed": 137 },
  "total_affected": 327
}
```

### Discard orphan

```
POST /api/repos/reconcile/discard
Body: { "orphan": "xjeddah/GitWire" }
```

```json
{
  "status": "discarded",
  "orphan": "xjeddah/GitWire",
  "note": "Orphan soft-deleted. Its data remains in DB but is hidden."
}
```

## Dashboard

The **Repositories** page (`/repos`) automatically shows a reconciliation banner when orphans are detected:

- **⚠️ N Orphaned Repos Detected** — amber warning banner
- Per-orphan details: delivery counts, FK-linked tables with row counts
- **Merge into live** — re-parents data, soft-deletes orphan
- **Discard** — soft-deletes orphan without merging

The banner disappears once all orphans are resolved.

## Comparison with competitors

| Tool | Handles repo account change? |
|------|:----------------------------:|
| SonarCloud | Forces re-import, loses history |
| Codecov | Breaks silently |
| LinearB | Loses history |
| **GitWire** | **User chooses: merge history or fresh start** |

GitWire is the only tool that offers the user a choice between preserving historical data and starting clean.

## See also

- [Database Schema](/database/database-schema) — full table reference
- [Data Flow](/architecture/data-flow) — how webhooks create repository records
- [Action Lifecycle](/architecture/action-lifecycle) — action state machine
