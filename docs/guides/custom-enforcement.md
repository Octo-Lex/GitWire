# Custom Enforcement

Set up branch enforcement policies to protect your repositories.

## Step 1: Create a Policy

```bash
curl -X POST https://gitwire.yourdomain.com/api/enforcement/policies \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "protect-main",
    "description": "Require 1 review + CI checks on main branch",
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

## Step 2: Run Reconciliation

```bash
curl -X POST https://gitwire.yourdomain.com/api/enforcement/run \
  -H "Authorization: Bearer YOUR_API_KEY"
```

The reconciler will:
1. Find all repos matching the policy (no `repo_filter` = all repos)
2. Compare desired state vs GitHub's actual branch protection
3. Create GitHub branch protection rules where missing
4. Record any violations

## Step 3: Check for Violations

```bash
curl https://gitwire.yourdomain.com/api/enforcement/violations \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Violations indicate repos where the actual protection doesn't match the policy.

## Step 4: Audit Mode (Optional)

To monitor without making changes:

```json
{
  "mode": "audit",
  "enabled": true
}
```

In audit mode, violations are recorded but GitHub settings are not modified.

## Example: Release Branch Protection

```bash
curl -X POST https://gitwire.yourdomain.com/api/enforcement/policies \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "protect-releases",
    "branch_pattern": "release/*",
    "min_reviews": 2,
    "require_signed_commits": true,
    "require_linear_history": true,
    "block_force_pushes": true,
    "block_deletions": true,
    "mode": "enforce",
    "enabled": true
  }'
```

::: warning GitHub Free Tier
Branch protection on private repos requires GitHub Pro/Team. The reconciler gracefully skips repos on the free tier.
:::

→ [Audit & Compliance](/guides/audit-compliance)
