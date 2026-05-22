# Issue Fix Worker

Autonomous contributor — analyzes issues and generates code fix PRs.

## Queue: `issue-fix`

## Two-Pass Pipeline

### Pass 1: Analysis

1. Fetch issue data (title, labels, description)
2. Check scope guard: issue must have `bug`, `good first issue`, `help wanted`, `enhancement`, or `documentation` label
3. Check rate limits: ≤ 3 per repo/day, ≤ 1 per issue
4. Send to Claude: "Analyze this issue and identify files to modify"
5. Claude returns: list of candidate files with relevance scores
6. Rank files by keyword match, proximity, language preference

### Pass 2: Generation

1. Fetch top-ranked file from GitHub Contents API
2. Send file + issue context to Claude: "Generate a fix"
3. Claude returns the complete corrected file
4. Run pre-merge validation:
   - Non-empty check
   - Line delta (≤ 500 added, ≤ 80% removed)
   - Syntax balance (brackets/parens)
   - File count (≤ 5)
5. If valid:
   - Create branch: `gitwire/fix-{issue_number}`
   - Commit fixed files
   - Open PR with explanation

## Fix Status Lifecycle

```
pending → analyzing → generating → submitted
pending → analyzing → generating → failed
pending → analyzing → generating → rejected
```

## Confidence Calibration

| Level | Criteria |
|-------|----------|
| `high` | Trivial/simple fix, file fetched OK |
| `medium` | Moderate complexity, partial fetch |
| `low` | Complex, file fetch failed |

→ [Phase 2 Worker](/workers/phase2-worker)
