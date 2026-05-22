# First Contributor Fix

Enable GitWire to autonomously fix an issue with an AI-generated PR.

## Prerequisites

- GitWire is deployed and triaging issues
- The issue has a qualifying label (`bug`, `good first issue`, `help wanted`, `enhancement`, or `documentation`)

## Step 1: Label an Issue

Ensure the issue has one of the scope guard labels. For example, add the `bug` label to an issue.

## Step 2: Trigger the Fix

```bash
curl -X POST https://gitwire.yourdomain.com/api/fix/owner/repo/issues/42 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Or wait for the [Issue Fix Worker](/workers/issue-fix-worker) to pick it up automatically.

## Step 3: Watch the Pipeline

The worker runs a two-pass pipeline:

**Pass 1 (Analysis):**
- Claude reads the issue
- Identifies relevant files
- Ranks files by relevance score

**Pass 2 (Generation):**
- Top files are fetched from GitHub
- Claude generates full-file fixes
- Pre-merge validation runs
- Branch created, files committed, PR opened

## Step 4: Check the Result

```bash
# Get fix status
curl https://gitwire.yourdomain.com/api/fix/owner/repo/issues/42 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

Response:
```json
{
  "status": "submitted",
  "pr_number": 15,
  "branch_name": "gitwire/fix-42",
  "complexity": "simple",
  "explanation": "Added null check before accessing user.name"
}
```

## Step 5: Review the PR

1. Go to the PR on GitHub
2. Review the changes
3. Run CI checks
4. Merge if satisfied

## Rate Limits

| Limit | Value |
|-------|-------|
| Per repo per day | 3 fixes |
| Per issue | 1 fix |
| Max files per fix | 5 |

If the rate limit is hit, the API returns a message and no job is created.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Issue not picked up | Check it has a qualifying label |
| Fix rejected | Check pre-merge validation: line delta, syntax, file count |
| Rate limited | Wait for the daily reset or check repo's fix attempt count |
| Bad fix generated | Check `complexity` field — complex issues may need manual review |

→ [Custom Enforcement](/guides/custom-enforcement)
