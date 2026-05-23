# Dashboard Pages

Detailed description of each dashboard page.

## Overview (`/`)

Fleet-wide metrics:
- Total repos, issues, PRs, CI runs
- CI success rate (pie chart)
- Recent activity feed
- Installation health indicators

## Repos (`/repos`)

Sortable, filterable table of all repositories:
- Repo name, owner, language, visibility
- Open issues/PRs count
- Last synced timestamp
- Sync trigger button

## Issues (`/issues`)

Issue list with triage columns:
- Title, number, repo, state
- Triage type (bug/feature/etc.)
- Priority (critical/high/medium/low)
- Labels
- Pagination

## Pull Requests (`/pull-requests`)

PR list with size/risk:
- Title, number, repo, state
- Head/base branch
- Triage size, risk rating
- Draft status

## CI (`/ci`)

Two tabs:
- **CI Runs** — All workflow runs with conclusion, healing status
- **Heal History** — Auto-generated patch PRs with success/fail stats

## Insights (`/insights`)

Charts and metrics:
- Issue/PR velocity over time (line chart)
- CI pass/fail trends (area chart)
- Repository health scores
- Merge time distribution

## Maintainer (`/maintainer`)

Five tabs:
- **Settings** — Per-repo maintainer config
- **Stale** — Stale items with warn/close actions
- **Branches** — Branch rules and cleanup
- **Collaborators** — Repo access management
- **Audit Log** — Governance actions

## Fix Attempts (`/fix-attempts`)

Autonomous contributor history:
- Issue number, repo, status
- Complexity, confidence
- PR link (if created)
- Error details (if failed)

## Duplicates (`/duplicates`)

Duplicate detection dashboard:
- Pending/confirmed/dismissed signals
- Similarity scores
- Confirm/dismiss actions
- Embedding coverage stats

## Automation (`/automation`)

Four tabs:
- **Merge Queue** — Queue entries and config
- **Feedback** — Notification rules
- **Telemetry** — Pipeline metrics and events
- **Rollbacks** — Rollback history

## Trust (`/trust`)

Three tabs:
- **Flaky Tests** — Detected flaky tests with quarantine actions
- **Dependencies** — Manifests and vulnerability advisories
- **Policies** — Reconciliation runs and drift status

## Intelligence (`/intelligence`)

Two tabs:
- **AI Review** — Review results, findings, config
- **Audit Trail** — Chain-verified entries, compliance reports

## Config (`/config`)

Per-repository configuration management:
- **Repo selector** — Dropdown to pick from synced repos
- **Pillar cards** (7) — Toggle each pillar on/off, configure sub-options:
  - Issue & PR Triage: auto_label, auto_comment, duplicate_detection
  - Self-Healing CI: auto_patch, max_fix_attempts, min_confidence_to_patch
  - Autonomous Contributor: max_file_changes, max_line_changes, min_confidence_to_submit
  - Maintainer Tools: stale config, branch cleanup
  - Branch Enforcement, Merge Queue, AI Review Gate
- **Settings** — Dry Run Mode toggle (yellow banner when active)
- **Change History** — Audit trail of all config changes with:
  - Action badges (set, patch, delete, restore)
  - Before/after diff summary
  - Restore buttons to re-apply previous versions

→ [Configuration](/dashboard/configuration)
