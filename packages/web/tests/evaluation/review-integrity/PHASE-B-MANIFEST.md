# Phase B Run Manifest — Attempt-3 Candidate Freeze (v7): Evidence-Bound Clearances

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v7 supersedes v6 (PR #165)
after the pre-spend review of v6's candidate identified an approval-safety
defect (PR #164 review 4959646789) and the bounded correction landed
(PR #166). The 24-invocation matrix still requires a **fresh quota
authorization** (§4); nothing carries from any prior attempt.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `9c02b71c4ee89f08dd2a63c51c06c86e5ce0b9aa` (integration PR #167, **unmerged**) |
| Candidate tree | `5a866f0a493f2db6ceaf7e2e711b17b44e5b0c68` = tree of `review-integrity-v2@1ccfe44` (identical tree object; empty diff) |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Exact-head CI | Dispatched run 32124730156 at `1ccfe44`: every job green. PR run 32124814823 at `9c02b71`: every job green, plus CodeQL and DCO; review gate APPROVED |
| Local profile | web unit 173 suites / 3884 passed + 1 skipped; evaluation 146; integration 20; core 61; rules 251; runtime 16; executor 128; dashboard 67 |

v6's candidate (`7152a55`, closed PR #164) is superseded: its
`evidence_cleared` path validated references only as non-empty strings.

## 2. What this candidate carries (cumulative corrections)

**RI-5 two-phase falsification contract** (PR #163, ruling 4959172520), as
described in v6 §2: six generic risk categories; every obligation resolved
as `evidence_cleared`, `material_finding`, or `unresolved`; `verified`
computed from the ledger, never declared; unresolved obligations and
structural incompleteness fail closed; prompt `v2-verifier-r2` with
genericity enforced; receipts persist the ledger.

**Evidence-bound clearances** (PR #166, from review 4959646789): every
`evidence_cleared` obligation must cite **at least one reference that parses
and passes the RI-4 bounds validation** (`parseEvidenceRef` +
`validateEvidenceRef`) against the ReviewEvidence and the verifier's
successful broker reads — changed-path existence, side availability, and
represented patch-hunk range for `changed:` references; a matching
`file_read` context item with SHA and represented range for `repo-read:`
references. Zero valid references fails closed before any status
computation; one valid among invalid references satisfies the obligation
(the ≥1-valid rule, matching the RI-4 finding contract). Five deterministic
proofs: unparseable; nonexistent changed path; out-of-represented-range;
repo-read absent from verifier context; ≥1-valid positive control.

**Unchanged:** RI-6 (sole deterministic authority), RI-7, corpus,
thresholds, provider route, tool contract, prompt version (`v2-verifier-r2`
— its text already demanded cited evidence; the defect was enforcement).

## 3. Attempt-3 configuration freeze

```text
candidate:       9c02b71c4ee89f08dd2a63c51c06c86e5ce0b9aa
tree:            5a866f0a493f2db6ceaf7e2e711b17b44e5b0c68
provider/route:  unchanged (Anthropic SDK; https://api.z.ai/api/anthropic)
requested model: glm-5.3 (explicit; retired 5.2/5.1 aliases no longer requested)
runner override: ABLATION_MODEL=glm-5.3
matrix:          same 8 fixtures × 3 (24 invocations), fixture-major
order:           unchanged
prompts/tools:   primary v2-primary-r1; verifier v2-verifier-r2 (falsification,
                 evidence-bound); gitwire-repository-tools v2
criteria:        unchanged (v4 §9 thresholds, suite-enforced)
attempt:         fresh immutable attempt directory
```

Provider facts (confirmed 2026-08-18, recorded on #160): supported set
GLM-5.3 / GLM-5-Turbo / GLM-4.7; retired 5.2/5.1 auto-route to GLM-5.3;
GLM-5.3 quota multipliers 6.9 input / 1.7 cached / 24 output; harness
eligibility confirmed. Served-model identity remains descriptive telemetry.

## 4. Quota authorization — FRESH EXPLICIT AUTHORIZATION REQUIRED

Withheld by review 4959646789 against the v6 candidate; the corrected tree
requires its own grant. Nothing carries from attempts 1 or 2 or from any
prior configuration.

```text
ATTEMPT_3_QUOTA_AUTHORIZATION: ____________  (client — explicit, before first call)
SIGNED:                        ____________  (client — note: an eligible
                                 non-author reviewer identity, per review
                                 4959646789's repository-mechanics note)
```

Empty fields = no provider call authorized for attempt 3.

## 5. Prior attempt record (both canonical, both failed)

| Attempt | Config | Served | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 (2026-08-18 01:30 UTC) | candidate `9586a68`, requested `glm-5.2` | GLM-5.3 (all 24) | 2/8 thresholds; 0/12 detections; 1 false APPROVE | `ri2/phase-b-attempt-1-evidence` @ `5c44192` |
| 2 (2026-08-18 02:50 UTC) | candidate `9586a68`, requested `glm-5.1` | GLM-5.3 (all 24) | 4/8 thresholds; 2/12 detections; 3 false APPROVEs | `ri2/phase-b-attempt-2-evidence` @ `91aaac2` |

## 6. Everything else (unchanged, incorporated by reference)

Runner evidence lifecycle (v4 §3), runner mechanics and --testTimeout note
(v4 §4/§5), accounting model (v4 §7 with provider-confirmed multipliers in
§3), capture fields (v4 §8 plus ledger fields), execution safety rules
(v4 §10).

## 7. What this manifest does not authorize

Any provider call for attempt 3 (§4 empty); merging PR #167 (its approving
review is the maintainer's); any change beyond the corrections in §2;
Phase C entry (gated on an attempt that passes the unchanged thresholds).
