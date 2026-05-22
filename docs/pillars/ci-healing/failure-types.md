# Failure Types

GitWire categorizes CI failures into 9 types. 5 of these are auto-healable.

## All Failure Types

| Type | Key | Auto-Healable? | Description |
|------|-----|----------------|-------------|
| Lint Error | `lint_error` | ✅ | ESLint, Pylint, RuboCop violations |
| Type Error | `type_error` | ✅ | TypeScript `tsc`, mypy, pyright errors |
| Format Error | `format_error` | ✅ | Prettier, Black, gofmt mismatches |
| Dependency Missing | `dependency_missing` | ✅ | Missing npm packages, pip modules |
| Flaky Test | `test_flaky` | ✅ | Tests that fail intermittently |
| Permanent Test Failure | `test_permanent` | ❌ | Tests with genuine logic bugs |
| Build Error | `build_error` | ❌ | Compilation, bundling, webpack errors |
| Infrastructure Error | `infra_error` | ❌ | Out of memory, network, service down |
| Unknown | `unknown` | ❌ | Cannot determine root cause |

## HEALABLE_TYPES

The `@gitwire/core` package exports the set of healable types:

```js
import { HEALABLE_TYPES } from "@gitwire/core";

// Set {
//   'lint_error',
//   'type_error',
//   'test_flaky',
//   'dependency_missing',
//   'format_error'
// }
```

## How Claude Determines the Type

Claude is prompted with the failure logs and asked to:

1. Read the last 100 lines of the log
2. Identify the specific error category
3. Determine if it's auto-fixable
4. Provide a root cause explanation

The diagnosis uses the `ANTHROPIC_API_KEY` configured in your environment.

## Heal Status

| Status | Meaning |
|--------|---------|
| `pending` | Newly detected, not yet processed |
| `attempted` | Healing in progress |
| `healed` | Fix PR opened successfully |
| `failed` | Healing attempted but failed |
| `skipped` | Failure type not healable |

## Constants Reference

See [Failure Types Configuration](/configuration/failure-types) for the full enum definitions.

→ [Auto Patch PRs](/pillars/ci-healing/auto-patch-prs)
