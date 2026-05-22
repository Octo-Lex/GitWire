# Multi-Repo Insights

Real-time dashboard and analytics across all your connected repositories.

## Overview

The Insights pillar provides a unified view of your entire GitHub fleet:

| Feature | Description |
|---------|-------------|
| **Fleet Overview** | Repos, issues, PRs, CI runs across all installations |
| **Health Metrics** | Issue velocity, CI success rates, merge times |
| **CI Trends** | Historical CI pass/fail trends with Recharts |
| **Activity Feed** | Recent actions across all repos |

## Dashboard

The web dashboard (Next.js 16) provides:

| Page | Content |
|------|---------|
| `/` | Fleet overview with key metrics |
| `/repos` | Repository list with sync status |
| `/issues` | Issue list with triage info |
| `/pull-requests` | PR list with size/risk ratings |
| `/ci` | CI runs with healing status |
| `/insights` | Velocity, health, activity charts |
| `/fix-attempts` | Autonomous contributor history |

## Data Refresh

The dashboard uses **SWR** (Stale-While-Revalidate) for data fetching:

- Polls every 30 seconds for active pages
- Shows stale data while fetching fresh data
- No manual refresh needed

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/insights/overview` | Fleet-wide overview stats |
| `GET` | `/api/insights/repos` | Repository health summaries |
| `GET` | `/api/insights/velocity` | Issue/PR velocity metrics |
| `GET` | `/api/insights/ci-trend` | CI pass/fail trends over time |

## Example Response

```json
{
  "repos": 18,
  "open_issues": 42,
  "open_prs": 12,
  "ci_success_rate": 0.87,
  "avg_merge_time_hours": 36
}
```

## In This Section

- [Sync Engine](/pillars/insights/sync-engine) — How data stays fresh from GitHub
