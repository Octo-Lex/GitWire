# Phase B Run Manifest — Attempt-4 Candidate Freeze (v8): APR Correction Wave

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v8 supersedes v7 (PR #168)
after the Attempt-3 adjudication (PR #167 record, 2026-08-19) authorized the
bounded correction wave, landed as PR #169. The 24-invocation matrix requires
a **fresh explicit quota authorization** (§4); nothing carries from any prior
attempt.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `0d989aff96a939d2f0b6a1cf10c00ffe1ace97ae` (integration PR #170, **unmerged**) |
| Candidate tree | `f48e1f78633d9d7a31c95220bdf3bdba2e5797d6` = tree of `review-integrity-v2@5ad3e58` (identical tree object; empty diff) |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Exact-head CI | Dispatched run 32234483470 at `5ad3e58`: every job green. PR run 32234647644 at `0d989af`: every job green, plus CodeQL and DCO |
| Local profile | web unit 174 suites / 3892 passed + 1 skipped; evaluation 146; integration 20; core 61; rules 251; runtime 16; executor 128; dashboard 67 |

v7's candidate (`9c02b71`, closed PR #167) is superseded: its tree predates
the correction wave its own adjudication record authorized.

## 2. What this candidate carries (cumulative corrections)

**RI-5 two-phase falsification contract** (v6 §2): six generic risk
categories; every obligation resolved `evidence_cleared`,
`material_finding`, or `unresolved`; `verified` computed from the ledger,
never declared; unresolved obligations and structural incompleteness fail
closed; receipts persist the ledger.

**Evidence-bound clearances** (v7 §2, PR #166): clearances require citations
that survive deterministic RI-4 validation.

**APR correction wave** (PR #169, from the Attempt-3 adjudication):

- **A (APR-031 — Durable Operation Brackets).** A primary pre-receipt
  failure persists a terminal integrity receipt before the fail-closed
  result: the primary's `provider_error` execution profile, a sanitized
  classification (credential-shaped material redacted, length-bounded), and
  the pre-built evidence. Pre-receipt failures leave durable typed records.
- **B (APR-022 — Model-Visible Means Durably Reconstructable).** Rejected
  verifier submissions are preserved diagnostically:
  `receipt.rejectedSubmission` carries full validation errors, the submitted
  status and findings count, and a capped copy of the submitted ledger —
  none of it authoritative. The F2 forensic wall (per-reference
  sub-classification unrecoverable) closes.
- **C (APR-027 — server-minted evidence handles).** Authoritative evidence
  addressing is no longer model-generated syntax. GitWire mints `C-n`
  handles per represented changed-file interval per side (verified valid at
  mint) and `R-n` handles per successful repository read (derived from the
  actual path/SHA/range; announced as `evidenceId` in the tool result). The
  model selects handles in `resolution.evidenceHandles`; the backend
  resolves them to canonical references that the **unchanged RI-4
  validation** still checks. Raw model-written references are diagnostic
  only and can never satisfy the clearance gate. Prompt `v2-verifier-r3`.

**Unchanged:** RI-6 (sole deterministic authority), RI-7, corpus,
thresholds, provider route, requested model, tool contract.

## 3. Attempt-4 configuration freeze

```text
candidate:       0d989aff96a939d2f0b6a1cf10c00ffe1ace97ae
tree:            f48e1f78633d9d7a31c95220bdf3bdba2e5797d6
provider/route:  unchanged (Anthropic SDK; https://api.z.ai/api/anthropic)
requested model: glm-5.3 (explicit)
runner override: ABLATION_MODEL=glm-5.3
matrix:          same 8 fixtures × 3 (24 invocations), fixture-major
order:           unchanged
prompts/tools:   primary v2-primary-r1; verifier v2-verifier-r3 (falsification,
                 evidence-bound, handle-gated); gitwire-repository-tools v2
criteria:        unchanged (v4 §9 thresholds, suite-enforced)
attempt:         fresh immutable attempt directory
```

Provider facts (confirmed 2026-08-18 on #160): supported set GLM-5.3 /
GLM-5-Turbo / GLM-4.7; retired 5.2/5.1 auto-route to GLM-5.3; GLM-5.3 quota
multipliers 6.9 / 1.7 / 24; harness eligibility confirmed. Operational note
from Attempt 3: an account-level limit engaged ~12:10 UTC after a ~2.73M
quota-unit burst plus same-window production consumption, recovering ~13:13
— schedule the matrix to avoid colliding with production review load, and
expect the burst itself to approach short-window limits.

## 4. Quota authorization — FRESH EXPLICIT AUTHORIZATION REQUIRED

```text
ATTEMPT_4_QUOTA_AUTHORIZATION: ____________  (client — explicit, before first call)
SIGNED:                        ____________  (client — eligible non-author reviewer identity)
```

Empty fields = no provider call authorized for attempt 4.

## 5. Prior attempt record (all canonical, all failed)

| Attempt | Config | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `9586a68`, requested glm-5.2 → served GLM-5.3 | 2/8; 0/12 detections; 1 false APPROVE | `ri2/phase-b-attempt-1-evidence` @ `5c44192` |
| 2 | `9586a68`, requested glm-5.1 → served GLM-5.3 | 4/8; 2/12; 3 false APPROVEs | `ri2/phase-b-attempt-2-evidence` @ `91aaac2` |
| 3 | `9c02b71`, glm-5.3, falsification+evidence-bound | 0/8; 0 verifier completions; 8 ledger-rejected; 13 pre-spend aborts (account-level limit) | `ri2/phase-b-attempt-3-evidence` @ `1b5c203` |

## 6. Everything else (unchanged, incorporated by reference)

Runner evidence lifecycle (v4 §3), runner mechanics and --testTimeout note
(v4 §4/§5), accounting model (v4 §7 with provider multipliers), capture
fields (v4 §8 plus ledger, rejectedSubmission, and pre-receipt terminal
records), execution safety rules (v4 §10).

## 7. What this manifest does not authorize

Any provider call for attempt 4 (§4 empty); merging PR #170 (its approving
review is the maintainer's); any change beyond §2; Phase C entry (gated on
an attempt that passes the unchanged thresholds).
