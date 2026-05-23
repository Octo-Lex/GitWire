# Policy Waivers

Time-limited exceptions to pillar enforcement. Grant temporary bypasses for release freezes, hotfix workflows, or special cases.

## Overview

Policy waivers let you temporarily disable a specific pillar for a repo, branch, PR, or issue — without editing `.gitwire.yml` or disabling the entire pillar.

Common use cases:

- **Release freeze** — pause CI healing on `release/*` branches during a freeze
- **Hotfix exception** — skip AI review on an urgent hotfix PR
- **Bot migration** — waive triage while migrating issue templates

## Granting Waivers

### Via Comment Command

```
/gitwire waive ci_healing for release/* until 2026-06-01 reason "release freeze"
/gitwire waive ai_review for 42 until 2026-05-25 reason "hotfix — skip review"
/gitwire waive triage reason "template migration"
```

**Syntax:**

```
/gitwire waive <pillar> [for <scope>] [until <date>] reason "<text>"
```

| Part | Required | Description |
|------|----------|-------------|
| `<pillar>` | Yes | Pillar to waive (`ci_healing`, `triage`, `ai_review`, etc.) |
| `for <scope>` | No | Branch name (glob), PR/issue number. Omit for repo-wide |
| `until <date>` | No | Expiry date (`YYYY-MM-DD`). Omit for indefinite |
| `reason "<text>"` | Yes | Why the waiver was granted |

### Via API

```bash
curl -X POST https://gitwire.erlab.uk/api/waivers \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "owner/repo",
    "pillar": "ci_healing",
    "scope": "branch",
    "scopeValue": "release/*",
    "reason": "Release freeze",
    "grantedBy": "username",
    "expiresAt": "2026-06-01T00:00:00Z"
  }'
```

## Revoking Waivers

```
/gitwire unwaive 42
```

Or via API:

```bash
curl -X DELETE https://gitwire.erlab.uk/api/waivers/42 \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"revokedBy": "username"}'
```

## Checking Waivers

### Via API

```bash
# List active waivers for a repo
curl https://gitwire.erlab.uk/api/waivers?repo=owner/repo \
  -H "Authorization: Bearer $TOKEN"

# Check if a specific pillar is waived
curl "https://gitwire.erlab.uk/api/waivers/check?repo=owner/repo&pillar=ci_healing&scope=branch&scopeValue=release/1.0" \
  -H "Authorization: Bearer $TOKEN"
```

### Response

```json
{
  "waived": true,
  "waiver": {
    "id": 42,
    "pillar": "ci_healing",
    "scope": "branch",
    "scope_value": "release/*",
    "reason": "Release freeze",
    "granted_by": "username",
    "expires_at": "2026-06-01T00:00:00Z",
    "active": true
  }
}
```

## Scope Hierarchy

Waivers are evaluated from most specific to broadest:

| Scope | Matches | Example |
|-------|---------|---------|
| `issue` | Specific issue number | `for 123` |
| `pr` | Specific PR number | `for 42` |
| `branch` | Branch name (glob) | `for release/*` |
| `repo` | Entire repository | (omit `for` clause) |

A repo-wide waiver overrides all narrower scopes.

## Auto-Expiry

Waivers with an `expires_at` date are automatically deactivated when checked. No cron job needed — expiry happens lazily during `isWaived()` calls.

## Decision Logging

When a worker skips due to a waiver, it records a decision:

```json
{
  "source": "ci_healing",
  "decision": "skipped",
  "reason": "Policy waived: Release freeze (by username)",
  "conditions": [
    { "check": "waiver_active(42)", "result": true }
  ]
}
```

This ensures the audit trail shows **why** an action was skipped.
