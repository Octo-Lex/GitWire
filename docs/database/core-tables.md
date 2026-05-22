# Core Tables

The 6 foundational tables from migration `001_initial_schema`.

## installations

GitHub App installations (orgs/users that installed GitWire).

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `github_id` | BIGINT UNIQUE | GitHub installation ID |
| `account_login` | TEXT | Org or user login |
| `account_type` | TEXT | `Organization` or `User` |
| `target_id` | BIGINT | Installation target ID |
| `created_at` | TIMESTAMPTZ | Creation timestamp |
| `updated_at` | TIMESTAMPTZ | Last update |
| `deleted_at` | TIMESTAMPTZ | Soft-delete (uninstalled) |

## repositories

Synced GitHub repositories.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `github_id` | BIGINT UNIQUE | GitHub repo ID |
| `installation_id` | BIGINT FK → installations | Parent installation |
| `full_name` | TEXT | `owner/repo` |
| `owner` | TEXT | Repository owner |
| `name` | TEXT | Repository name |
| `private` | BOOLEAN | Private repo flag |
| `default_branch` | TEXT | Default branch name |
| `language` | TEXT | Primary language |
| `stars` | INT | Star count |
| `open_issues` | INT | Open issue count |
| `open_prs` | INT | Open PR count |
| `last_synced_at` | TIMESTAMPTZ | Last sync timestamp |

## issues

GitHub issues with AI triage fields.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `github_id` | BIGINT UNIQUE | GitHub issue ID |
| `repo_id` | BIGINT FK → repositories | Parent repo |
| `number` | INT | Issue number |
| `title` | TEXT | Issue title |
| `state` | TEXT | `open` or `closed` |
| `labels` | TEXT[] | GitHub labels |
| `assignees` | TEXT[] | Assigned users |
| `triage_type` | TEXT | AI: `bug`, `feature`, etc. |
| `triage_priority` | TEXT | AI: `critical`, `high`, `medium`, `low` |
| `triage_summary` | TEXT | AI: one-line summary |
| `triaged_at` | TIMESTAMPTZ | When triaged |

## pull_requests

Pull requests with AI triage fields.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `github_id` | BIGINT UNIQUE | GitHub PR ID |
| `repo_id` | BIGINT FK → repositories | Parent repo |
| `number` | INT | PR number |
| `title` | TEXT | PR title |
| `state` | TEXT | `open`, `closed`, `merged` |
| `draft` | BOOLEAN | Draft PR flag |
| `head_branch` | TEXT | Source branch |
| `base_branch` | TEXT | Target branch |
| `labels` | TEXT[] | GitHub labels |
| `triage_type` | TEXT | AI classification |
| `triage_size` | TEXT | `size/XS` through `size/XL` |
| `triage_risk` | TEXT | Risk assessment |
| `triage_summary` | TEXT | AI summary |

## ci_runs

GitHub Actions workflow runs with healing fields.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `github_run_id` | BIGINT UNIQUE | GitHub run ID |
| `repo_id` | BIGINT FK → repositories | Parent repo |
| `workflow_name` | TEXT | Workflow name |
| `branch` | TEXT | Branch name |
| `head_sha` | TEXT | Commit SHA |
| `conclusion` | TEXT | `success`, `failure`, etc. |
| `heal_status` | TEXT | `pending`, `attempted`, `healed`, `failed`, `skipped` |
| `heal_failure_type` | TEXT | One of 9 failure types |
| `heal_root_cause` | TEXT | Claude's diagnosis |
| `heal_fix_applied` | TEXT | Description of fix |
| `heal_confidence` | TEXT | `high`, `medium`, `low` |

## webhook_deliveries

Log of all incoming webhooks.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `delivery_id` | TEXT UNIQUE | GitHub delivery ID |
| `event_name` | TEXT | Event type |
| `action` | TEXT | Event action |
| `repo` | TEXT | Repository name |
| `processed` | BOOLEAN | Whether handled |
| `error` | TEXT | Error if failed |

→ [Maintainer Tables](/database/maintainer-tables)
