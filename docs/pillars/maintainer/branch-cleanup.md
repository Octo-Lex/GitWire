# Branch Cleanup

Automatically delete branches that have been merged into the default branch.

## How It Works

1. Fetch all branches for a repository via GitHub API
2. For each branch, check if it's been merged into the default branch
3. Skip branches that match exclusion rules
4. Delete remaining merged branches

## Exclusion Rules

| Rule | What's excluded |
|------|----------------|
| Default branch | The repo's main branch (e.g. `main`, `master`) |
| Protected branches | Branches with branch protection enabled |
| Open PR branches | Branches with an associated open pull request |
| `gitwire/*` branches | Auto-generated branches still being processed |

## Trigger

```bash
# Manual trigger
curl -X POST https://gitwire.yourdomain.com/api/maintainer/owner/repo/branch-cleanup \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Configuration

Branch cleanup is enabled/disabled per repo via `maintainer_settings`:

```json
{
  "cleanup_branches": true
}
```

## Safety

- Branches are only deleted if they have been **fully merged** into the default branch
- The default branch is **never** deleted
- Deletions are logged in `maintainer_actions` with `action_type: "branch_cleanup"`
- Each deletion has a unique idempotency key

## Actions Log

| Field | Value |
|-------|-------|
| `action_type` | `branch_cleanup` |
| `target_type` | `branch` |
| `target_number` | Branch name |
| `status` | `applied` or `skipped` |

→ [Settings API](/pillars/maintainer/settings-api)
