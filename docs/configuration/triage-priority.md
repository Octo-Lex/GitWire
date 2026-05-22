# Triage Priority

Priority levels assigned by AI issue classification.

## TRIAGE_PRIORITY Constant

```js
import { TRIAGE_PRIORITY } from "@gitwire/core";
```

## All Priorities

| Priority | Constant | Label Applied | Criteria |
|----------|----------|---------------|----------|
| `critical` | `TRIAGE_PRIORITY.CRITICAL` | `priority: critical` | Security vulnerabilities, data loss, outages |
| `high` | `TRIAGE_PRIORITY.HIGH` | `priority: high` | Breaking functionality, significant impact |
| `medium` | `TRIAGE_PRIORITY.MEDIUM` | `priority: medium` | Non-critical bugs, useful features |
| `low` | `TRIAGE_PRIORITY.LOW` | `priority: low` | Minor issues, nice-to-haves |

→ [CI Conclusion](/configuration/ci-conclusion)
