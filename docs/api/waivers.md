# Waivers API

Manage policy waivers — time-limited exceptions to pillar enforcement.

## Endpoints

### List Waivers

```
GET /api/waivers?repo=owner/repo&pillar=ci_healing&active=true
```

**Query parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `repo` | string | required | Repository full name (`owner/repo`) |
| `pillar` | string | all | Filter by pillar name |
| `active` | boolean | true | Show only active waivers |

**Response:**

```json
{
  "data": [
    {
      "id": 1,
      "pillar": "ci_healing",
      "scope": "branch",
      "scope_value": "release/*",
      "reason": "Release freeze",
      "granted_by": "username",
      "expires_at": "2026-06-01T00:00:00Z",
      "active": true,
      "created_at": "2026-05-23T18:00:00Z"
    }
  ]
}
```

### Check Waiver

```
GET /api/waivers/check?repo=owner/repo&pillar=ci_healing&scope=branch&scopeValue=release/1.0
```

**Response:**

```json
{
  "waived": true,
  "waiver": { "id": 1, "pillar": "ci_healing", "reason": "Release freeze", ... }
}
```

### Grant Waiver

```
POST /api/waivers
```

**Body:**

```json
{
  "repo": "owner/repo",
  "pillar": "ci_healing",
  "scope": "branch",
  "scopeValue": "release/*",
  "reason": "Release freeze",
  "grantedBy": "username",
  "expiresAt": "2026-06-01T00:00:00Z"
}
```

**Response:** `201 Created` with the created waiver.

### Revoke Waiver

```
DELETE /api/waivers/:id
```

**Body:**

```json
{
  "revokedBy": "username"
}
```

**Response:** The revoked waiver with `active: false`.

## Authentication

All endpoints require the `Authorization: Bearer <API_KEY>` header.
