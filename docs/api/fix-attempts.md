# Fix Attempts API

Autonomous contributor fix attempt management.

## Trigger Fix

```
POST /api/fix/:owner/:repo/issues/:number
```

Trigger an autonomous fix for a specific issue.

```bash
curl -X POST https://gitwire.yourdomain.com/api/fix/owner/repo/issues/42 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

**Response:**

```json
{
  "message": "Fix attempt queued for issue #42",
  "status": "pending"
}
```

## Get Fix Status

```
GET /api/fix/:owner/:repo/issues/:number
```

Returns the current fix attempt status for an issue.

```json
{
  "issue_number": 42,
  "status": "submitted",
  "pr_number": 15,
  "branch_name": "gitwire/fix-42",
  "complexity": "simple",
  "explanation": "Added null check before accessing user.name property"
}
```

## List Fix Attempts

```
GET /api/fix/:owner/:repo/attempts
```

All fix attempts for a repository. Supports pagination.

→ [Heal History API](/api/heal-history)
