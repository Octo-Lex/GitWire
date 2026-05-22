# Review Findings

Categories and severity levels for AI code review findings.

## Finding Structure

Each finding returned by Claude is a JSON object:

```json
{
  "category": "security",
  "severity": "high",
  "title": "Hardcoded API key detected",
  "description": "An API key is hardcoded in src/config.ts line 42",
  "file": "src/config.ts",
  "line": 42,
  "suggestion": "Move the API key to an environment variable"
}
```

## Categories

| Category | Config Flag | Default | What It Detects |
|----------|-------------|---------|-----------------|
| Logic | `check_logic` | `true` | Race conditions, null refs, off-by-one |
| Security | `check_security` | `true` | Hardcoded secrets, injection, XSS |
| Architecture | `check_architecture` | `true` | Layer violations, circular deps |
| Cost | `check_cost_leaks` | `true` | Unbounded queries, resource leaks |
| Tests | `check_tests` | `true` | Missing tests, test quality |
| Docs | `check_docs` | `false` | Missing public API docs |

## Severity Levels

| Severity | Impact | Action |
|----------|--------|--------|
| `critical` | Security vulnerability or data loss risk | Always blocks merge |
| `high` | Significant bug or architectural issue | Blocks if `block_on_verdict` includes it |
| `medium` | Non-critical but should be addressed | Warning only |
| `low` | Style, minor improvements | Informational |
| `info` | Suggestions, best practices | Informational |

## Verdict Logic

The review verdict is determined by:

```
if any finding severity >= "high" → "request_changes"
if any finding severity >= "medium" → "needs_discussion"
else → "approved"
```

This can be customized per repo via `block_on_verdict` and `min_confidence_to_block`.

## Files Reviewed

| Config | Default | Description |
|--------|---------|-------------|
| `max_files_to_review` | 30 | Maximum files per review |
| `max_lines_to_review` | 2000 | Maximum total lines to analyze |
| `ignore_patterns` | `["*.lock", "package-lock.json", ...]` | Files to skip |

## Confidence Levels

| Level | Criteria |
|-------|----------|
| `high` | Clear, unambiguous findings |
| `medium` | Likely correct but context-dependent |
| `low` | Possible issue, needs human judgment |

→ [Audit Trail](/pillars/review-gate/audit-trail)
