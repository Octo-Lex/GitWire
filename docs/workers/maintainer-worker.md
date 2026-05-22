# Maintainer Worker

Runs scheduled maintenance tasks for configured repositories.

## Queue: `maintainer`

## Tasks

### Stale Scanner

Scans open issues and PRs:
- Items with no activity for `stale_issue_days` / `stale_pr_days` → post warning
- Items already warned for `stale_warn_days` → close
- Skips items with `pinned` or `keep-alive` labels
- Skips bot-created items
- Uses idempotency keys to prevent duplicate actions

### Branch Cleanup

Finds merged branches and deletes them:
- Skips default branch
- Skips protected branches
- Skips branches with open PRs
- Skips `gitwire/*` branches (active healing/fix branches)

## Triggering

The worker runs on a schedule, but can also be triggered manually:

```bash
curl -X POST https://gitwire.yourdomain.com/api/maintainer/owner/repo/stale-scan \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Configuration

Per-repo via `maintainer_settings`:
- `stale_issue_days` (default 60)
- `stale_pr_days` (default 30)
- `stale_warn_days` (default 7)
- `cleanup_branches` (default true)
- `enabled` (default true)

→ [Issue Fix Worker](/workers/issue-fix-worker)
