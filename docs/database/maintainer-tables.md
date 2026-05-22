# Maintainer Tables

6 tables for repository maintenance, governance, and audit logging.

## maintainer_actions

Records of all maintainer bot actions (stale warnings, branch cleanup, etc.).

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Target repo |
| `action_type` | TEXT | `stale_warn`, `stale_close`, `branch_cleanup`, `label_apply`, `comment_command` |
| `target_type` | TEXT | `issue`, `pr`, `branch` |
| `target_number` | TEXT | Issue/PR number or branch name |
| `idempotency_key` | TEXT UNIQUE | Prevents duplicate actions |
| `status` | TEXT | `pending`, `applied`, `skipped`, `failed` |
| `result` | TEXT | Result details |

## maintainer_settings

Per-repository maintainer configuration.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT UNIQUE FK → repositories | Target repo |
| `stale_issue_days` | INT | Days before issue is stale (default 60) |
| `stale_pr_days` | INT | Days before PR is stale (default 30) |
| `stale_warn_days` | INT | Days after warning before close (default 7) |
| `cleanup_branches` | BOOLEAN | Auto-delete merged branches (default true) |
| `enabled` | BOOLEAN | Enable maintainer features (default true) |

## members

Organization members synced from GitHub.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `installation_id` | BIGINT FK → installations | Parent installation |
| `github_login` | TEXT | GitHub username |
| `github_id` | BIGINT | GitHub user ID |
| `avatar_url` | TEXT | Avatar URL |
| `role` | TEXT | `owner` or `member` |
| `site_admin` | BOOLEAN | GitHub admin flag |

## repo_collaborators

Repository-level collaborators.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Target repo |
| `github_login` | TEXT | GitHub username |
| `permission` | TEXT | `pull`, `triage`, `push`, `maintain`, `admin` |

## branch_rules

Branch protection rules synced from GitHub.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Target repo |
| `pattern` | TEXT | Branch pattern (e.g. `main`, `release/*`) |
| `required_reviews` | INT | Required approving reviews |
| `dismiss_stale_reviews` | BOOLEAN | Auto-dismiss on push |
| `require_status_checks` | BOOLEAN | Required CI checks |
| `enforce_admins` | BOOLEAN | Apply to admins |
| `github_rule_id` | INT | GitHub's rule ID |

## audit_log

Governance audit log for tracking configuration changes.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `actor` | TEXT | GitHub login of who triggered |
| `action` | TEXT | Action (e.g. `collaborator.add`) |
| `target_type` | TEXT | `repo`, `member`, `branch_rule` |
| `target_id` | TEXT | Target identifier |
| `payload` | JSONB | Action details |
| `success` | BOOLEAN | Whether action succeeded |

→ [Fix Tables](/database/fix-tables)
