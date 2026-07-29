# Wave 2 Final Report — Runtime Principal Identity & Scoped Authorization

**Issue:** #94
**Branch:** `wave/2-runtime-identity-authorization`
**Base:** `fcbaace` (Wave 1 merged)
**HEAD:** `2a90fd2`
**Commits:** 55

## Summary

Wave 2 completes runtime adoption of the Level 1 authority foundation in
**observe-only mode**. Every protected surface resolves a server-owned
principal, calls the central `authorize()`, and records structured evidence.
No enforcement blocking occurs yet (that is Wave 5).

## Adoption State (3-State Gate with Per-Surface Metadata)

| State              | Count | Meaning |
|--------------------|-------|---------|
| Declared           | 22    | Surface in declarations.js |
| Wired              | 17    | adoptWorker() at entry + structured metadata |
| Proven             | 6     | Passing disposable integration proof |
| Schedulers wired   | 5/5   | Each scheduler producer resolves a principal |

### Proven Surfaces (6)

| Surface          | Proof                                  | Checks |
|------------------|----------------------------------------|--------|
| `worker:triage`   | `run_triage_handler_pg_proof.mjs`     | 28     |
| `worker:webhook`  | `run_webhook_vertical_proof.mjs`      | 36     |
| `webhook:github`  | `run_webhook_vertical_proof.mjs`      | 36     |
| `worker:sync`     | `run_sync_vertical_proof.mjs`         | 25     |
| `telegram:fix`    | `run_telegram_bot_proof.mjs`          | 15     |
| `telegram:heal`   | `run_telegram_heal_proof.mjs`         | 8      |

### Wired But Not Proven (11)

All 9 repair-pipeline and installation-scoped workers, plus phase4 and
ciHeal. These are dynamically proven at the adoption level (system +
installation worker adoption proofs) but not yet at the full-domain level.

### Scheduler Producers (5/5 wired + proven)

Each scheduler resolves a system principal before enqueuing:
- `scheduleSyncJobs` → `system:scheduler`
- `scheduleMaintainerJobs` → `system:maintainer-worker`
- `schedulePhase3Jobs` → `system:phase3-worker`
- `schedulePhase4Jobs` → `system:phase4-worker`
- `runReconciliation` → `system:reconciliation-worker`

## Test Results

### Tier 1: Unit Tests (GREEN)
- Wave 2 unit tests: **76/76** (7 suites)
- Rules: **251/251**
- Runtime: **16/16**
- Web full unit suite: 3171 passed, 6 skipped

### Tier 2: Disposable Proofs (GREEN — 14 harnesses, 369 total checks)
- Triage handler: 28/28 ✓
- Webhook vertical: 36/36 ✓
- Sync vertical: 25/25 ✓
- Telegram bot (/fix): 15/15 ✓
- Telegram heal (/heal): 8/8 ✓
- Positive attribution: 27/27 ✓
- Attribution guard: 30/30 ✓
- Transaction boundary: 15/15 ✓
- Migration 042: 24/24 ✓
- Full migration 001-042: 39/39 ✓
- System worker adoption: 41/41 ✓
- Installation worker adoption: 29/29 ✓
- Scheduler producer adoption: 16/16 ✓
- HTTP route matrix: 36/36 ✓

All proofs exit 0 with natural termination.

### Tier 3: Server-Backed Integration/E2E (DOCUMENTED EXCLUSION)
45 suites require a deployed GitWire server with GitHub App credentials.
Classified under explicit documented exclusion in `TEST_CLASSIFICATION.md`.

## Security Constraints Honored

- ✅ Observe-only mode (no enforcement blocking)
- ✅ No push, PR, GitHub mutation, deployment, or production access
- ✅ No raw secrets in SQL/logs/evidence
- ✅ DCO sign-off on all commits
- ✅ No Co-Authored-By
- ✅ All proofs use disposable PG+Redis containers (cleaned up after)
- ✅ Natural process termination (no forced exit)
- ✅ Secret scan: CLEAN

## Schema Changes

- **Migration 041:** `legacy_key_mappings`, `auth_decision_log`,
  dual-write `principal_id` columns on 5 tables
- **Migration 042:** `attribution_gap_evidence` (append-only, with grants
  and triggers)
- **Rollback scripts:** `rollback_wave2.sql`, `rollback_wave2_042.sql`
  (no CASCADE, exact rollback)
- Also fixed: SQL injection bug in `POST /api/ci/:runId/heal` (missing `$1`)

## What Remains for Wave 5 (Enforcement)

- Flip observe-only → enforced (fail-closed on authorization decisions)
- Add full-domain integration proofs for the 11 wired-but-not-proven workers
- Auto-create system principals on first use (currently must be seeded)
- Live HTTP middleware integration tests against running Express
- Documentation reconciliation
