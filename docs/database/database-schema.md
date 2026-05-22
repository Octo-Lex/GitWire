# Database Schema

GitWire uses PostgreSQL 16 with 36 tables across 11 migrations.

## Overview

| Metric | Value |
|--------|-------|
| Database | PostgreSQL 16 |
| Tables | 36 |
| Migrations | 11 |
| Name | `gitops_hub` |
| User | `gitwire` |

## Migration History

| Migration | Tables | Description |
|-----------|--------|-------------|
| `001_initial_schema` | 6 | Core: installations, repos, issues, PRs, CI runs, webhooks |
| `002_repos_deleted_at` | — | Soft-delete support for repos |
| `003_maintainer` | 2 | Maintainer actions, settings |
| `004_issue_fix` | 1 | Fix attempts |
| `005_governance` | 4 | Members, collaborators, branch rules, audit log |
| `006_heal_prs` | 1 | Heal PR tracking |
| `007_duplicate_detection` | 2 | Embeddings, duplicate signals |
| `008_phase1_enforcement` | 3 | Policies, violations, config validation |
| `009_phase2_automation` | 5 | Merge queue, feedback, pipeline events, rollbacks |
| `010_phase3_trust` | 7 | Tests, flaky, policies, deps, vulnerabilities |
| `011_phase4_intelligence` | 5 | AI reviews, audit trail, compliance |

## Table Groups

| Group | Tables | Page |
|-------|--------|------|
| Core | installations, repositories, issues, pull_requests, ci_runs, webhook_deliveries | [Core Tables](/database/core-tables) |
| Maintainer | maintainer_actions, maintainer_settings, members, repo_collaborators, branch_rules, audit_log | [Maintainer Tables](/database/maintainer-tables) |
| Fix | fix_attempts, heal_prs, issue_embeddings, duplicate_signals | [Fix Tables](/database/fix-tables) |
| Enforcement | policy_definitions, enforcement_violations, config_validation_results | [Enforcement Tables](/database/enforcement-tables) |
| Automation | merge_queue_config, merge_queue_entries, feedback_rules, pipeline_events, rollback_events | [Automation Tables](/database/automation-tables) |
| Trust | test_results, flaky_tests, policy_repo_configs, reconciliation_runs, dependency_manifests, vulnerability_advisories, dependency_update_batches, ai_reviews, ai_review_config, audit_trail_entries, compliance_reports, audit_exports | [Trust Tables](/database/trust-tables) |

## Naming Conventions

| Convention | Example |
|-----------|---------|
| Table names | `snake_case`, plural (`issues`, `ci_runs`) |
| Column names | `snake_case` (`triage_type`, `heal_status`) |
| Foreign keys | `repo_id`, `installation_id`, `policy_id` |
| Timestamps | `created_at`, `updated_at` (TIMESTAMPTZ) |
| JSONB columns | `payload`, `findings`, `metadata` |
| Array columns | `labels TEXT[]`, `files_changed TEXT[]` |

## In This Section

- [Core Tables](/database/core-tables)
- [Maintainer Tables](/database/maintainer-tables)
- [Fix Tables](/database/fix-tables)
- [Enforcement Tables](/database/enforcement-tables)
- [Automation Tables](/database/automation-tables)
- [Trust Tables](/database/trust-tables)
