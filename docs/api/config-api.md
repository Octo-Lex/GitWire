# Config API

Manage per-repository configuration overrides via REST API. These override the `.gitwire.yml` file and built-in defaults.

## Endpoints

### Get Resolved Config

```bash
GET /api/config/:owner/:repo
```

Returns the fully resolved config (defaults ← YAML ← DB overrides).

**Response:**

```json
{
  "source": "database",
  "config": {
    "pillars": {
      "triage": { "enabled": true, "auto_label": true },
      "ci_healing": { "enabled": true, "min_confidence_to_patch": "high" }
    },
    "settings": { "dry_run": false }
  }
}
```

`source` indicates which layer won:
- `"yaml_or_default"` — no DB overrides
- `"database"` — DB overrides present

### Set Config (Full Replace)

```bash
PUT /api/config/:owner/:repo
Content-Type: application/json

{
  "pillars": {
    "triage": { "enabled": true },
    "ci_healing": { "enabled": false }
  },
  "settings": { "dry_run": true }
}
```

Replaces **all** DB overrides. Missing keys revert to YAML/defaults.

### Patch Config (Partial Update)

```bash
PATCH /api/config/:owner/:repo
Content-Type: application/json

{
  "pillars": {
    "ci_healing": { "min_confidence_to_patch": "high" }
  }
}
```

Merges with existing DB overrides. Only specified keys are changed.

### Delete Config Overrides

```bash
DELETE /api/config/:owner/:repo
```

Removes all DB overrides. Config reverts to `.gitwire.yml` + defaults.

**Response:**

```json
{
  "message": "Config overrides deleted — reverted to YAML + defaults"
}
```

### Get Config History

```bash
GET /api/config/:owner/:repo/history
```

Returns the version history of config changes.

**Response:**

```json
{
  "history": [
    {
      "id": 15,
      "action": "patch",
      "updated_by": "dashboard",
      "before": { "pillars": { "ci_healing": { "enabled": true } } },
      "after": { "pillars": { "ci_healing": { "min_confidence_to_patch": "high" } } },
      "created_at": "2026-05-23T01:00:00Z"
    }
  ]
}
```

### Restore Config Version

```bash
POST /api/config/:owner/:repo/restore/:id
```

Re-applies a historical config snapshot. Creates a new history entry with `action: "restore"`.

**Response:**

```json
{
  "message": "Config restored to version 12",
  "config": { "..." }
}
```

## Authentication

All config endpoints require the API key:

```bash
Authorization: Bearer <API_KEY>
```

## Common Operations

### Enable Dry Run

```bash
curl -X PATCH https://gitwire.example.com/api/config/org/repo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"settings":{"dry_run":true}}'
```

### Disable a Pillar

```bash
curl -X PATCH https://gitwire.example.com/api/config/org/repo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"pillars":{"issue_fix":{"enabled":false}}}'
```

### Raise Confidence Threshold

```bash
curl -X PATCH https://gitwire.example.com/api/config/org/repo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"pillars":{"ci_healing":{"min_confidence_to_patch":"high"}}}'
```

→ [Policy-as-Code](/configuration/policy-as-code) | [Dashboard Config](/dashboard/configuration) | [REST API Reference](/api/rest-api-reference)
