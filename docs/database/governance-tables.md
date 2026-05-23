# Governance Tables

Tables added in Sprint 1 & 2 for evidence, visibility, and policy management.

## managed_actions

Tracks every GitHub mutation GitWire creates (labels, comments, reviewers, branch refs).

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL | Primary key |
| `repo_id` | BIGINT | FK → repositories.github_id |
| `source` | TEXT | Worker source (`ci_heal`, `triage`) |
| `source_id` | TEXT | Unique ID from the source system |
| `pr_number` | INTEGER | PR number |
| `issue_number` | INTEGER | Issue number |
| `action_type` | TEXT | `label`, `comment`, `reviewer`, `branch_ref` |
| `action_key` | TEXT | `label:ci-heal`, `comment:heal:diagnosis` |
| `action_value` | TEXT | Label name, comment text, etc. |
| `github_id` | BIGINT | GitHub's ID for the created resource |
| `context_hash` | TEXT | Head SHA at creation time |
| `active` | BOOLEAN | Whether the action is still active |
| `created_at` | TIMESTAMPTZ | Creation timestamp |
| `deactivated_at` | TIMESTAMPTZ | When deactivated (reconcile/cleanup) |

## decision_log

Records why every worker made its decision.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL | Primary key |
| `repo_id` | BIGINT | FK → repositories.github_id |
| `source` | TEXT | Worker source |
| `trigger_event` | TEXT | GitHub event that triggered this |
| `target_type` | TEXT | `issue` or `pr` |
| `target_number` | INTEGER | Issue/PR number |
| `pillar` | TEXT | Pillar name |
| `decision` | TEXT | `acted`, `skipped`, `blocked` |
| `reason` | TEXT | Human-readable explanation |
| `conditions` | JSONB | Array of `{ check, result }` objects |
| `config_used` | JSONB | Resolved config snapshot |
| `commit_sha` | TEXT | Head SHA |
| `actor` | TEXT | Who/what triggered the decision |
| `created_at` | TIMESTAMPTZ | Decision timestamp |

## policy_waivers

Time-limited exceptions to pillar enforcement.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL | Primary key |
| `repo_id` | BIGINT | FK → repositories.github_id |
| `pillar` | TEXT | Pillar to waive |
| `scope` | TEXT | `repo`, `branch`, `pr`, `issue` |
| `scope_value` | TEXT | Branch name, PR/issue number |
| `reason` | TEXT | Why the waiver was granted |
| `granted_by` | TEXT | GitHub username |
| `expires_at` | TIMESTAMPTZ | Expiry date (NULL = indefinite) |
| `active` | BOOLEAN | Whether the waiver is active |
| `created_at` | TIMESTAMPTZ | Grant timestamp |
| `revoked_at` | TIMESTAMPTZ | Revoke timestamp |

## action_feed (VIEW)

Unified view across 9 source tables for the activity feed.
