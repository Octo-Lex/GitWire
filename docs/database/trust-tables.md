# Trust Tables

12 tables for test analysis, dependency scanning, AI review, and audit trail.

## test_results

Individual test execution records.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `ci_run_id` | BIGINT FK → ci_runs | Parent CI run |
| `commit_sha` | TEXT | Commit |
| `branch` | TEXT | Branch |
| `workflow_name` | TEXT | Workflow |
| `test_suite` | TEXT | Suite name |
| `test_name` | TEXT | Test name |
| `test_id` | TEXT | Stable test identifier |
| `status` | TEXT | Pass/fail/skip |
| `duration_ms` | INT | Duration |
| `error_message` | TEXT | Error if failed |

## flaky_tests

Detected flaky tests with quarantine tracking.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `test_id` | TEXT | Stable identifier |
| `test_suite` | TEXT | Suite name |
| `test_name` | TEXT | Test name |
| `run_count` | INT | Total runs |
| `pass_count` | INT | Passes |
| `fail_count` | INT | Failures |
| `flakiness_score` | REAL | 0.0–1.0 |
| `quarantined` | BOOLEAN | In quarantine |
| `graduated_at` | TIMESTAMPTZ | No longer flaky |

## policy_repo_configs

Desired vs. observed state for policy reconciler.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT UNIQUE FK → repositories | Repository |
| `desired_state` | JSONB | What we want |
| `observed_state` | JSONB | What GitHub has |
| `in_sync` | BOOLEAN | Match? |
| `drift_fields` | TEXT[] | Fields that differ |
| `last_reconciled_at` | TIMESTAMPTZ | Last check |

## reconciliation_runs

Reconciler execution history.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `triggered_by` | TEXT | `scheduler` or `manual` |
| `repos_checked` | INT | Total repos |
| `repos_synced` | INT | Successfully synced |
| `repos_drifted` | INT | Had drift |
| `repos_corrected` | INT | Auto-fixed |
| `repos_failed` | INT | Failed |

## dependency_manifests

Package dependency files (package.json, etc.).

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `file_path` | TEXT | Path to manifest |
| `ecosystem` | TEXT | `npm`, `pip`, `maven`, etc. |
| `dependencies` | JSONB | Parsed deps |
| `dep_count` | INT | Count |
| `scanned_at` | TIMESTAMPTZ | Scan time |

## vulnerability_advisories

Security vulnerabilities in dependencies.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `ghsa_id` | TEXT | GHSA advisory ID |
| `cve_id` | TEXT | CVE ID |
| `package_name` | TEXT | Affected package |
| `severity` | TEXT | `low`, `medium`, `high`, `critical` |
| `installed_version` | TEXT | Current version |
| `patched_version` | TEXT | Fix version |
| `status` | TEXT | `open`, `fixed`, `dismissed` |
| `fix_pr_number` | INT | Auto-fix PR |

## dependency_update_batches

Batch dependency update PRs.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `ecosystem` | TEXT | Package ecosystem |
| `update_type` | TEXT | Update type |
| `packages` | JSONB | Packages to update |
| `pr_number` | INT | Created PR |
| `status` | TEXT | `open`, `merged`, `closed` |

## ai_reviews

AI code review results.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT FK → repositories | Repository |
| `pr_number` | INT | PR number |
| `commit_sha` | TEXT | Reviewed commit |
| `summary` | TEXT | Review summary |
| `verdict` | TEXT | `approved`, `request_changes`, `needs_discussion` |
| `confidence` | TEXT | `high`, `medium`, `low` |
| `findings` | JSONB | Array of finding objects |
| `files_reviewed` | INT | Count |
| `github_review_id` | BIGINT | GitHub review ID |
| `check_run_id` | BIGINT | Check Run ID |

## ai_review_config

Per-repo AI review settings.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `repo_id` | BIGINT UNIQUE FK → repositories | Repository |
| `enabled` | BOOLEAN | Active flag |
| `check_*` | BOOLEAN | Individual check toggles |
| `block_on_verdict` | TEXT[] | Verdicts that block merge |
| `max_files_to_review` | INT | File limit |
| `ignore_patterns` | TEXT[] | Files to skip |

## audit_trail_entries

Immutable SHA-256 chained audit log.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `seq` | BIGINT UNIQUE | Monotonic sequence |
| `category` | TEXT | Event category |
| `event_type` | TEXT | Specific event |
| `actor` | TEXT | Who triggered |
| `actor_type` | TEXT | `human`, `bot`, `system` |
| `repo_full_name` | TEXT | Repository |
| `pr_number` | INT | Related PR |
| `payload` | JSONB | Event details (immutable) |
| `framework` | TEXT[] | Compliance tags |
| `payload_hash` | TEXT | SHA-256 of payload |
| `prev_hash` | TEXT | Previous entry's hash |

## compliance_reports

Generated SOC2/ISO compliance reports.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `report_type` | TEXT | `soc2`, `iso27001`, `custom` |
| `period_start` | TIMESTAMPTZ | Period start |
| `period_end` | TIMESTAMPTZ | Period end |
| `summary` | JSONB | Report summary |
| `controls` | JSONB | Control mappings |
| `entry_count` | INT | Audit entries covered |
| `report_hash` | TEXT | Integrity hash |

## audit_exports

Nightly audit data exports.

| Column | Type | Description |
|--------|------|-------------|
| `id` | BIGSERIAL PK | Internal ID |
| `export_type` | TEXT | `nightly` |
| `date_covered` | DATE | Export date |
| `entry_count` | INT | Entries exported |
| `file_path` | TEXT | Export file |
| `file_hash` | TEXT | File hash |
| `signed` | BOOLEAN | Signed flag |

→ [Workers](/workers/background-workers)
