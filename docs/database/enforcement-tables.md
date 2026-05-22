# Enforcement Tables

3 tables for branch enforcement policies and violations.

## policy_definitions

Enforcement policy rules.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `installation_id` | BIGINT FK → installations | Scope |
| `name` | TEXT UNIQUE | Policy name |
| `description` | TEXT | Human description |
| `repo_filter` | TEXT | Glob for repo matching |
| `branch_pattern` | TEXT | Branch pattern (e.g. `main`) |
| `min_reviews` | INT | Required reviews |
| `require_signed_commits` | BOOLEAN | GPG required |
| `require_linear_history` | BOOLEAN | No merge commits |
| `block_force_pushes` | BOOLEAN | No force push |
| `enforce_admins` | BOOLEAN | Apply to admins |
| `require_status_checks` | BOOLEAN | CI required |
| `required_status_check_contexts` | TEXT[] | Check names |
| `mode` | TEXT | `enforce` or `audit` |
| `enabled` | BOOLEAN | Active flag |

## enforcement_violations

Detected policy violations.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `policy_id` | BIGINT FK → policy_definitions | Violated policy |
| `repo_id` | BIGINT FK → repositories | Repository |
| `branch` | TEXT | Branch name |
| `violations` | JSONB | Array of specific violations |
| `status` | TEXT | `open`, `remediated` |
| `remediated_at` | TIMESTAMPTZ | When fixed |
| `remediated_by` | TEXT | Who fixed it |

## config_validation_results

Push-triggered config file validation.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `commit_sha` | TEXT | Triggering commit |
| `file_path` | TEXT | Config file path |
| `file_type` | TEXT | File type |
| `valid` | BOOLEAN | Pass/fail |
| `errors` | JSONB | Error details |
| `warnings` | JSONB | Warning details |
| `check_run_id` | BIGINT | GitHub Check Run ID |

→ [Automation Tables](/database/automation-tables)
