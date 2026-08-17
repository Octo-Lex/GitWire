# Phase B Run Manifest — Frozen Paid Quality Baseline (v2, corrected)

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** This version corrects the
v1 manifest (PR #154) to match the candidate's actual live execution path,
per the client review of 2026-08-17. No paid call has occurred, so the
correction contaminates nothing. The first provider call still requires
explicit spend authorization plus a client-set monetary ceiling (§10).

Every value below is pinned to the executable path at candidate tree
`3c95c935…` — the live suite and services, not function-signature defaults.

## 1. Candidate identity (frozen, unchanged)

| Field | Value |
| --- | --- |
| Candidate commit | `25372fd0992175160479bcfdfe450bd7ff3d03c8` (integration PR #153, **unmerged**) |
| Candidate tree | `3c95c9352b199df7ad36d563b0d287ef1e2c6293` — identical tree object to validated `bc02592` |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Candidate CI | PR run 32025129933 entirely green (incl. production-dependency-audit) + CodeQL; dispatched run 32022395179 entirely green |
| Commit signature | Cryptographically unsigned; `Signed-off-by` trailer present (metadata, not an exit criterion) |

## 2. The live runner (as it actually executes)

Phase B executes through `tests/evaluation/review-integrity/live-after.test.js`
("GitWire-after live matrix — runs reviewPR() with review_integrity_v2='live'"),
which drives the real `reviewPR()` production pipeline against the real
provider endpoint. Its `BASE_CONFIG` is the frozen configuration:

```js
{
  enabled: true,
  check_logic: true, check_security: true, check_architecture: true,
  check_cost_leaks: true, check_tests: true, check_docs: false,
  block_on_verdict: ["request_changes"],
  min_confidence_to_block: "medium",
  max_files_to_review: 30, max_lines_to_review: 2000,
  ignore_patterns: ["*.lock", "package-lock.json"],
  engine: "claude", model: process.env.ABLATION_MODEL || "glm-5.2",
  max_duration_seconds: 300, bundle_max_chars: 180000, require_file_scope: true,
  // adversarial_review intentionally omitted — frozen target enables it
  review_integrity_v2: "live",
}
```

### Endpoint class and requested models (pinned)

| Field | Value | Source |
| --- | --- | --- |
| Transport | Anthropic SDK (`new Anthropic({ apiKey, baseURL })`) against the provider's **Anthropic-protocol coding endpoint** — the general API vs Anthropic-protocol distinction in provider pricing applies; the exact base URL lives in deployment env, not in this repo | `aiReviewService.js` v2 section; `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL` |
| Requested model — primary | `cfg.model` = **`glm-5.2`** (override only via `ABLATION_MODEL`, which this manifest does not set) | `live-after.test.js:126` |
| Requested model — verifier | `cfg.model` = **`glm-5.2`** (same config value; `claude-sonnet-4-20250514` is only the code fallback when `cfg.model` is unset — it is NOT set here) | `aiReviewService.js` verifier call |
| Requested model — adversarial challenge | default **`claude-haiku-4-20250414`** (no `adversarial_model` in frozen config) | `adversarialReview.js:18,117` |
| Requested model — defense pass | default **`claude-haiku-4-20250414`** | `adversarialDefense.js:100` |
| Observed model | recorded per provider response; never overrides requested identity | execution profiles |

**Rate-basis consequence:** `RATE_BASIS` must be built from the provider's
published rates for the endpoint class actually used, covering BOTH requested
identifiers (`glm-5.2` and the haiku-identifier default for adversarial/defense)
as observed-served by that endpoint. The v1 manifest's premise (a Claude-model
rate basis) does not exist and is retracted.

Prompt versions (unchanged, re-verified): primary `v2-primary-r1`
(`primaryReviewService.js:28`), verifier `v2-verifier-r1`
(`approvalVerificationService.js:27`).

## 3. Frozen corpus (unchanged)

8 fixtures, RI-01…RI-04 broken + fixed, with expected findings and verdict
contracts exactly as `fixtures/registry.js` loads them (see v1 §2 / registry
for the per-case table). No new fixtures after the first paid call.

## 4. Matrix and frozen run order (corrected: the runner's own order)

24 invocations = 8 fixtures × 3 consecutive runs each. The live suite
iterates **fixture-first**: one test per fixture, `NUM_RUNS = 3` inner loop.
Combined with the registry construction (case-major, broken then fixed per
case), the executed sequence is:

```text
RI-01/broken ×3  →  RI-01/fixed ×3  →
RI-02/broken ×3  →  RI-02/fixed ×3  →
RI-03/broken ×3  →  RI-03/fixed ×3  →
RI-04/broken ×3  →  RI-04/fixed ×3
```

This fixture-major order — not the v1 run-major order — is frozen. No
whole-invocation retries: a failed invocation records its terminal state
and the matrix moves on; the matrix never re-runs an invocation.

## 5. Conditional call graph per invocation (corrected)

"One invocation = one primary + one verifier" was wrong. The live v2 call
graph is conditional at two points:

```text
primary (always)
  → adversarial challenge   (cfg.adversarial_review !== false AND primary findings > 0)
  → defense pass            (auto-mode triggers: dropped_findings, critical_downgraded, new_criticals)
  → verifier                (post-refinement primary has ZERO P0/P1/P2 findings
                             AND evidence coverage approvalEvidenceComplete)
```

- The verifier does not run on broken fixtures that correctly surface
  findings; the receipt records `status: "not_run"` (the live suite already
  represents this).
- Adversarial and defense tokens are explicitly added to the invocation
  total (`tokensUsed += challenge.tokensUsed + (defense ? defense.tokensUsed : 0)`).
- Primary failure is fail-closed: it throws before any verifier, never APPROVE.

## 6. Internal retries that ARE part of the billable path (corrected)

"No retries" applies to whole invocations only. Both the primary and the
verifier final-submission turns contain bounded protocol-level retries:

| Mechanism | Primary | Verifier | Trigger |
| --- | --- | --- | --- |
| Submission attempt 1 | `max_tokens` 8192 | 8192 | always |
| Submission attempt 2 | 16384 | 16384 | attempt 1 stops at `max_tokens` with no structured tool result, loop budget not exceeded |
| tool_choice fallback | re-call without `tool_choice` at same cap | same | provider rejects the forced `tool_choice` form |

## 7. Billable-call accounting model (replaces the false 3.6M "deterministic cap")

The 100000/50000 ceilings are **internal fail-closed thresholds computed
from recorded usage — not hard upper bounds on provider-billed tokens**, for
two source-proven reasons:

1. **The submission-retry accounting gap.** When the 16384 retry fires, the
   code overwrites the first response and calls `accumulateUsage` once, on
   the final message only (`primaryReviewService.js:547-549`,
   `approvalVerificationService.js` submission turn). The first completed
   8192-token submission response is billed by the provider but absent from
   every recorded total. Both roles have this gap.
2. **tool_choice fallback calls** duplicate a submission call shape when the
   provider rejects the forced form; a rejected attempt may still bill input.

### Every billable response class per invocation

| # | Class | Condition | Output cap | Recorded? |
| --- | --- | --- | --- | --- |
| 1 | Primary tool-use rounds (`max_tokens` 4096/round) | always | loop budget 100000 (recorded) | yes |
| 2 | Primary submission attempt 1 | always | 8192 | only if attempt 2 does NOT fire |
| 3 | Primary submission attempt 2 | narration died at cap | 16384 | yes |
| 4 | Primary tool_choice fallback | provider rejects tool_choice | duplicates 2/3 | as above |
| 5 | Adversarial challenge | findings > 0 (enabled in frozen config) | 2048 | yes (invocation total) |
| 6 | Defense pass | auto triggers | 2048 | yes (invocation total) |
| 7 | Verifier tool-use rounds (`max_tokens` 4096/round) | zero material findings + evidence complete | loop budget 50000 (recorded) | yes |
| 8 | Verifier submission attempt 1 | as 2 | 8192 | only if attempt 2 does NOT fire |
| 9 | Verifier submission attempt 2 | as 3 | 16384 | yes |
| 10 | Verifier tool_choice fallback | as 4 | duplicates 8/9 | as above |

### Derived ceilings (arithmetic, assumptions stated)

```text
Recorded-usage ceiling per invocation:
  primary 100000 + adversarial 2048 + defense 2048 + verifier 50000 = 154,096
Recorded-usage ceiling, matrix: 24 × 154,096 = 3,698,304 tokens

Pathological output-cap envelope per invocation (every class fires):
  100000 + 8192 + 16384 + (8192 + 16384) + 2048 + 2048
  + 50000 + 8192 + 16384 + (8192 + 16384) = 252,400
Pathological output-cap envelope, matrix: 24 × 252,400 = 6,057,600 tokens

Input tokens: loop-call inputs are inside the recorded budgets; the ≤6
gap/fallback calls per invocation carry inputs that no code ceiling bounds
(in practice bounded by prompt + retrieved context ≈ the 90,000-char
retrieval budget + conversation history).
```

The client ceiling should be set against the pathological envelope plus an
input allowance — not against 3.6M, which is a threshold, not a bound.

## 8. Capture fields (extended)

Per invocation, append-only, the live-suite record shape plus Phase 10
execution profiles, now including: verifier `status` with `not_run`
representation; `submissionRetried` flags per role; adversarial/defense
token contributions; per-class observed model and identity source; all §7
table classes distinguishable in the receipt. Remaining v1 fields unchanged
(verdict/findings/expected-detection, latency, token categories, cost,
repository reads/searches/tool calls, fingerprint, prompt id+hash, candidate
SHA + tree OID).

## 9. Tool contract, budgets, pass criteria (unchanged from v1)

`gitwire-repository-tools` v2; per-tool output defaults and all seven
context-broker ceilings; planner 45000 chars; frozen broken/fixed
safety-effectiveness criteria; failure-classification rule. The v1 §6, §7,
§9 values stand as written there.

## 10. Monetary ceiling — STILL REQUIRES CLIENT DECISION

```text
CEILING_USD: ____________  (client — set against §7's pathological envelope + input allowance)
RATE_BASIS:  ____________  (client — provider-published rates for the ACTUAL endpoint class,
                            covering glm-5.2 and the haiku-identifier adversarial/defense
                            requests as served)
SIGNED:      ____________  (client, before first call)
```

Empty fields = no provider call authorized.

## 11. What this manifest does not authorize

No paid provider call; no merge of PR #153; no execution of any kind; no
corpus, prompt, RI-6, RI-7, provider-comparison, or quality-criterion
changes. Preparation only.
