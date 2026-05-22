# Violations

Detection and tracking of enforcement policy violations.

## How Violations Are Detected

The reconciler compares each policy's desired state against the actual GitHub branch protection settings:

1. Load all enabled policies
2. For each policy, find matching repos (via `repo_filter`)
3. For each repo, fetch actual branch protection from GitHub
4. Compare desired vs. actual
5. If drift found → create/update violation record

## Violation Lifecycle

```
open → remediated (auto-fix applied)
open → suppressed (maintainer dismisses)
```

## List Violations

```bash
# All violations
curl https://gitwire.yourdomain.com/api/enforcement/violations \
  -H "Authorization: Bearer YOUR_API_KEY"

# For a specific repo
curl https://gitwire.yourdomain.com/api/enforcement/violations/owner/repo \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Suppress a Violation

```bash
curl -X POST https://gitwire.yourdomain.com/api/enforcement/violations/1/suppress \
  -H "Authorization: Bearer YOUR_API_KEY"
```

## Violation Record

| Field | Description |
|-------|-------------|
| `policy_id` | The policy that was violated |
| `repo_id` | The repository |
| `branch` | The branch name |
| `violations` | JSONB array: `["min_reviews", "require_status_checks"]` |
| `status` | `open`, `remediated` |
| `remediated_at` | When auto-fix was applied |
| `remediated_by` | Who/what applied the fix |

## Database Table

**`enforcement_violations`** — Unique on `(policy_id, repo_id, branch)`. Updated on each reconciliation run.

→ [Config Validation](/pillars/enforcement/config-validation)
