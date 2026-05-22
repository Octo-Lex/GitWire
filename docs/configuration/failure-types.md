# Failure Types

CI failure categorization used by the CI Heal Worker.

## FAILURE_TYPES Constant

```js
import { FAILURE_TYPES } from "@gitwire/core";
```

## All Failure Types

| Type | Constant | Auto-Healable | Description |
|------|----------|---------------|-------------|
| `lint_error` | `FAILURE_TYPES.LINT_ERROR` | ✅ | Linter violations (ESLint, Pylint) |
| `type_error` | `FAILURE_TYPES.TYPE_ERROR` | ✅ | Type checker errors (tsc, mypy) |
| `test_flaky` | `FAILURE_TYPES.TEST_FLAKY` | ✅ | Intermittent test failures |
| `dependency_missing` | `FAILURE_TYPES.DEPENDENCY_MISSING` | ✅ | Missing packages |
| `format_error` | `FAILURE_TYPES.FORMAT_ERROR` | ✅ | Formatter mismatches (Prettier, Black) |
| `test_permanent` | `FAILURE_TYPES.TEST_PERMANENT` | ❌ | Genuine test logic bugs |
| `build_error` | `FAILURE_TYPES.BUILD_ERROR` | ❌ | Compilation/bundling failures |
| `infra_error` | `FAILURE_TYPES.INFRA_ERROR` | ❌ | Infrastructure issues (OOM, network) |
| `unknown` | `FAILURE_TYPES.UNKNOWN` | ❌ | Cannot determine root cause |

## HEALABLE_TYPES Set

```js
import { HEALABLE_TYPES } from "@gitwire/core";
```

Returns a `Set` containing only the auto-healable types:

```
Set { 'lint_error', 'type_error', 'test_flaky', 'dependency_missing', 'format_error' }
```

→ [Triage Priority](/configuration/triage-priority)
