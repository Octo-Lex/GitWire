# Phase B Run Manifest — Frozen Paid Quality Baseline

Status: **PREPARED, NOT AUTHORIZED TO EXECUTE.** This manifest freezes every
parameter of the Phase B quality baseline before any paid provider call. The
first provider call requires explicit spend authorization plus a client-set
monetary ceiling (§11). Preparing this artifact costs nothing and authorizes
nothing.

## 1. Candidate identity (frozen)

| Field | Value |
| --- | --- |
| Candidate commit | `25372fd0992175160479bcfdfe450bd7ff3d03c8` (integration PR #153, **unmerged**) |
| Candidate tree | `3c95c9352b199df7ad36d563b0d287ef1e2c6293` — identical tree object to validated `bc02592` |
| Master parent | `3d75dd69ee1cef58f1260682a08bf0acbfd353aa` |
| Candidate CI | PR-to-master run 32025129933 — entirely green (every job incl. production-dependency-audit) + CodeQL pass; dispatched candidate run 32022395179 — entirely green |
| Commit signature | Cryptographically unsigned; `Signed-off-by` trailer present (DCO satisfied at message level; noted, not an exit criterion) |

The evaluation MUST check out `25372fd`. Any tree whose OID is not
`3c95c9352b199df7ad36d563b0d287ef1e2c6293` is not this candidate.

## 2. Frozen corpus (8 fixtures, seed corpus)

Loaded by `fixtures/registry.js`. Expected findings are the exact historical
review-thread findings; broken variants carry `expectedVerdict: "never
APPROVE"`, fixed variants `"eligible for APPROVE"`.

| Case | Variant pair | Severity | Expected material defect | Evidence paths | Source |
| --- | --- | --- | --- | --- | --- |
| RI-01 | broken + fixed | P2 | Phase 0 status declarations contradict primary README / constitution / spec | `README.md`, `docs/constitution.md`, `docs/phase-0-spec.md` | AlCode PR #2 |
| RI-02 | broken + fixed | P2 | Gate 0.5 lacks agent-replacement assertions the roadmap requires | `docs/roadmap.md`, `docs/phase-0-spec.md` | AlCode PR #2 |
| RI-03 | broken + fixed | P1 | Activation URL missing `/dashboard` basePath | `packages/web/src/services/aiReviewService.js`, `packages/web-dashboard/next.config.ts` | GitWire PR #123 |
| RI-04 | broken + fixed | P2 | Unpaginated `findCommentByMarker` duplicates comments on high-volume issues | `packages/web/src/workers/triageWorker.js`, `packages/web/src/lib/commentMarkers.js` | GitWire PR #124 |

No new fixtures after the first paid call. The corpus is seed-only; corpus
growth is a separate decision, not a Phase B activity.

## 3. Matrix and frozen run order (24 invocations)

```text
4 broken fixtures × 3 runs  = 12
4 fixed fixtures  × 3 runs  = 12
                            24 review invocations total
```

Frozen order (deterministic, predeclared, run-major):

```text
run 1: RI-01/broken, RI-02/broken, RI-03/broken, RI-04/broken,
       RI-01/fixed,  RI-02/fixed,  RI-03/fixed,  RI-04/fixed
run 2: (same sequence)
run 3: (same sequence)
```

No retries. Records are append-only. One invocation = one primary + one
verifier execution profile (§8).

## 4. Provider and model configuration (one, frozen)

| Field | Value |
| --- | --- |
| Transport | Anthropic-compatible API via `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` (same env contract as the frozen A/B runner; production provider: Z.AI) |
| Provider identity in telemetry | endpoint hostname via `providerFromBaseURL` — descriptive only |
| Requested model (primary) | `claude-sonnet-4-20250514` (`primaryReviewService.js` default) |
| Requested model (verifier) | `claude-sonnet-4-20250514` (`approvalVerificationService.js` default) |
| Observed model | recorded per invocation from provider responses; never overrides requested identity |
| Identity classification | `requested_only` / `provider_reported` / `opaque` per `resolveIdentitySource` |
| Execution mode | v2 live path (`review_integrity_v2` live; primary + independent verifier) |

Provider/model identity is telemetry only. It never grants or removes
approval authority (RI-6 boundary; proven by noninterference tests).

## 5. Prompt versions (frozen)

| Role | Version | Source anchor |
| --- | --- | --- |
| Primary | `v2-primary-r1` | `packages/web/src/services/primaryReviewService.js:28` |
| Verifier | `v2-verifier-r1` | `packages/web/src/services/approvalVerificationService.js:27` |

Prompt content hashes are recorded per invocation in the execution profile
(`promptId`, `promptHash`).

## 6. Tool contract (frozen)

`gitwire-repository-tools` **v2** — exactly four read-only primitives
(`read`, `grep`, `find`, `ls`), typed completeness semantics
(`success`/`partial`/`error`), negative-evidence invariant (empty +
incomplete is never absence). Contract anchors:
`packages/web/src/lib/repositoryTools/contract.js`.

Per-tool output defaults:

| Tool | Defaults |
| --- | --- |
| `read` | maxBytes 65536 |
| `grep` | limit 200, maxOutputBytes 131072 |
| `find` | maxOutputBytes 131072 |
| `ls` | maxOutputBytes 131072 |

Context-broker budgets (`DEFAULT_BUDGETS`, `reviewContextBroker.js`):

| Budget | Value |
| --- | --- |
| maxFileReads | 20 / review |
| maxSearches | 6 / review |
| maxSearchResults | 10 / search |
| maxRetrievedChars | 90000 / review |
| maxContextRounds | 4 / review |
| maxBlobsScanned | 50 / search |
| maxSearchBytes | 200000 / search |

Deterministic dependency seeding planner budget:
`dependencySeedService.plannerCharBudget = 45000` chars.

## 7. Per-invocation budget profile (frozen)

| Role | Token ceiling | Submission-turn output cap |
| --- | --- | --- |
| Primary | 100000 | 8192 |
| Verifier | 50000 | 4096 |

Worst-case arithmetic (deterministic):

```text
per invocation: 100000 + 50000            = 150000 tokens (cap)
matrix total:   24 × 150000               = 3,600,000 tokens (cap)
```

Terminal states (complete / incomplete / error) and budget-exhaustion
classification follow the Phase 10 execution-profile service; budget
exhaustion is a recorded terminal outcome, never a silent retry.

## 8. Capture fields (per invocation)

One append-only record per invocation, following the established
`live-*-results.json` pattern, enriched with Phase 10 execution profiles
(`manifest.executionProfiles.{primary,verifier}`):

- completion state: complete / incomplete / error (terminal classification)
- verdict + findings; expected-finding detection (severity, title, evidence paths)
- verifier outcome: status (exactly `verified` required for APPROVE), overturn
- latency (ms); input / output / cache tokens per category; `usageSeen`
- cost, normalized per currency; no synthesized unknown categories
- repository reads / searches / tool calls (trace + counts)
- analytics fingerprint (GitWire-controlled configuration only)
- requested model, observed model, identity source
- prompt id + hash; endpoint-derived provider; budget profile
- exact candidate SHA + tree OID

## 9. Safety and effectiveness criteria (frozen pass conditions)

For **each broken fixture**:

```text
false APPROVE:               0/3
expected material defect:    detected in ≥2/3
remaining run:               detect OR abstain/incomplete
                             never falsely APPROVE
```

For **each fixed fixture**:

```text
false P0/P1/P2:              0/3
APPROVE:                     ≥2/3
```

Measured alongside, never combined into one synthetic score: completion
distribution, evidence validity, verifier outcomes, latency, token categories,
cost, repository reads/searches/tool calls, fingerprint, identity. On
failure: one classification (recall / precision / convergence / evidence
quality / budgeting / provider-protocol), then the smallest correction;
re-proof requires this same frozen matrix. No automatic tuning, no RI-6
weakening, no provider comparison, no new benchmark.

## 10. Execution safety rules

- The runner must refuse to start without an explicit opt-in env gate and
  provider credentials — mirroring the frozen A/B runner contract
  (`GITWIRE_AB_RUN=1` pattern; "CI can never spend").
- No per-arm tuning, no retries, no new fixtures after the first call.
- Every record append-only; run order predeclared (§3).

## 11. Monetary ceiling — REQUIRES CLIENT DECISION

The total monetary ceiling is the one manifest item that authorizes paid
external work and therefore belongs to the client. The deterministic
arithmetic this ceiling must cover:

```text
≤ 3,600,000 tokens at the provider's confirmed rates for the
  requested model (input / output / cache as separately priced),
  across 24 invocations, both roles, no retries
```

```text
CEILING_USD: ____________  (client)
RATE_BASIS:  ____________  (client-confirmed provider rates)
SIGNED:      ____________  (client, before first call)
```

A ceiling is frozen only when the three fields above are filled. Until then
this manifest authorizes no provider call.

## 12. What this manifest does not authorize

- No paid provider call (first call gated on §11 + explicit spend authorization).
- No merge of PR #153 (gated on separate authorization).
- No production cutover, shadow, B7, or production mutation change.
- No provider/model qualification claim; identity stays telemetry.
- No Phase B execution of any kind — preparation only.
