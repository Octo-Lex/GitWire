# Phase B Attempt 5 — Execution Manifest and Evidence Index

Immutable evidence for the fifth Phase B matrix execution: the GLM-5-Turbo
single-model qualification. Evidence-only branch: never merged; the
candidate tree (0d989af / f48e1f78) is untouched.

## Identity (pinned)

```yaml
attempt_id: attempt-2026-08-19T22-11-44-995Z
candidate_sha: 0d989aff96a939d2f0b6a1cf10c00ffe1ace97ae
candidate_tree: f48e1f78633d9d7a31c95220bdf3bdba2e5797d6
requested_model: glm-5-turbo
observed_model: glm-5-turbo (served as requested on all 24 invocations — identity clean)
matrix_size: 24
fixture_count: 8
runs_per_variant: 3
retries: 0
configuration_changes_during_run: 0
```

Authorization: programme-owner grant, in-session 2026-08-19, recorded on
PR #170 as comment `5348596777` before spend — manifest v9 (`6895269`)
scope: exactly one 24-invocation matrix, `glm-5-turbo` as the sole model
delta, zero retries or configuration changes, stop-for-classification on
failure. The grant is consumed by this attempt.

## Execution environment

| Field | Value |
| --- | --- |
| Host | Windows dev host, Docker Desktop (linux/amd64 daemon 27.3.1) |
| Container image | `docker.io/library/node:20` (image ID `33ed5ef90e83`, Node `v20.20.2`) |
| Preflight (asserted in-container, fail-closed) | candidate SHA equal; candidate tree equal; key present; base URL `https://api.z.ai/api/anthropic`; `ABLATION_MODEL=glm-5-turbo` — all passed (banner records sha/tree/model) |
| Command | `REVIEW_INTEGRITY_LIVE=1 NODE_ENV=test NODE_OPTIONS='--experimental-vm-modules' npx --no-install jest --config jest.config.js --runInBand --testTimeout=3600000 tests/evaluation/review-integrity/live-after.test.js` |
| Window | 2026-08-19 22:11:03 UTC → 22:49:51 UTC |
| Capacity | ZERO pre-spend aborts — all 24 invocations provider-reached with receipts; production load checked light before launch; no account-level limit engaged |
| Source locations | `C:/tmp/phase-b-records-5/` and `C:/Next-Era/GitWire/.tmp/phase-b-attempt-2026-08-19T22-11-44-995Z/` — verified byte-identical before canonicalization |

## Frozen-code per-fixture verdicts (derived from raw records)

The frozen criteria: broken fixtures require zero false APPROVEs and
detection in ≥2/3 runs; fixed fixtures require **zero false P0/P1/P2
findings and APPROVE in ≥2/3 runs** (not 3/3). RECONCILIATION.json derives
every count below directly from the raw `falseApprove`, `falsePositive`,
and `expectedDefectDetected` record fields.

| Fixture | False APPROVE | Detection | False P0/P1/P2 | APPROVE | Frozen-code verdict |
| --- | --- | --- | --- | --- | --- |
| RI-01 broken | 1/3 (run 1) | 2/3 | — | — | FAIL (false approve) |
| RI-01 fixed | — | — | **1/3 (run 2: P2 on clean code)** | 2/3 | **FAIL (false positive — the approve count 2/3 itself satisfies ≥2/3)** |
| RI-02 broken | 0/3 | 0/3 | — | — | FAIL (detection) |
| RI-02 fixed | — | — | 0/3 | 2/3 | **PASS** |
| RI-03 broken | 0/3 | 0/3 | — | — | FAIL (detection) |
| RI-03 fixed | — | — | 2/3 | 0/3 | FAIL (both criteria) |
| RI-04 broken | 2/3 (runs 1, 3) | 0/3 | — | — | FAIL (false approves) |
| RI-04 fixed | — | — | 0/3 | 1/3 | FAIL (approve count) |

Suite result: rc=1, 7 of 8 fixture tests failed. **Frozen-code fixture
passes: 1/8** (RI-02 fixed). The reconciliation correction from the
adjudication is resolved: RI-01 fixed at 2/3 APPROVEs fails on its run-2
material false positive (P2 on clean code), not on the approve count.

## Token accounting (two scopes, preserved separately — not coerced)

**Scope 1 — console `tokensUsed`** (service-level totals, 24 runs):
**429,909**. **Scope 2 — per-role execution profiles** (24 receipt-bearing
runs): input 485,300 / output 49,732 / cached 10,816 = **545,848**.
Quota units at GLM-5-Turbo multipliers (5.7 / 1.5 / 21): **3,826,806**.

## Verifier distribution and the C3-persistent finding

Verifier: `verified` = 8, `ledger_rejected` = 1, `incomplete_other` = 1,
`not_run` = 14. False-approval runs: `RI-01|broken|1`, `RI-04|broken|1`,
`RI-04|broken|3`. RI-04 broken run 3 was dissected: verifier `verified`,
zero findings, complete structurally valid handle-cleared ledger
(`changed_behavior` → `C-1, C-3` and `C-2, C-4, R-3`;
`dependency_interface_contracts` → `R-1, C-1`; `state_side_effects` →
`R-1, C-5`). Same failure layer as Attempt 4: acquisition, evidence
binding, ledger mechanics, and deterministic authorization all operated
correctly while the semantic reviewer cleared the evidence concealing a
seeded defect.

**Adjudication (client, 2026-08-20): C3 persists — semantic review
capability failure.** Five-attempt trajectory: detections 0/12 → 2/12 →
0/12 → 1/12 → 2/12; false approvals 1 → 3 → 0 → 2 → 3. GLM-5.3 and
GLM-5-Turbo, as actually served under this frozen harness, have both
failed qualification through the same semantic-reliability mechanism. The
threshold bar is NOT adjudicated as too high (zero false APPROVEs on
known-broken fixtures is a frozen safety requirement). The programme stops
at a programme-level model/provider strategy decision; GLM-4.7 remains a
possible separately authorized experiment but is no longer the
mechanically implied smallest correction. No Phase C.

## Evidence integrity (SHA-256, per file in this directory)

See `SHA256SUMS` — 28 entries covering every canonical evidence file except
the checksum file itself, including this file, `RECONCILIATION.json`, and
`execution-console.log` (force-added from the outset per the Attempt-4
`*.log` gitignore lesson).
