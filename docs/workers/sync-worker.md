# Sync Worker

Keeps the local database in sync with GitHub.

## Queue: `sync`

## Job Types

| Job Name | Trigger | Scope |
|----------|---------|-------|
| `full-sync` | Startup / manual | All installations |
| `sync-installation` | App installed/updated | One installation |
| `sync-repo` | New repo webhook | Single repository |

## Sync Process

For each repository:

1. **Fetch metadata** — `GET /repos/:owner/:repo` → upsert `repositories`
2. **Fetch issues** — `GET /repos/:owner/:repo/issues?state=open` → upsert `issues`
3. **Fetch PRs** — `GET /repos/:owner/:repo/pulls?state=open` → upsert `pull_requests`
4. **Fetch CI runs** — `GET /repos/:owner/:repo/actions/runs?per_page=50` → upsert `ci_runs`
5. **Fetch collaborators** — `GET /repos/:owner/:repo/collaborators` → upsert `repo_collaborators`
6. **Fetch members** — `GET /orgs/:org/members` → upsert `members` (org installations only)
7. **Fetch branch rules** — `GET /repos/:owner/:repo/branches` → upsert `branch_rules`

## Error Handling

- Errors are always logged with `logger.warn()` (never silently caught)
- If one repo fails, the sync continues to the next
- Failed repos are recorded in the sync job metadata

## Soft Deletes

When a repo is deleted on GitHub, the sync worker sets `deleted_at` on the repository record rather than deleting it. This preserves historical data.

→ [Maintainer Worker](/workers/maintainer-worker)
