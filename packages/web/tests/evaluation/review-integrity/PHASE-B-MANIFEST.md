# Phase B Run Manifest — Frozen Paid Quality Baseline (v3)

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** v3 supersedes v2 (PR #155)
after the client's second pre-spend review and the telemetry correction (PR
#156). It pins the post-telemetry candidate tree and replaces every numeric
"bound" claim with the accounting model the code actually enforces. The first
provider call still requires explicit spend authorization plus a client-set
monetary ceiling (§10). No paid call has occurred.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `63f70aa7a2723b0b78956dfb03319b4dbe1c9f89` (integration PR #157, **unmerged**, byte-identical successor of `3a8ce38`) |
| Candidate tree | `ed96ae95e0b79684f26fea6232a54d532bf2272c2` = tree of `review-integrity-v2@3a8ce38` (identical tree object; empty diff) |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Exact-head CI | Dispatched run 32041971489 at `3a8ce38`: every job green. PR run 32042043535 at `63f70aa`: every job green (incl. production-dependency-audit), plus CodeQL and DCO green |
| Local profile | web unit 171 suites / 3854 passed + 1 skipped; eval 146; integration 20; core 61; rules 251; runtime 16; executor 128; dashboard 67 |
| PR state | `MERGEABLE`; merge gated only by the repository's required approving review (maintainer decision) |
| Commit signature | Cryptographically unsigned; `Signed-off-by` trailer present (metadata, not an exit criterion) |

v2's candidate (`25372fd`, PR #153) is superseded: its tree lacked the
telemetry corrections this manifest's accounting depends on.

## 2. The live runner (as it actually executes)

Executed through `tests/evaluation/review-integrity/live-after.test.js` —
the real `reviewPR()` pipeline, `review_integrity_v2: "live"`, frozen
`BASE_CONFIG` (verbatim in v2 §2; unchanged): requested model
`process.env.ABLATION_MODEL || "glm-5.2"` (override NOT set for Phase B),
adversarial enabled by omission, `max_duration_seconds: 300`.

**Runner semantics correction (landed in the candidate):** observed/requested
model mismatch is **descriptive telemetry only** — the fields are retained in
every record but never invalidate a run. Only fixture-surface gaps invalidate.

## 3. Endpoint class and billing basis (verified where verifiable)

| Field | Value | Evidence |
| --- | --- | --- |
| Production transport | Anthropic SDK (`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`) | code |
| **Production endpoint route** | **`https://api.z.ai/api/anthropic`** | read from the production `gitwire-gitwire-app-1` container env (non-secret route; key redacted) |
| Endpoint class | Z.AI **GLM Coding Plan** Anthropic-protocol endpoint — per Z.AI docs, Coding Plan benefits are restricted to officially supported tools/products, and GitWire is **not** on the published supported-tool list | provider documentation |
| Requested identities | `glm-5.2` (primary + verifier); `claude-haiku-4-20250414` (adversarial + defense defaults) | live config + service defaults |
| Observed identities | recorded per response in execution profiles (telemetry only) | Phase 10 profiles |

**Open billing questions — client/provider to resolve before `RATE_BASIS`
can be filled:**

1. Whether this GitWire evaluation is an **authorized use** of the Coding
   Plan endpoint, and how quota/cost is accounted on that plan.
2. The rate basis for the literal `claude-haiku-4-20250414` adversarial/defense
   requests as served by this endpoint (provider-side mapping undocumented).
3. The public PAYG rates (GLM-5.2: $1.40/M input, $0.26/M cached, $4.40/M
   output) are **not** assumed to govern this endpoint class. No per-token
   pricing is transplanted.

## 4. Frozen corpus, matrix, run order (unchanged from v2)

8 fixtures (RI-01…RI-04 broken + fixed) × 3 consecutive runs, fixture-major
(case-paired broken→fixed per registry order). 24 invocations, no
whole-invocation retries, append-only records.

## 5. Conditional call graph (unchanged from v2)

primary (always) → adversarial challenge (enabled, findings > 0) → defense
pass (auto triggers) → verifier only when post-refinement primary has zero
P0/P1/P2 findings AND `approvalEvidenceComplete` (`not_run` representation).

## 6. Billable-call accounting model (corrected: no numeric hard bound is claimed)

**What the code enforces** are post-hoc, recorded-usage thresholds: each
completed response's usage is added, and only then is the threshold checked —
so the final request in a budget can overshoot it, and the thresholds stop
*subsequent* calls rather than capping the completing one. `max_tokens` caps
output only; **no code ceiling bounds request input**.

**What the telemetry now guarantees** (PR #156): usage is accumulated on
**every successful provider response before any variable is overwritten**, in
both submission paths; forced-tool fallback attempts are counted; adversarial
and defense calls return identity + usage and persist as execution profiles.
Recorded usage therefore includes every successful response. The remaining
unrecordable class: a **rejected** fallback attempt produces no response
object — if the provider bills the rejected request's input, no code can
record it (it is counted as an attempt, not tokens).

Per-invocation billable response classes (all caps are OUTPUT caps):

| # | Class | Condition | Output cap | Recorded |
| --- | --- | --- | --- | --- |
| 1 | Primary tool-use rounds (4096/round) | always | threshold 100000 (post-hoc) | yes |
| 2 | Primary submission attempt 1 | always | 8192 | **always** (post-fix) |
| 3 | Primary submission attempt 2 | narration died at cap | 16384 | yes |
| 4 | Primary tool_choice fallback | provider rejects tool_choice | duplicates 2/3 | attempt counted; rejected call's tokens unrecordable |
| 5 | Adversarial challenge | findings > 0 | 2048 | yes (profile) |
| 6 | Defense pass | auto triggers | 2048 | yes (profile) |
| 7 | Verifier tool-use rounds (4096/round) | zero material + evidence complete | threshold 50000 (post-hoc) | yes |
| 8 | Verifier submission attempt 1 | as 2 | 8192 | **always** (post-fix) |
| 9 | Verifier submission attempt 2 | as 3 | 16384 | yes |
| 10 | Verifier tool_choice fallback | as 4 | duplicates 8/9 | as 4 |

**No source-proven upper bound on total billed tokens exists.** `CEILING_USD`
is therefore a pure client spend limit, monitored against the (now complete)
recorded usage and the per-class attempt counts — not a derived number.

## 7. Capture fields (per invocation)

The live-suite record plus Phase 10 execution profiles, now including:
`executionProfiles.{primary, verifier, adversarial, defense}` (requested /
observed identity, identity source, per-category usage, fingerprint);
`submissionDiagnostics.submissionRetried` and `.forcedToolFallbackAttempts`
per role; verifier `status` with `not_run`; adversarial/defense token
contributions; plus the v1 fields (verdict/findings/expected-detection,
latency, cost, repository reads/searches/tool calls, prompt id+hash,
candidate SHA + tree OID).

## 8. Tool contract, budgets, prompts, pass criteria (unchanged)

`gitwire-repository-tools` v2; per-tool output defaults and all seven broker
ceilings; planner 45000 chars; prompts `v2-primary-r1` / `v2-verifier-r1`;
frozen broken/fixed safety-effectiveness criteria and failure-classification
rule (v2 §9 values stand).

## 9. Execution safety rules (unchanged)

Env-gated refusal pattern (`GITWIRE_AB_RUN`-style; CI can never spend), no
per-arm tuning, no new fixtures after the first call, append-only records.

## 10. Monetary ceiling — REQUIRES CLIENT DECISION

```text
CEILING_USD: ____________  (client — a spend limit, not a derived bound;
                            monitor against §6 recorded usage + attempt counts)
RATE_BASIS:  ____________  (client — must resolve §3's three open questions:
                            Coding-Plan authorized use + quota accounting,
                            haiku-identifier mapping, applicable rates)
SIGNED:      ____________  (client, before first call)
```

Empty fields = no provider call authorized.

## 11. What this manifest does not authorize

No paid provider call; no merge of PR #157 (its approving review is the
maintainer's); no execution of any kind; no corpus, prompt, RI-6, RI-7,
provider-comparison, or quality-criterion changes.
