# Automation Tables

5 tables for merge queue, feedback rules, pipeline events, and rollbacks.

## merge_queue_entries

PR merge queue entries.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `pr_number` | INT | PR number |
| `pr_title` | TEXT | PR title |
| `head_sha` | TEXT | Latest commit SHA |
| `head_branch` | TEXT | Source branch |
| `base_branch` | TEXT | Target branch |
| `author_login` | TEXT | PR author |
| `position` | INT | Queue position |
| `status` | TEXT | `pending`, `ready`, `merged`, `blocked` |
| `required_checks` | TEXT[] | Checks that must pass |
| `checks_passed` | TEXT[] | Checks that passed |
| `checks_failed` | TEXT[] | Checks that failed |
| `merge_method` | TEXT | `squash`, `merge`, `rebase` |
| `merge_error` | TEXT | Error if merge failed |

## merge_queue_config

Per-repo merge queue settings.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT UNIQUE FK → repositories | Repository |
| `enabled` | BOOLEAN | Queue active |
| `merge_method` | TEXT | Default merge method |
| `delete_branch` | BOOLEAN | Auto-delete after merge |
| `required_checks` | TEXT[] | Required CI checks |
| `max_queue_depth` | INT | Max entries in queue |
| `check_timeout_mins` | INT | Check timeout |
| `rollback_enabled` | BOOLEAN | Auto-rollback on failure |
| `base_branch` | TEXT | Default target branch |

## feedback_rules

Notification rules for merge events.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `installation_id` | BIGINT FK → installations | Scope |
| `name` | TEXT | Rule name |
| `event_type` | TEXT | Trigger event |
| `repo_filter` | TEXT | Glob for repos |
| `post_pr_comment` | BOOLEAN | Comment on PR |
| `slack_webhook` | TEXT | Slack URL |
| `teams_webhook` | TEXT | Teams URL |
| `enabled` | BOOLEAN | Active flag |

## pipeline_events

CI/CD pipeline event log.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `event_type` | TEXT | Event type |
| `actor` | TEXT | Who triggered |
| `ref` | TEXT | Branch/ref |
| `pr_number` | INT | Related PR |
| `duration_ms` | INT | Duration |
| `success` | BOOLEAN | Outcome |
| `metadata` | JSONB | Additional data |

## rollback_events

Merge rollback records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `pr_number` | INT | Original PR |
| `merge_commit` | TEXT | Merge SHA |
| `revert_commit` | TEXT | Revert SHA |
| `revert_pr_number` | INT | Revert PR number |
| `trigger_reason` | TEXT | Why rolled back |
| `status` | TEXT | `pending`, `completed` |
| `initiated_by` | TEXT | Who triggered |

→ [Trust Tables](/database/trust-tables)
