# Phase B Run Manifest — Attempt-5 Candidate Freeze (v9): GLM-5-Turbo Single-Model Qualification

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v9 supersedes v8 (PR #171)
after the Attempt-4 adjudication ruled **C3 — semantic review capability
failure** (PR #170 comments `5341763710` model selection, `5341772727`
evidence-package correction). The 24-invocation matrix requires a **fresh
explicit quota authorization** (§4); nothing carries from any prior attempt.

## 1. Candidate identity (frozen — UNCHANGED from v8)

| Field | Value |
| --- | --- |
| Candidate commit | `0d989aff96a939d2f0b6a1cf10c00ffe1ace97ae` (integration PR #170, **unmerged**) |
| Candidate tree | `f48e1f78633d9d7a31c95220bdf3bdba2e5797d6` |
| Exact-head CI | Dispatched run 32234483470 at `5ad3e58` and PR run 32234647644 at `0d989af` — every job green, plus CodeQL and DCO |

The candidate is a **configuration re-freeze, not a code change**: the
mechanism is frozen per the C3 ruling (no further evidence-format or
ledger-mechanics corrections), so the tree stays byte-identical and no new
successor is required.

## 2. The sole semantic delta (client ruling `5341763710`)

```text
requested model: glm-5-turbo   (was glm-5.3)
runner override: ABLATION_MODEL=glm-5-turbo
```

Everything else is held fixed: candidate/tree, provider route, protocol,
prompts (`v2-primary-r1` / `v2-verifier-r3`), tool contract
(`gitwire-repository-tools` v2), corpus, matrix, run order, thresholds,
RI-6, RI-7, evidence lifecycle. **No model comparison, no concurrent prompt
tuning** — the next result isolates semantic capability as the independent
variable against the already-corrected harness.

Selection rationale (client, `5341763710`): Z.AI positions GLM-5-Turbo
around stronger tool invocation, complex-instruction decomposition, and
stable long-chain execution — the closest match to the demonstrated C3
failure mode in this evidence/retrieval/falsification workload. GLM-4.7 is
retained as fallback, not spent first.

## 3. Attempt-5 configuration freeze

```text
candidate:       0d989aff96a939d2f0b6a1cf10c00ffe1ace97ae   (unchanged)
tree:            f48e1f78633d9d7a31c95220bdf3bdba2e5797d6   (unchanged)
provider/route:  unchanged (Anthropic SDK; https://api.z.ai/api/anthropic)
requested model: glm-5-turbo (the ONLY delta)
runner override: ABLATION_MODEL=glm-5-turbo
matrix:          same 8 fixtures × 3 (24 invocations), fixture-major
order:           unchanged
prompts/tools:   primary v2-primary-r1; verifier v2-verifier-r3; repository-tools v2
criteria:        unchanged (v4 §9 thresholds, suite-enforced)
attempt:         fresh immutable attempt directory
```

## 4. Quota basis and authorization — FRESH EXPLICIT AUTHORIZATION REQUIRED

Model-specific accounting basis re-frozen per the provider's confirmed
multiplier table (recorded on #160): **GLM-5-Turbo = 5.7 input / 1.5 cached
input / 21 output** (vs GLM-5.3's 6.9 / 1.7 / 24 — the Turbo run consumes
less quota per token than attempts 3–4). Operational note from attempts 3–4
still applies: schedule away from production load; a full 24-invocation
burst approaches short-window limits (attempt 4's clean run consumed
5,397,063 units at 5.3 multipliers with no limit engagement).

```text
ATTEMPT_5_QUOTA_AUTHORIZATION: ____________  (client — explicit, before first call)
SIGNED:                        ____________  (client — eligible non-author reviewer identity)
```

Empty fields = no provider call authorized for attempt 5.

## 5. Prior attempt record (all canonical, all failed)

| Attempt | Config | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `9586a68`, requested glm-5.2 → served GLM-5.3 | 2/8; 0/12 detections; 1 false APPROVE | `ri2/phase-b-attempt-1-evidence` @ `5c44192` |
| 2 | `9586a68`, requested glm-5.1 → served GLM-5.3 | 4/8; 2/12; 3 false APPROVEs | `ri2/phase-b-attempt-2-evidence` @ `91aaac2` |
| 3 | `9c02b71`, glm-5.3, falsification+evidence-bound | 0/8; 0 verifier completions; 13 pre-spend aborts (account-level limit) | `ri2/phase-b-attempt-3-evidence` @ `1b5c203` |
| 4 | `0d989af`, glm-5.3, APR wave | 0/8; 2 false APPROVEs on complete valid handle-cleared ledgers; **C3 adjudicated** | `ri2/phase-b-attempt-4-evidence` @ `e4d2ad7` (head `fcbcd1f` after the `5341772727` package fix — log appended, SHA256SUMS complete; `e4d2ad7` not rewritten) |

Four-attempt trajectory under the frozen harness: detections 0/12 → 2/12 →
0/12 → 1/12; false approvals 1 → 3 → 0 → 2. Mechanism corrections are
exhausted per the C3 ruling; the model is the remaining variable.

## 6. Everything else (unchanged, incorporated by reference)

Runner evidence lifecycle (v4 §3), runner mechanics and --testTimeout note
(v4 §4/§5), accounting model (v4 §7 with the per-model multipliers in §4),
capture fields (v4 §8 plus ledger, rejectedSubmission, and pre-receipt
terminal records), execution safety rules (v4 §10).

## 7. What this manifest does not authorize

Any provider call for attempt 5 (§4 empty); merging PR #170 (its approving
review is the maintainer's); any change beyond the single §2 delta; Phase C
entry (gated on an attempt that passes the unchanged thresholds).
