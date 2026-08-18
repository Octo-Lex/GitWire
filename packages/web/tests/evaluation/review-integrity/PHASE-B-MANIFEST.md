# Phase B Run Manifest — Attempt-3 Candidate Freeze (v6): RI-5 Falsification Correction

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v6 supersedes v5 (PR #162).
It freezes the attempt-3 candidate after the programme owner selected the
review-mechanism correction (PR #160 review 4959172520). The 24-invocation
matrix requires a **fresh quota authorization** (§4); none is carried from
any prior attempt.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `7152a551e81980d4a274e441402a78d8a2125211` (integration PR #164, **unmerged**) |
| Candidate tree | `f6d11629ac9e61a70cf1a5d4ce21a7d1652d9c43` = tree of `review-integrity-v2@9669f6b` (identical tree object; empty diff) |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Exact-head CI | Dispatched run 32121646327 at `9669f6b`: every job green. PR run 32121746102 at `7152a55`: every job green, plus CodeQL and DCO |
| Local profile | web unit 173 suites / 3879 passed + 1 skipped; evaluation 146; integration 20; core 61; rules 251; runtime 16; executor 128; dashboard 67 |

## 2. The correction this candidate carries (RI-5 falsification contract)

Implemented as PR #163, zero provider calls, from the ruling of review
4959172520. The independent verifier's contract is now a two-phase
falsification protocol:

- **Phase 1 — enumerate.** Correctness-material risk obligations across six
  generic categories: changed behavior; dependency/interface contracts;
  state/side effects; config/runtime assumptions; normative docs/tests;
  counterexamples. An empty category requires a specific noneJustification.
- **Phase 2 — resolve.** Every obligation resolves as `evidence_cleared`
  (citing the repository evidence examined), `material_finding` (pointing at
  a finding that survives the evidence-bound validator), or `unresolved`
  (stating why — fails closed).
- **`verified` is computed from the ledger, never declared.** A declared
  status cannot clear an unresolved obligation; structurally incomplete
  ledgers, evidence-free clearances, and out-of-bounds finding references
  all fail closed. Sixteen deterministic tests prove the gates; a
  forbidden-token test proves the prompt contains no fixture, corpus, or
  benchmark specifics.
- Prompt version `v2-verifier-r2`. Receipts persist the normalized ledger
  and unresolved obligations (additive fields).

**Unchanged:** RI-6 (sole deterministic authority — still consumes validated
findings, evidence completeness, and verifier status), RI-7, corpus,
thresholds, provider route, tool contract, mutation semantics.

## 3. Attempt-3 configuration freeze

```text
candidate:       7152a551e81980d4a274e441402a78d8a2125211
tree:            f6d11629ac9e61a70cf1a5d4ce21a7d1652d9c43
provider/route:  unchanged (Anthropic SDK; https://api.z.ai/api/anthropic)
requested model: glm-5.3   (named explicitly — the served model of both prior
                 attempts per provider-confirmed routing; 5.2/5.1 auto-route
                 to 5.3, so retired aliases are no longer requested)
runner override: ABLATION_MODEL=glm-5.3
matrix:          same 8 fixtures × 3 (24 invocations), fixture-major
order:           unchanged
prompts/tools:   primary v2-primary-r1; verifier v2-verifier-r2 (falsification);
                 gitwire-repository-tools v2
criteria:        unchanged (v4 §9 thresholds, suite-enforced)
attempt:         fresh immutable attempt directory
```

Served-model identity remains descriptive telemetry. Provider facts
(confirmed 2026-08-18, recorded on #160): supported set GLM-5.3 / GLM-5-Turbo
/ GLM-4.7 on all plans; retired 5.2/5.1 auto-route to GLM-5.3; quota
multipliers for GLM-5.3 are 6.9 input / 1.7 cached input / 24 output; the
harness's direct-SDK use of Coding Plan quota is authorized.

## 4. Quota authorization — FRESH EXPLICIT AUTHORIZATION REQUIRED

No prior authorization extends to this attempt: the configuration changed
(the verifier contract and the requested model), and the programme owner's
sequence explicitly requires requesting new authorization only after this
manifest exists.

```text
ATTEMPT_3_QUOTA_AUTHORIZATION: ____________  (client — explicit, before first call)
SIGNED:                        ____________  (client)
```

Empty fields = no provider call authorized for attempt 3.

## 5. Prior attempt record (both canonical, both failed)

| Attempt | Config | Served | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 (2026-08-18 01:30 UTC) | candidate `9586a68`, requested `glm-5.2` | GLM-5.3 (all 24) | 2/8 thresholds; 0/12 detections; 1 false APPROVE | `ri2/phase-b-attempt-1-evidence` @ `5c44192` |
| 2 (2026-08-18 02:50 UTC) | candidate `9586a68`, requested `glm-5.1` | GLM-5.3 (all 24) | 4/8 thresholds; 2/12 detections; 3 false APPROVEs | `ri2/phase-b-attempt-2-evidence` @ `91aaac2` |

Classification (review 4957135702): primary review-quality recall/capability
failure; safety consequence false-approval escape; secondary reliability/
convergence. The falsification correction targets the approval-path
reasoning contract demonstrated defective by verifier-`verified` approvals
of broken code.

## 6. Everything else (unchanged, incorporated by reference)

Runner evidence lifecycle (v4 §3), runner mechanics and --testTimeout note
(v4 §4/§5), accounting model (v4 §7, now with provider-confirmed multipliers
in §3), capture fields (v4 §8, plus the ledger fields of §2), execution
safety rules (v4 §10).

## 7. What this manifest does not authorize

Any provider call for attempt 3 (§4 empty); merging PR #164 (its approving
review is the maintainer's); any change beyond §2/§3; Phase C entry (gated
on an attempt that passes the unchanged thresholds).
