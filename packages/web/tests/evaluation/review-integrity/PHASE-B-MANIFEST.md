# Phase B Run Manifest — Attempt-2 Configuration Re-Freeze (v5)

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v5 supersedes v4 (PR #161).
It freezes attempt 2's configuration after attempt 1 failed the frozen
thresholds. The v4 quota authorization does **not** carry across the
requested-model change (§3): attempt 2 requires a new, explicit client quota
authorization.

## 1. Candidate identity (UNCHANGED from v4)

| Field | Value |
| --- | --- |
| Candidate commit | `9586a68512d8b3e072c0b47c7f1726c482a84df6` (integration PR #160, **unmerged**) |
| Candidate tree | `e6b2b53a0bf9c46b37073667750e2d6e6f79ade5` |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| CI evidence | Dispatched run 32086621509 at `644d94c` and PR run 32086678430 at `9586a68` — every job green; CodeQL and DCO green |

This is a **B1 configuration re-freeze, not a code change.** No new source
successor; the candidate tree, prompts, tool contract, corpus, criteria,
RI-6, and RI-7 are byte-identical to attempt 1's.

## 2. Attempt-1 record (authoritative first attempt)

Executed 2026-08-18 01:30–02:10 UTC against this exact candidate. Canonical
evidence: branch `ri2/phase-b-attempt-1-evidence`, commit
`5c441921f5d96ab39ddc797f781e05b13ff79c45` (24 immutable records, aggregate,
execution log, `EXECUTION.md` with environment, exact command, and per-file
SHA-256 hashes). Pointer recorded on PR #160.

Outcome: 2/8 frozen thresholds passed. 0/12 broken-fixture expected-defect
detections; RI-04 broken run 3 false APPROVE (verifier verified, coverage
complete); RI-03/RI-04 fixed abstained (0/3 APPROVE). Identity telemetry:
`glm-5.2` requested → `glm-5.3` served on every invocation.

Client adjudication: **primary cause = review-quality recall/capability
failure; safety consequence = false-approval escape; secondary = excessive
abstention on clean code.** No Phase C; no rerun of the attempt-1
configuration.

## 3. Attempt-2 configuration freeze

```text
candidate:       9586a68512d8b3e072c0b47c7f1726c482a84df6   (unchanged)
tree:            e6b2b53a0bf9c46b37073667750e2d6e6f79ade5   (unchanged)
provider/route:  unchanged (Anthropic SDK; https://api.z.ai/api/anthropic)
requested model: glm-5.1
runner override: ABLATION_MODEL=glm-5.1   (the ONLY configuration delta)
matrix:          same 8 fixtures × 3 (24 invocations)
order:           unchanged (fixture-major, case-paired broken→fixed)
prompts/tools:   unchanged (v2-primary-r1 / v2-verifier-r1; repository-tools v2)
criteria:        unchanged (v4 §9 thresholds, suite-enforced)
attempt:         fresh immutable attempt directory (runs/phase-b/<new-attemptId>/)
```

**Why glm-5.1 and not the observed glm-5.3 (client's rationale):** Z.AI's
current Coding Plan documentation lists GLM-5.1, GLM-5-Turbo, GLM-4.7, and
GLM-4.5-Air as supported plan models; neither 5.2 nor 5.3 is documented.
The observed `glm-5.3` response to a `glm-5.2` request is opaque routing —
useful telemetry, not a documented configuration target. GLM-5.1 is
positioned by the provider as its high-end coding model. The smallest
controlled correction is to stop relying on opaque routing and explicitly
request a documented plan model.

Served-model identity remains descriptive telemetry: an observed ≠ requested
mismatch is recorded, never a run-validity gate.

## 4. Quota authorization — NEW EXPLICIT AUTHORIZATION REQUIRED

v4's carried-forward Max-subscription-quota authorization explicitly covered
only deltas outside provider, requested models, prompts, corpus, criteria,
RI-6, RI-7, and billing basis. **This re-freeze changes the requested model,
so that authorization does not extend to attempt 2.**

```text
ATTEMPT_2_QUOTA_AUTHORIZATION: ____________  (client — explicit, before first call)
SIGNED:                        ____________  (client)
```

Empty fields = no provider call authorized for attempt 2.

## 5. Everything else (unchanged from v4, incorporated by reference)

Runner evidence lifecycle (v4 §3: per-invocation immutable records, wx
no-overwrite, attempt isolation, fail-closed poisoning); the live runner
config mechanics (v4 §4); billable/quota accounting model (v4 §7); capture
fields (v4 §8); execution safety rules (v4 §10) — including the env-gated
refusal and the historical requirement that the harness process supply a
workable test timeout (attempt 1 used `--testTimeout=3600000` as a
process-level CLI parameter; recorded in the attempt-1 EXECUTION.md).

## 6. What this manifest does not authorize

Any provider call for attempt 2 (§4 empty); merging PR #160; any change
beyond the single configuration delta in §3; Phase C entry (gated on an
attempt that passes the unchanged thresholds).
