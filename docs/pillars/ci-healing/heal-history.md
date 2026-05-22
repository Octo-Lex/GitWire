# Heal History

Track and review all CI healing attempts across your repositories.

## Overview

Every healing attempt is recorded in the `heal_prs` table with full traceability from CI failure to fix PR.

## Viewing Heal History

### Dashboard

The **CI** page in the dashboard shows:
- Recent CI runs with healing status
- Heal success/failure rates
- List of auto-generated fix PRs

### API

```bash
# All heal history (paginated)
curl https://gitwire.yourdomain.com/api/heal \
  -H "Authorization: Bearer YOUR_API_KEY"

# Heal history for a specific repo
curl https://gitwire.yourdomain.com/api/heal/owner/repo \
  -H "Authorization: Bearer YOUR_API_KEY"

# Heal history for a specific CI run
curl https://gitwire.yourdomain.com/api/heal/run/12345678901 \
  -H "Authorization: Bearer YOUR_API_KEY"

# Statistics
curl https://gitwire.yourdomain.com/api/heal/stats \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Statistics

The `/api/heal/stats` endpoint returns:

```json
{
  "total": 42,
  "healed": 28,
  "failed": 8,
  "skipped": 6,
  "success_rate": 0.777
}
```

## Database Tables

| Table | Purpose |
|-------|---------|
| `ci_runs` | All CI runs with healing fields |
| `heal_prs` | Auto-generated fix PRs |

## Key Fields in `ci_runs`

| Column | Description |
|--------|-------------|
| `heal_status` | `pending`, `attempted`, `healed`, `failed`, `skipped` |
| `heal_failure_type` | One of 9 failure type categories |
| `heal_root_cause` | Claude's diagnosis text |
| `heal_fix_applied` | Description of the fix |
| `heal_confidence` | `high`, `medium`, or `low` |
| `healed_at` | Timestamp of successful heal |

→ [Autonomous Contributor](/pillars/contributor/autonomous-contributor)
