# Test Suite Classification (Wave 2 / issue #94)

## Authority

This document records **existing CI behavior**, not a new exclusion. The CI
configuration at `.github/workflows/ci.yml` already enforces the tier
structure:

- **web-tests** (line 124-130): `jest --roots tests/unit` — scoped to
  `tests/unit/` only. No `GITWIRE_BASE_URL` injected.
- **web-receipt-integration-tests** (line 144-157): `jest tests/integration`
  with `--testPathIgnorePatterns='quality-gate-provenance\.test\.js$'`.
  Comment at line 146: "requires a live API — excluded until PR 4."
  No `GITWIRE_BASE_URL`, `API_KEY`, or stress env vars injected.
- **All other suites** (`tests/api/`, `tests/e2e/`, `tests/stress/`): NOT
  executed by any CI job. They are outside the Jest `--roots` scope.

## Per-Suite Classification (45 suites)

### Category: API integration tests (9 suites)

| Path | Tier | CI job | CI command | Selected by CI? | Required env | Requires real GitHub? | Status |
|------|------|--------|------------|-----------------|--------------|----------------------|--------|
| `tests/api.ci.test.js` | server-backed | none | — | No | `GITWIRE_BASE_URL`, `API_KEY`, `GITWIRE_STRESS_ENV=isolated` | No (uses stress fixtures) | Excluded by CI scope |
| `tests/api.core.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.duplicates.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.fix.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.maintainer.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.phase2.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.phase3.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.phase4.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |
| `tests/api.triage.test.js` | server-backed | none | — | No | same | No | Excluded by CI scope |

### Category: End-to-end tests (21 suites)

| Path | Tier | CI job | Selected by CI? | Required env | Requires real GitHub? | Status |
|------|------|--------|-----------------|--------------|----------------------|--------|
| `tests/e2e/ai-review.test.js` | server-backed | none | No | `GITWIRE_BASE_URL`, `API_KEY`, `GITWIRE_STRESS_ENV` | No (fixtures) | Excluded |
| `tests/e2e/api-actions.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-auth.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-config.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-deliveries.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-gates.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-readiness.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-relay.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-transfers.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/api-waivers.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/ci-heal.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/cross-cutting.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/full-pipeline.test.js` | server-backed | none | No | `GITWIRE_API_KEY`, `gh CLI` | **YES — creates real PRs** | Excluded |
| `tests/e2e/heal-outcome.test.js` | server-backed | none | No | `GITWIRE_BASE_URL`, `API_KEY` | No | Excluded |
| `tests/e2e/issue-fix.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/maintainer.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/reconciliation.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/sync.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/triage-issue.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/triage-pr.test.js` | server-backed | none | No | same | No | Excluded |
| `tests/e2e/webhook-intake.test.js` | server-backed | none | No | same | No | Excluded |

### Category: Integration tests (1 suite)

| Path | Tier | CI job | CI command | Selected by CI? | Runtime skip condition | Status |
|------|------|--------|------------|-----------------|----------------------|--------|
| `tests/integration/quality-gate-provenance.test.js` | server-backed | web-receipt-integration-tests | `jest tests/integration --testPathIgnorePatterns='quality-gate-provenance\.test\.js$'` | **Excluded by name** | Throws if `GITWIRE_API_URL` unset | Excluded by `--testPathIgnorePatterns` at CI line 157 |

### Category: Stress tests (14 suites)

| Path | Tier | CI job | Selected by CI? | Required env | Requires real GitHub? | Status |
|------|------|--------|-----------------|--------------|----------------------|--------|
| `tests/stress/api-flood.test.js` | stress | none | No | `GITWIRE_BASE_URL`, `API_KEY`, `GITWIRE_STRESS_ENV=isolated`, `GITWIRE_STRESS_MUTATION_BUDGET` | No (fixtures) | Excluded |
| `tests/stress/auth-edge-cases.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/db-concurrency.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/longevity.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-enforcement.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-maintainer.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-phase2.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-phase3.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-phase4.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/mutation-repos-sync-fix.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/pagination-boundary.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/payload-validation.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/rate-limit.test.js` | stress | none | No | same | No | Excluded |
| `tests/stress/webhook-simulation.test.js` | stress | none | No | same | No | Excluded |

## Summary

- **44 suites** require `GITWIRE_BASE_URL` / `GITWIRE_STRESS_ENV` (via
  `tests/helpers.js` → `tests/target-policy.js` `loadPolicy()`).
- **1 suite** (`tests/e2e/full-pipeline.test.js`) requires `GITWIRE_API_KEY`
  and `gh CLI` with push access — creates real PRs on GitHub.
- **1 suite** (`tests/integration/quality-gate-provenance.test.js`) requires
  `GITWIRE_API_URL` and `GITWIRE_API_KEY` — explicitly excluded by
  `--testPathIgnorePatterns` in the CI job that runs `tests/integration`.
- **None** of the 45 are selected by any CI job. They are outside the Jest
  `--roots tests/unit` scope or explicitly ignored.
- **Disposable substitutes** (Tier 2 proof harnesses) cover the same
  integration paths without requiring a deployed server.
