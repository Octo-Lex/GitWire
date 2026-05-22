# Pre-Merge Validation

Safety checks that run before a fix PR is created.

## Validation Pipeline

Before committing any generated fix, GitWire runs these checks:

### 1. Non-Empty Check

The generated file must not be empty. Empty files indicate a generation failure.

### 2. Line Delta Check

| Metric | Limit | Rationale |
|--------|-------|-----------|
| Maximum lines added | 500 | Prevents massive generated blobs |
| Maximum lines removed | 80% of original | Prevents deletion attacks |

### 3. Syntax Balance Check

Basic bracket and parenthesis balance verification:

- Opening `{` count ≈ closing `}` count (±2 tolerance)
- Opening `(` count ≈ closing `)` count (±2 tolerance)

This catches obvious truncation or corruption in generated code.

### 4. File Count Check

A single fix attempt must not modify more than 5 files.

## Rejection

If any validation check fails:

- The fix attempt is marked as `rejected` in the database
- The `error` field contains the specific validation failure reason
- **No branch or PR is created**
- The issue remains open for manual fixing

## Complexity Assessment

Claude also provides a complexity rating:

| Complexity | Criteria |
|------------|----------|
| `trivial` | Single-line fix, obvious correction |
| `simple` | Small block change, clear scope |
| `moderate` | Multiple changes, some reasoning needed |
| `complex` | Multi-file, architectural decisions |

This is informational only — it does not gate the PR creation.

## Confidence Calibration

| Confidence | Criteria |
|------------|----------|
| `high` | Low complexity, file fetched successfully, single fix |
| `medium` | Moderate complexity, partial file fetch, 2-3 fixes |
| `low` | High complexity, file fetch failed, many fixes |

→ [Maintainer Tools](/pillars/maintainer/maintainer-tools)
