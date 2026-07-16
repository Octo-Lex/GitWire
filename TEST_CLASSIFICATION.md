# GitWire Test Classification

Tests are classified along two independent dimensions: **type** and
**execution environment**. This taxonomy determines which tests run in
PR CI, nightly CI, and isolated environments.

## Dimensions

### Test type

| Type | Description |
|------|-------------|
| Unit | Pure functions, no I/O, no network, no external services |
| Integration | Multiple components or modules tested together in-process |
| End-to-end | Full pipeline through real HTTP, real workers, real database |
| Stress | Concurrency, throughput, and saturation testing |
| Chaos | Failure injection, crash recovery, resource exhaustion |

### Execution environment

| Environment | Description |
|-------------|-------------|
| Repository-local | Runs in CI with no external services beyond Postgres/Redis containers |
| Mocked-external | GitHub or executor interactions replaced with test doubles |
| Isolated-live | Requires a live GitWire server with GITWIRE_STRESS_ENV=isolated |

## Suite mapping

| Path | Type | Environment | PR CI | Notes |
|------|------|-------------|-------|-------|
| `packages/core/tests/**` | Unit | Repository-local | Required | |
| `packages/rules/tests/**` | Unit | Repository-local | Required | |
| `packages/runtime/tests/**` | Unit | Repository-local | Required | |
| `packages/executor-service/tests/**` | Unit | Repository-local | Required | |
| `packages/web/tests/unit/**` | Unit | Repository-local | Required | `forceExit` documented exception (handle leaks from Redis/DB imports) |
| `packages/web-dashboard/tests/**` | Unit | Repository-local | Required | |
| `packages/web/tests/integration/backend-receipt-verifier-chain.test.js` | Integration | Repository-local | Required | Calls real `buildExecutionReceipt()` and `validateGap1ValidatorBindings()` |
| `packages/web/tests/integration/plan-execution-chain.test.js` | Integration | Repository-local | Required | Synthetic backend results through real verifier gate |
| `packages/web/tests/integration/plan-execution-conformance-chain.test.js` | Integration | Repository-local | Required | Planner → normative_steps → hash chain |
| `packages/web/tests/integration/quality-gate-provenance.test.js` | Integration | Isolated-live | Excluded | Requires live API + `GITWIRE_API_URL` |
| `packages/web/tests/e2e/**` | End-to-end | Isolated-live | Excluded | Requires `GITWIRE_API_URL`, `GITWIRE_API_KEY` |
| `packages/web/tests/stress/**` | Stress | Isolated-live | Excluded | Requires `GITWIRE_STRESS_ENV=isolated`, `GITWIRE_BASE_URL`, `API_KEY` |
| Future failure-injection suites | Chaos | Isolated-live | Excluded | Not yet implemented |

## PR CI policy

PR CI runs only **repository-local** tests. No job may:

- Access production URLs or credentials
- Contact a real GitHub repository
- Require CT 115 or the future isolated Compose environment
- Use `--passWithNoTests` (a suite with zero tests is a failure)
- Use `--if-present` (every required workspace must have a test script)

## Receipt-integrity integration tests

The three mandatory receipt-integrity integration tests in PR CI:

1. `backend-receipt-verifier-chain.test.js` — verifies `buildExecutionReceipt()` binds conformance fields and `validateGap1ValidatorBindings()` accepts/rejects correctly
2. `plan-execution-chain.test.js` — synthetic backend results through real receipt builder and verifier
3. `plan-execution-conformance-chain.test.js` — planner → normative_steps → hash chain verification

New files under `tests/integration/` must be classified before merge.

## `forceExit` exception

`packages/web/jest.config.js` sets `forceExit: true` globally. This is a
documented temporary exception caused by handle leaks from Redis/DB client
imports in unit-test modules. The web CI job does not add `--forceExit` on
the command line (it inherits from the config) and does not combine it
with `--detectOpenHandles` (which produces unclear semantics).

When the handle leaks are fixed, remove `forceExit: true` from
`jest.config.js` and add `--detectOpenHandles` to the CI command.

All other packages use `--detectOpenHandles` without `--forceExit`.
