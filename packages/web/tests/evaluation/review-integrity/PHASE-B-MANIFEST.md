# Phase B Run Manifest — Frozen Paid Quality Baseline (v4)

Status: **PREPARED, QUOTA-AUTHORIZED AGAINST THIS EXACT TREE, EXECUTION NOT
STARTED.** v4 supersedes v3 (PR #158) after the runner-evidence correction
(PR #159). It pins the post-correction candidate and records the client's
carried-forward quota authorization. The 24-invocation matrix has not run.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `9586a68512d8b3e072c0b47c7f1726c482a84df6` (integration PR #160, **unmerged**, byte-identical successor of `644d94c`) |
| Candidate tree | `e6b2b53a0bf9c46b37073667750e2d6e6f79ade5` = tree of `review-integrity-v2@644d94c` (identical tree object; empty diff) |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Exact-head CI | Dispatched run 32086621509 at `644d94c`: every job green. PR run 32086678430 at `9586a68`: every job green (incl. production-dependency-audit), CodeQL and DCO green |
| Local profile | web unit 172 suites / 3862 passed + 1 skipped; eval 146; integration 20; core 61; rules 251; runtime 16; executor 128; dashboard 67 (pre-correction heads unchanged for these packages) |
| PR state | `MERGEABLE` / `CLEAN` / review-gate `APPROVED` — unmerged by instruction |
| Commit signature | Cryptographically unsigned; `Signed-off-by` trailer present (metadata, not an exit criterion) |

v3's candidate (`63f70aa`, closed PR #157) is superseded: its tree predates
the runner-evidence correction required before consuming quota.

## 2. Quota authorization (recorded per client instruction, 2026-08-18)

The client's instruction, recorded verbatim in intent:

> Because this correction changes only evaluation evidence persistence — not
> provider, requested models, prompts, corpus, quality criteria, RI-6, RI-7,
> or billing basis — the existing authorization to consume the Max
> subscription quota can be recorded against the new exact candidate without
> requesting new commercial authorization.

```text
QUOTA_BASIS:     Z.AI Max subscription quota (client-held plan)
AUTHORIZATION:   Carried forward to candidate 9586a68 / tree e6b2b53a per the
                 client's 2026-08-18 instruction (persistence-only delta from
                 the authorized tree; no covered dimension changed)
PER-TOKEN CEILING: Not applicable under subscription quota; §6's accounting
                 model governs telemetry and quota-consumption monitoring
SIGNED:          Recorded by client direction 2026-08-18 (this section)
```

Endpoint facts (verified 2026-08-17, unchanged): transport Anthropic SDK;
production route `https://api.z.ai/api/anthropic`; requested identities
`glm-5.2` (primary + verifier) and `claude-haiku-4-20250414` (adversarial +
defense); observed identities recorded per response as telemetry.

## 3. Runner evidence lifecycle (new in v4 — the correction this candidate carries)

Every **completed** invocation immediately writes its own immutable record
before another paid invocation can run (`liveEvidenceStore.js`, wired into
`live-after.test.js`, proven by 8 deterministic tests):

- **Path**: `runs/phase-b/<attemptId>/<sha12>-<fixture>-<variant>-run<N>.json`
- **Immutability**: created with the `wx` flag — existing records can never be
  overwritten; a same-identity collision is an error. One attempt directory
  per suite execution, so a matrix re-run never collides.
- **Contents**: candidate SHA + tree; fixture/variant/run; the full run record
  (verdict, check state, findings, model telemetry, tokens, latency,
  detection/false-positive fields); the sanitized execution profiles and
  retrieval/budget evidence from `v2Capture.manifest`; the verifier receipt;
  the decision reason.
- **Fail-closed**: any persistence failure poisons the store —
  `assertEvidenceWritable()` refuses every further paid invocation, and
  poisoned writes fail even to valid paths.
- **Scorecard safety**: records sit two levels below `runs/` with
  `kind: "phase-b-invocation"`; the runtime scorecard's `phase9-*` scan never
  consumes them.

## 4. The live runner (unchanged from v3)

`live-after.test.js`, real `reviewPR()` pipeline, `review_integrity_v2:
"live"`, frozen `BASE_CONFIG` (v2 §2 verbatim): requested model
`process.env.ABLATION_MODEL || "glm-5.2"` (override NOT set), adversarial
enabled by omission, `max_duration_seconds: 300`. Model identity is
descriptive telemetry — mismatch never invalidates a run; only
fixture-surface gaps do.

## 5. Frozen corpus, matrix, run order (unchanged)

8 fixtures (RI-01…RI-04 broken + fixed) × 3 consecutive runs, fixture-major
(case-paired broken→fixed per registry order). 24 invocations, no
whole-invocation retries, append-only records (now per-invocation immutable,
§3).

## 6. Conditional call graph (unchanged)

primary (always) → adversarial challenge (enabled, findings > 0) → defense
pass (auto triggers) → verifier only when post-refinement primary has zero
P0/P1/P2 findings AND `approvalEvidenceComplete` (`not_run` representation).

## 7. Billable/quota-consumption accounting model (unchanged from v3)

No numeric hard bound is claimed. Thresholds (100000 / 50000) are post-hoc
recorded-usage enforcement; `max_tokens` caps output only; no code ceiling
bounds inputs. Recorded usage includes **every successful response**
(telemetry correction); rejected tool_choice fallback attempts are counted
but produce no token record. The 10-class table in v3 §6 stands. Under
subscription quota this model monitors quota consumption rather than USD.

## 8. Capture fields (per invocation — now natively persisted, §3)

`executionProfiles.{primary, verifier, adversarial, defense}`;
`submissionDiagnostics.submissionRetried` and `.forcedToolFallbackAttempts`
per role; verifier `status` with `not_run`; verdict/findings/
expected-detection; latency; token categories; repository reads/searches/
tool calls; prompt id+hash; requested/observed identity; candidate SHA +
tree; decision reason.

## 9. Tool contract, budgets, prompts, pass criteria (unchanged)

`gitwire-repository-tools` v2; per-tool output defaults and all seven broker
ceilings; planner 45000 chars; prompts `v2-primary-r1` / `v2-verifier-r1`;
frozen broken/fixed safety-effectiveness criteria and the
failure-classification rule (v2 §9 stands).

**Frozen pass thresholds.** Each broken fixture: false APPROVE 0/3; expected
material defect detected in ≥2/3; the remaining run detects OR
abstains/is-incomplete, never falsely approves. Each fixed fixture: false
P0/P1/P2 0/3; APPROVE ≥2/3. A failure stops the programme for classification;
a pass advances to Phase C clean-room golden journeys.

## 10. Execution safety rules (unchanged)

Env-gated refusal (`REVIEW_INTEGRITY_LIVE=1` + credentials; CI can never
spend), no per-arm tuning, no new fixtures after the first call, append-only
records, fail-closed evidence persistence (§3).

## 11. What this manifest does not authorize

Merging PR #160 (its approval notwithstanding — merge is a separate decision);
any change to provider, requested models, prompts, corpus, quality criteria,
RI-6, RI-7, or the recorded quota basis; any execution beyond the frozen
24-invocation matrix defined here.
