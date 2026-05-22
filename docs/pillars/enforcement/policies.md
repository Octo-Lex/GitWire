# Policies

Create and manage branch enforcement policies.

## Create a Policy

```bash
curl -X POST https://gitwire.yourdomain.com/api/enforcement/policies \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "protect-main",
    "description": "Enforce protection on main branch",
    "branch_pattern": "main",
    "min_reviews": 1,
    "require_status_checks": true,
    "required_status_check_contexts": ["ci/test", "ci/lint"],
    "enforce_admins": true,
    "block_force_pushes": true,
    "mode": "enforce",
    "enabled": true
  }'
```

## List Policies

```bash
curl https://gitwire.yourdomain.com/api/enforcement/policies \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Update a Policy

```bash
curl -X PUT https://gitwire.yourdomain.com/api/enforcement/policies/1 \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"min_reviews": 2, "enforce_admins": true}'
```

## Delete a Policy

```bash
curl -X DELETE https://gitwire.yourdomain.com/api/enforcement/policies/1 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Policy Fields Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | TEXT | ✅ | Unique name within the installation |
| `description` | TEXT | — | Human-readable description |
| `repo_filter` | TEXT | — | Glob pattern for repo matching |
| `branch_pattern` | TEXT | ✅ | Branch name pattern (e.g. `main`, `release/*`) |
| `min_reviews` | INT | — | Required approving review count |
| `require_signed_commits` | BOOLEAN | — | Require GPG-signed commits |
| `require_linear_history` | BOOLEAN | — | Prevent merge commits |
| `block_force_pushes` | BOOLEAN | — | Prevent force pushes |
| `block_deletions` | BOOLEAN | — | Prevent branch deletion |
| `enforce_admins` | BOOLEAN | — | Apply rules to repository admins |
| `require_status_checks` | BOOLEAN | — | Require passing status checks |
| `required_status_check_contexts` | TEXT[] | — | Specific status check names |
| `mode` | TEXT | ✅ | `enforce` or `audit` |
| `enabled` | BOOLEAN | — | Enable/disable the policy |

::: warning GitHub Free Tier
Branch protection on private repos requires GitHub Pro/Team. On free-tier repos, the reconciler gracefully skips enforcement.
:::

→ [Violations](/pillars/enforcement/violations)
