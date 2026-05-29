# Quality Gates

Quality gates are named sets of metric thresholds that evaluate repo health. When a gate fails on a PR, GitWire posts a `failure` check status on GitHub — which can be configured as a **required status check** to **block the merge**.

## Quick Start

### 1. Define gates in `.gitwire.yml`

```yaml
quality_gates:
  default:
    conditions:
      - metric: ci_failure_rate_7d
        operator: "<"
        threshold: 0.3
      - metric: triage_coverage
        operator: ">="
        threshold: 0.5
      - metric: readiness_score
        operator: ">="
        threshold: 40
```

### 2. Make it a required status check in GitHub

1. Go to **Settings → Branches → Branch protection rules** in your repo
2. Add rule for your main branch
3. Check **Require status checks to pass before merging**
4. Search for `gitwire/quality-gate` and select it

Now PRs can't be merged if any gate condition fails.

## Default Gate

GitWire ships with a default gate applied to all repos:

| Condition | Metric | Operator | Threshold |
|-----------|--------|----------|-----------|
| CI failure rate (7d) | `ci_failure_rate_7d` | `<` | 0.3 (30%) |
| Triage coverage | `triage_coverage` | `>=` | 0.5 (50%) |
| Readiness score | `readiness_score` | `>=` | 40/100 |

## Configuration

### Multiple Gates

```yaml
quality_gates:
  default:
    conditions:
      - metric: ci_failure_rate_7d
        operator: "<"
        threshold: 0.3

  strict:
    conditions:
      - metric: ci_failure_rate_7d
        operator: "<"
        threshold: 0.1
      - metric: triage_coverage
        operator: ">="
        threshold: 0.8
      - metric: heal_success_rate_7d
        operator: ">="
        threshold: 0.5
      - metric: readiness_score
        operator: ">="
        threshold: 70
```

### Non-Blocking Gates

Set `block_on_fail: false` for informational gates that don't block merges:

```yaml
quality_gates:
  informational:
    conditions:
      - metric: avg_triage_time_hours
        operator: "<="
        threshold: 24
    block_on_fail: false
```

### Operators

| Operator | Meaning |
|----------|---------|
| `<` | Less than |
| `<=` | Less than or equal |
| `>` | Greater than |
| `>=` | Greater than or equal |
| `==` | Equals |
| `!=` | Not equals |

## Available Metrics

| Metric | Type | Source | Description |
|--------|------|--------|-------------|
| `ci_failure_rate_7d` | ratio (0-1) | `ci_runs` | CI failure rate in last 7 days |
| `ci_failure_rate_30d` | ratio (0-1) | `ci_runs` | CI failure rate in last 30 days |
| `triage_coverage` | ratio (0-1) | `issues` | % of issues with triage classification |
| `open_issues` | count | `issues` | Number of open issues |
| `open_security_issues` | count | `issues` | Open issues labeled 'security' |
| `stale_issues_7d` | count | `issues` | Open issues with no activity in 7+ days |
| `heal_success_rate_7d` | ratio (0-1) | `heal_prs` | % of CI heal PRs merged in last 7 days |
| `heal_success_rate_30d` | ratio (0-1) | `heal_prs` | % of CI heal PRs merged in last 30 days |
| `heal_efficacy_rate_7d` | ratio (0-1) or null | `managed_actions` | Of merged heal PRs with outcome data, % where the next CI run passed (null if no data) |
| `fix_success_rate_7d` | ratio (0-1) | `fix_attempts` | % of fix attempts that succeeded in last 7 days |
| `duplicate_rate` | ratio (0-1) | `issues` | % of issues flagged as duplicates |
| `avg_triage_time_hours` | number | `issues` | Average hours from issue creation to triage |
| `avg_heal_time_hours` | number | `heal_prs` | Average hours from CI failure to heal PR |
| `readiness_score` | number (0-100) | computed | Repo readiness score |
| `webhook_events_7d` | count | `webhook_deliveries` | Webhook events in last 7 days |

## How It Works

### Evaluation Flow

```
PR Event → Webhook Pipeline → Quality Gate Evaluation → GitHub Check
                                     ↓
                              Fetch 14 metrics from DB
                                     ↓
                              Evaluate each condition
                                     ↓
                         All pass → ✅ success check
                         Any fail → ❌ failure check
```

### Pipeline Position

Quality gates evaluate **after** pillar workers and custom rules:

1. Pillar workers (triage, heal, review) — process event
2. Custom rules — evaluate expressions, dispatch actions
3. **Quality gates** — evaluate metrics, post check status
4. Response to GitHub

### GitHub Check Details

The check name is `gitwire/quality-gate` — separate from the existing `GitWire` check so you can:
- Require only the quality gate as a merge blocker
- Keep the main GitWire check informational

The check summary includes a table with each condition, its threshold, the actual value, and pass/fail status.

## Dashboard

The **Quality Gates** page (`/gates`) shows:

- **Fleet summary**: X/Y repos passing all gates
- **Per-repo detail**: gate conditions, actual values, pass/fail
- **Create/delete gates**: manage gates from the dashboard
- **Evaluate Now**: trigger manual evaluation
- **Raw metrics**: view all 14 metric values for a repo

## API

See [Quality Gates API](/api/gates.md) for endpoint documentation.
