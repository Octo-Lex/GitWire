# Scope Guards

Label-based filters and rate limits that control which issues are eligible for autonomous fixing.

## Label Filters

An issue must have **at least one** of these labels to be considered:

| Label | Meaning |
|-------|---------|
| `bug` | Confirmed or suspected bug |
| `good first issue` | Suitable for newcomers (usually simpler fixes) |
| `help wanted` | Maintainer explicitly wants external contributions |
| `enhancement` | Feature request or improvement |
| `documentation` | Documentation fix or addition |

Issues **without** any of these labels are silently skipped by the issue fix worker.

## Why These Labels?

These labels serve as **explicit opt-in signals** from maintainers:

1. **`bug`** — Clear reproduction, likely fixable with code changes
2. **`good first issue`** — Typically small scope, well-defined
3. **`help wanted`** — Maintainer is open to automated assistance
4. **`enhancement`** — Feature work that can be generated
5. **`documentation`** — Text changes, low risk of regression

## Rate Limits

| Limit | Value | Rationale |
|-------|-------|-----------|
| Fixes per repo per day | 3 | Prevents runaway AI activity |
| Fixes per issue | 1 | No retry loop on failed fixes |
| Max files per fix | 5 | Keeps PRs focused and reviewable |

## Bypassing Rate Limits

Rate limits are enforced at the worker level. To manually trigger a fix regardless:

```bash
curl -X POST https://gitwire.yourdomain.com/api/fix/owner/repo/issues/42 \
  -H "Authorization: Bearer YOUR_API_KEY"
```

This creates a fix attempt in the database. The worker will still check rate limits, but the API call creates the job.

## Bot Filter

The issue fix worker skips issues created by bot accounts (logins containing `[bot]`).

→ [File Scoring](/pillars/contributor/file-scoring)
