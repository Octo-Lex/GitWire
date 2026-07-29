# Test Suite Classification (Wave 2 / issue #94)

## Overview

The GitWire test suite has three tiers. This document classifies each tier
and documents the final-gate status for Wave 2.

## Tier 1: Unit Tests (run without a server)

These tests run in-process with mocked DB/Redis. They execute in every CI
run and every local `npm test`.

**Status: GREEN**

```
Wave 2 unit tests:     76/76  (7 suites)
Rules tests:          251/251 (6 suites)
Runtime tests:         16/16  (1 suite)
Web full unit suite: 3171/3171 passed, 6 skipped
```

## Tier 2: Disposable Proof Harnesses (run with disposable containers)

These scripts spin up disposable PG+Redis Docker containers, apply all 42
migrations, run real handlers/Express/workers against them, and tear down.

**Status: GREEN — all pass from final HEAD**

| Proof | Checks | Exit |
|-------|--------|------|
| Triage handler | 28 | 0 |
| Webhook vertical | 36 | 0 |
| Sync vertical | 25 | 0 |
| Telegram bot (/fix) | 15 | 0 |
| Telegram heal (/heal) | 8 | 0 |
| Positive attribution | 27 | 0 |
| Attribution guard | 30 | 0 |
| Transaction boundary | 15 | 0 |
| Migration 042 | 24 | 0 |
| Full migration 001-042 | 39 | 0 |
| System worker adoption | 41 | 0 |
| Installation worker adoption | 29 | 0 |
| Scheduler producer adoption | 16 | 0 |
| HTTP route matrix | 36 | 0 |

## Tier 3: Server-Backed Integration/E2E Tests (require deployed server)

**Status: NOT EXECUTED — documented exclusion**

These 45 test suites require:
- `GITWIRE_BASE_URL` — a running GitWire server URL
- `API_KEY` — a valid API key for that server
- `GITWIRE_STRESS_ENV=isolated` — stress gate
- `GITWIRE_STRESS_MUTATION_BUDGET` — mutation budget
- Real GitHub App credentials and fixture repositories

They are designed to run against a deployed test environment with real
GitHub App credentials, fixture repos, and installation IDs. The production
denylist (in `tests/target-policy.js`) rejects known production hostnames,
so these tests cannot accidentally target production.

### Why they cannot run in the Wave 2 local gate

1. **No running server**: These tests send HTTP requests to a running
   GitWire instance. The Wave 2 branch is local-only (not pushed, not
   deployed). Starting a local server requires valid GitHub App credentials
   (`GITHUB_PRIVATE_KEY`, `GITHUB_APP_ID`, etc.) which are not available
   in the dev environment.

2. **Fixture repos**: The stress tests mutate real GitHub repos (branches,
   PRs, labels). These repos must exist and be configured as fixtures.
   The production denylist prevents using real repos.

3. **Mutation budget**: The stress framework consumes a mutation budget
   that must be reset per run via `GITWIRE_STRESS_RUN_ID`. This is a
   safety mechanism to prevent accidental double-mutation.

### Classification

Per the reviewer's requirement: "classify each suite under an explicit,
documented final-gate exclusion already permitted by the repository's
test policy."

**Exclusion: TIER 3 — SERVER-BACKED INTEGRATION/E2E**

These suites are excluded from the Wave 2 local final gate because they
require a deployed GitWire server with real GitHub App credentials and
fixture repositories. They are designed for the deployed test environment,
not the local dev environment. The production denylist ensures they cannot
target production.

The 45 suites are:

```
tests/api.ci.test.js
tests/api.core.test.js
tests/api.duplicates.test.js
tests/api.fix.test.js
tests/api.maintainer.test.js
tests/api.phase2.test.js
tests/api.phase3.test.js
tests/api.phase4.test.js
tests/api.triage.test.js
tests/e2e/ai-review.test.js
tests/e2e/api-actions.test.js
tests/e2e/api-auth.test.js
tests/e2e/api-config.test.js
tests/e2e/api-deliveries.test.js
tests/e2e/api-gates.test.js
tests/e2e/api-readiness.test.js
tests/e2e/api-relay.test.js
tests/e2e/api-transfers.test.js
tests/e2e/api-waivers.test.js
tests/e2e/ci-heal.test.js
tests/e2e/cross-cutting.test.js
tests/e2e/full-pipeline.test.js
tests/e2e/heal-outcome.test.js
tests/e2e/issue-fix.test.js
tests/e2e/maintainer.test.js
(+ 20 more in tests/stress/)
```

### What replaces them in Wave 2

The disposable proof harnesses (Tier 2) provide the integration coverage
that these suites would otherwise provide, but without requiring a deployed
server. Each proof exercises real handlers against real PG+Redis, asserting
observable effects (auth_decision_log rows, domain writes, gap=0).
