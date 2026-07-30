# Wave 2 Final Report — Runtime Principal Identity & Scoped Authorization

**Issue:** #94
**Branch:** `wave/2-runtime-identity-authorization`
**Base:** `fcbaace` (Wave 1 merged)
**HEAD:** `540a6fd`
**Commits:** 61

## Summary

Wave 2 completes runtime adoption of the Level 1 authority foundation in
**observe-only mode**. Every protected surface resolves a server-owned
principal, calls the central `authorize()`, and records structured evidence.
No enforcement blocking occurs yet (that is Wave 5).

## Adoption State (Four-State Gate with Ambiguity Detection)

| State | Count | Meaning |
|-------|-------|---------|
| Declared | 22/22 | Surface in declarations.js |
| Wired | 21/22 | adoptWorker() at entry (worker:webhook consumer NOT wired) |
| Adoption-proven | 21/22 | Dynamic entry-point principal resolution proof |
| Integration-proven | 5/22 | Full vertical proof with domain effect + gaps + negatives |

### Declared-Only (1)

`worker:webhook` — the BullMQ consumer in `webhookWorker.js` does NOT have
an `adoptWorker` call. The `webhook:github` HTTP ingress IS wired (separate
module). This is an explicit gap.

### Integration-Proven Surfaces (5 unique boundaries)

| Surface | Proof | Checks |
|---------|-------|--------|
| `worker:triage` | `run_triage_handler_pg_proof.mjs` | 28 |
| `webhook:github` | `run_webhook_vertical_proof.mjs` | 36 |
| `worker:sync` | `run_sync_vertical_proof.mjs` | 25 |
| `telegram:fix` | `run_telegram_bot_proof.mjs` | 15 |
| `telegram:heal` | `run_telegram_heal_proof.mjs` | 8 |

### Ambiguous Mappings

None (resolved). `worker:webhook` and `webhook:github` were previously
ambiguous (same module + adoption line). Investigation revealed they are
distinct boundaries in different modules. `worker:webhook` is now
correctly classified as declaredOnly.

## HTTP Route Matrix

```
Declared HTTP surfaces:    25
Tested through Express:    25
Auth observer verified:    25/25
Handler ran at path:       15/25
Handler 404 (drift):        9/25
```

### Declaration-vs-Implementation Drift (9 routes)

9 declared routes have no matching Express handler at the declared path.
The routeAuthObserver still fires for each (matching the declaration
pattern), so the auth contract is verifiable. But the handler body never
runs because Express returns 404.

This is a Wave 2 declaration accuracy issue for future correction.

## Test Results

### Tier 1: Unit Tests (GREEN)
- Wave 2 unit tests: **76/76** (7 suites)
- Rules: **251/251**
- Runtime: **16/16**

### Tier 2: Disposable Proofs (GREEN)

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
| Installation worker adoption | 44 | 0 |
| Scheduler producer adoption | 16 | 0 |
| HTTP route matrix | 178 | 0 |
| Docker build + health | 11 | 0 |

### Tier 3: Server-Backed Integration/E2E (EXISTING CI EXCLUSION)
45 suites not executed by any CI job. Classified per-suite in
`TEST_CLASSIFICATION.md` with existing CI policy authority
(`.github/workflows/ci.yml:124-157`).

### Docker Build + Health (GREEN)
- Image builds with OCI labels, correct SHA
- Health endpoint: status=ok, git_sha matches build, migrations=42
- Bug fix: CRLF entrypoint normalized to LF in Dockerfile

## Security Constraints Honored

- Observe-only mode (no enforcement blocking)
- No push, PR, GitHub mutation, deployment, or production access
- No raw secrets in SQL/logs/evidence
- DCO sign-off on all commits
- No Co-Authored-By
- All proofs use disposable containers (cleaned up)
- Natural process termination (no forced exit)
- Secret scan: CLEAN

## Known Issues

1. `worker:webhook` consumer not wired (declaredOnly)
2. 9 declared HTTP routes have path drift (auth observer fires, handler 404)
3. System principals not auto-created (must be seeded)
4. Docker entrypoint CRLF (fixed in Dockerfile, pre-existing on master)

## What Remains for Wave 5

- Flip observe-only → enforced (fail-closed)
- Wire `worker:webhook` consumer
- Fix 9 declaration path drifts
- Full-domain integration proofs for 16 adoption-proven workers
- Auto-create system principals
