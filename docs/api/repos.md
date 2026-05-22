# Repos API

Repository management endpoints.

## List Repos

```
GET /api/repos
```

Returns all synced repositories across all installations.

**Parameters:** Pagination (`page`, `limit`), filter by `owner`, `installation_id`.

```bash
curl https://gitwire.yourdomain.com/api/repos \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Get Repository

```
GET /api/repos/:owner/:repo
```

Returns metadata for a specific repository.

```bash
curl https://gitwire.yourdomain.com/api/repos/elephant-rock-lab/GitWire \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**

```json
{
  "github_id": 12345,
  "full_name": "elephant-rock-lab/GitWire",
  "owner": "elephant-rock-lab",
  "name": "GitWire",
  "private": true,
  "default_branch": "master",
  "language": "JavaScript",
  "stars": 0,
  "open_issues": 5,
  "open_prs": 2,
  "last_synced_at": "2026-05-18T12:00:00Z"
}
```

## Sync Repository

```
POST /api/repos/:owner/:repo/sync
```

Trigger a sync job for a specific repository. The sync runs asynchronously in the background.

```bash
curl -X POST https://gitwire.yourdomain.com/api/repos/owner/repo/sync \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**

```json
{ "message": "Sync queued for owner/repo" }
```

→ [Issues API](/api/issues)
