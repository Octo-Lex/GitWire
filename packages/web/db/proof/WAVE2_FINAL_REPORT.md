# Wave 2 Final Report — Runtime Principal Identity & Scoped Authorization

**Issue:** #94
**Branch:** `wave/2-runtime-identity-authorization`
**Base:** `fcbaace` (Wave 1 merged)
**HEAD:** `f1a8a81`
**Commits:** 45

## Summary

Wave 2 completes runtime adoption of the Level 1 authority foundation in
**observe-only mode**. Every protected surface resolves a server-owned
principal, calls the central `authorize()`, and records structured evidence.
No enforcement blocking occurs yet (that is Wave 5).

## Adoption State (3-State Gate)

| State     | Count | Meaning |
|-----------|-------|---------|
| Declared  | 22    | Surface appears in `declarations.js` |
| Wired     | 15    | Source module contains a real `adoptWorker()` call |
| Proven    | 4     | Surface has a passing disposable integration proof |

### Proven Vertical Paths (4)

| Surface         | Proof File                              | Checks |
|-----------------|-----------------------------------------|--------|
| `worker:triage`  | `run_triage_handler_pg_proof.mjs`      | 28     |
| `worker:webhook` | `run_webhook_vertical_proof.mjs`       | 36     |
| `worker:sync`    | `run_sync_vertical_proof.mjs`          | 25     |
| `telegram:fix`   | `run_telegram_bot_proof.mjs`           | 15     |

### Wired But Not Proven (11)

`worker:ciEvidence`, `worker:diagnosis`, `worker:patch`,
`worker:verification`, `worker:critic`, `worker:maintainer`,
`worker:issueFix`, `worker:phase2`, `worker:phase3`, `worker:ciHeal`,
`worker:phase4`, `telegram:heal`

### Declared But Not Wired (7)

The 5 `scheduled:*` surfaces are adopted transitively through their worker
handlers (e.g. `scheduled:sync` → `worker:sync`). `webhook:github` is adopted
via `worker:webhook`. These are not separate entry points.

## Test Results

### Unit Tests
- Wave 2 unit tests: **73/73** (7 suites)
- Rules: **251/251**
- Runtime: **16/16**
- Web full suite: **3171 passed**, 6 skipped (45 suites fail pre-existing
  due to missing `GITWIRE_BASE_URL` for integration/e2e tests — not caused
  by Wave 2)

### Disposable Proofs (9 harnesses, 239 total checks)
- Triage handler: 28/28 ✓
- Webhook vertical: 36/36 ✓
- Sync vertical: 25/25 ✓
- Telegram bot: 15/15 ✓
- Positive attribution: 27/27 ✓
- Attribution guard: 30/30 ✓
- Transaction boundary: 15/15 ✓
- Migration 042: 24/24 ✓
- Full migration 001-042: 39/39 ✓

All proofs exit 0 with natural termination (no `process.exit(0)`).

## Key Deliverables

1. **Central `authorize()`** — evaluates principal + permission + resource,
   records to `auth_decision_log`
2. **`authContext` middleware** — resolves `req.auth` from Bearer/session/legacy-key
3. **`routeAuthObserver`** — declaration-driven, matches method+path, calls
   `authorize()` once per request
4. **`adoptWorker()`** — resolves trusted principal at worker entry points
5. **`validateAttribution()`** — centralized guard at 5 writer boundaries
6. **Bootstrap endpoint** — `POST /api/bootstrap/first` (enforced immediately)
7. **Dual-write attribution** — `principal_id` on all 5 writer tables
8. **Attribution gap evidence** — savepoint-safe gap recording (migration 042)
9. **Legacy-key adapter** — maps shared API keys to principals
10. **Resource resolver** — trusted DB lookup (not from payload)

## Security Constraints Honored

- ✅ Observe-only mode (no enforcement blocking)
- ✅ No push, PR, GitHub mutation, deployment, or production access
- ✅ No raw secrets in SQL/logs/evidence
- ✅ DCO sign-off on all commits
- ✅ No Co-Authored-By
- ✅ All proofs use disposable PG+Redis containers (cleaned up after)
- ✅ Natural process termination (no forced exit)

## Schema Changes

- **Migration 041:** `legacy_key_mappings`, `auth_decision_log`,
  dual-write `principal_id` columns on 5 tables
- **Migration 042:** `attribution_gap_evidence` (append-only, with grants
  and triggers)
- **Rollback scripts:** `rollback_wave2.sql`, `rollback_wave2_042.sql`
  (no CASCADE, exact rollback)

## What Remains for Wave 5 (Enforcement)

- Flip observe-only → enforced (fail-closed on authorization decisions)
- Add integration proofs for the 11 wired-but-not-proven surfaces
- Live HTTP middleware integration tests against running Express
- Documentation reconciliation
