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
- **Pillar cards** (9) — Toggle each pillar on/off, configure sub-options:
  - Issue & PR Triage: auto_label, auto_comment, duplicate_detection, triggers
  - Self-Healing CI: auto_patch, max_fix_attempts, min_confidence_to_patch, triggers
  - Autonomous Contributor: max_file_changes, max_line_changes, min_confidence_to_submit
  - Maintainer Tools: stale config, branch cleanup
  - Branch Enforcement, Merge Queue, AI Review Gate, Trust
- **Settings** — Dry Run Mode toggle (yellow banner when active)
- **Change History** — Audit trail of all config changes with:
  - Action badges (set, patch, delete, restore)
  - Before/after diff summary
  - Restore buttons to re-apply previous versions

## Decisions (`/decisions`)

Worker decision log with full search/filter:
- **Free-text search** — Search across decision reasons
- **Source filter** — Filter by worker (ci_heal, triage, ai_review, etc.)
- **Decision filter** — acted, skipped, dry_run, blocked
- **Pillar filter** — 9 pillar dropdown
- **Date range** — From/to date pickers
- **Expandable detail** — Metadata, config_used JSON, conditions
- **Export** — JSON and Markdown audit bundles
- **Pagination** — Server-side paginated results

## Dry-Run Proof (`/dry-run`)

Non-mutating evaluation evidence:
- **Safety-first labels** — "Would have", "Skipped mutation", never implies execution
- **Decision pinned to dry_run** — Cannot view executed actions here
- **Filters** — Repo, pillar, source, target type, date range, free-text
- **Expandable detail** — Planned reason, config used, metadata, conditions
- **Deep links** — Links to decision log and managed actions
- **Export** — JSON and Markdown audit bundles

## Waivers (`/waivers`)

Policy waiver visibility across all repos:
- **Global view** — All repos, not just one at a time
- **Status computation** — Active, expiring (within 7 days), expired
- **Filters** — Repo, pillar, scope, status, free-text search
- **Expandable detail** — Metadata, reason, decision linkage
- **Decision linkage** — Links to decision log filtered by matching pillar+repo+skipped
- **Grant/revoke** — Create and revoke waivers (time-limited exceptions)
- **Export** — JSON audit bundle

## Activity (`/activity`)

Unified action feed across 9 source tables:
- **Source filter bar** — Filter by action type
- **Color-coded badges** — Per-source coloring
- **Pagination** — Server-side paginated results

## Policy Preview (`/policy-preview`)

Non-mutating policy analysis workflow:
- **YAML editor** — Paste proposed `.gitwire.yml` for analysis
- **Validation panel** — Errors, warnings, enabled pillars, dry-run state, risky settings with mitigation badges, collapsible normalized config
- **Simulation panel** — Replay proposed policy against historical events; summary cards (Considered, Would act, Would skip, Dry-run, Block, Unsupported); per-event expandable rows with conditions, would_do, and original decision
- **Impact comparison panel** — Compare current vs proposed policy; summary cards for dry-run change, pillar changes, risk changes; per-event impact table with `current → proposed` decision transitions
- **Recommendations panel** — Deterministic guardrail recommendations grouped by severity (critical/warning/info); each card includes reason, suggested change, config path, and evidence chips
- **Safety banner** — All operations are non-mutating: no config saves, no queue jobs, no GitHub writes

### Recommended workflow

1. Paste proposed `.gitwire.yml` and click **Validate**
2. Review risks, warnings, and enabled pillars
3. Select a repo and click **Run simulation** to see historical impact
4. Select the same repo and click **Compare impact** to see what changes vs current policy
5. Optionally select a repo and click **Generate recommendations** for rollout guardrails
6. Roll out with dry-run first when enabling risky or newly permissive automation

## Readiness (`/readiness`)

## Rollouts (`/rollouts`)

Controlled policy lifecycle dashboard:
- **List view** — All rollout plans with status badges, repo, dry-run indicator, risk counts, and actor trail
- **Filters** — Status (8 states), repo full name
- **Detail view** — Lifecycle timeline, evidence cards (validation, simulation, diff, recommendations), audit trail (all actors with timestamps and reasons)
- **Policy snapshots** — Collapsible redacted JSON blocks (proposed, previous, replaced)
- **Rollback evidence** — Config hashes and capture booleans
- **Actions panel** — State-driven buttons showing only valid next actions
- **Confirmation modal** — Actor input, reason textarea, consequence warnings
  - Promote/rollback: amber warning (writes policy)
  - Reject/cancel: red warning (terminal)
  - Approve: explains no policy written yet
- **Critical recommendation acknowledgement** — Checkboxes for critical recs on approve

### State-driven actions

| State | Actions |
|---|---|
| `draft` | cancel |
| `validated` | cancel |
| `review_ready` | approve, reject, cancel |
| `approved` | promote, cancel |
| `promoted` | rollback |
| terminal | (none) |

## Readiness (`/readiness`) — original

Fleet-wide repo readiness scores:
- **Fleet overview** — All repos scored out of 100, sorted by score
- **Per-repo detail** — 9 weighted checks with pass/fail status
- **Checks** — .gitwire.yml present, webhooks active, branch protection, config synced, etc.

→ [Configuration](/dashboard/configuration)
