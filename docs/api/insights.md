# Insights API

Fleet-wide overview and analytics.

## Overview

```
GET /api/insights/overview
```

Fleet-wide summary statistics.

```json
{
  "repos": 18,
  "open_issues": 42,
  "open_prs": 12,
  "ci_success_rate": 0.87,
  "avg_merge_time_hours": 36,
  "installations": 3
}
```

## Repository Health

```
GET /api/insights/repos
```

Health summary per repository.

## Velocity Metrics

```
GET /api/insights/velocity
```

Issue and PR velocity over time.

## CI Trends

```
GET /api/insights/ci-trend
```

CI pass/fail trends over time, useful for charting.

→ [Fix Attempts API](/api/fix-attempts)
