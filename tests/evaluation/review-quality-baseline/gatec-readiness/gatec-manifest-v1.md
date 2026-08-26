# Gate C Experiment Manifest — v1 (PREPARED, NOT AUTHORIZED, NOT EXECUTED)

Status: prepared under Pre-Gate-C Readiness. Execution requires a separate explicit authorization covering the code change, the production deployment it entails, and — if the quality arm is included — the provider spend ceiling. Nothing in this manifest is authorized by its preparation.

## Hypothesis (single)

Increasing the per-file patch cap from 4,000 to 12,000 characters, while holding the aggregate bundle budget (180,000) and the line admission limit (2,000) fixed, will materially increase fully reviewed file coverage and reduce `patch_truncated`. Improved evidence visibility is expected to reduce speculative/unadjudicable findings without weakening v1.2 authority or publication invariants. (Model capability is not excluded by this hypothesis; the coverage arm is deterministic and the quality arm is the causal test of the visibility→speculation link.)

## Intervention

- `MAX_DIFF_PER_FILE`: 4,000 → 12,000 — a **source-level constant** in `packages/web/src/services/reviewBundleService.js` (verified at :21). This is a code change plus the normal production deployment path, NOT a runtime configuration mutation.
- `MAX_BUNDLE_CHARS` stays 180,000 (source constant :20). The dormant `bundle_max_chars` config column is explicitly NOT wired in this experiment (unrelated cleanup; recorded separately).
- Line limit `max_lines_to_review` stays 2,000 (per-repo config; untouched).
- No model, prompt, provider, threshold, or other configuration changes.

## Implementation baseline

- Exact master SHA pinned at execution start of Gate C itself (the readiness proof ran against `origin/master = 53d67c5893e864f8f13dcf0dd00e590c6542d26e`; the intervention commit must re-pin at its own start).
- Regression protection: `gatec-readiness-equivalence.test.js` (byte-exact replica proof + 4k default regression) and the full web unit profile must pass at the intervention commit before deployment.

## Expected effects (from the exact readiness proof, readiness-report-v1.md)

- Fully-reviewed file share on the frozen profile: 28.0% → **64.1%** (bounded: identical at structural-min and structural-max context).
- `patch_truncated` instances: 201 → **41**; reviews with any patch truncation: 25/25 → 23/25.
- Aggregate rebuild never triggers; max bundle 96,019 of 180,000 at maximum context (47% headroom; structural: ~7 admitted files × 12k + max meta/context).
- INCOMPLETE publication rate: 25/25 → **24/25** (the line budget still governs; expected and explicitly not a failure signal).

## Metrics

- **Primary**: fully-reviewed-file share; `patch_truncated` instance rate and per-review rate.
- **Secondary (coverage)**: INCOMPLETE publication rate with exact residual loss mechanisms (expect line-budget dominance).
- **Quality secondary** (only if the quality arm is authorized): validity/usefulness distribution of findings, especially NOT_ADJUDICABLE and speculative-finding rates, on a fixed evaluation cohort, adjudicated under the Track B rubric by the same procedure.

## v1.2 non-regression invariants (all must hold)

1. No clean-approve publication on incomplete evidence (INCOMPLETE downgrade path).
2. Evidence-gate behavior unchanged (validated anchors; unverified badges).
3. Advisory publication remains GitHub `COMMENT` only; no `APPROVE`/`REQUEST_CHANGES` repository authority.
4. Exactly-once publication (claim + marker + recovery) unchanged.
5. Supersession guard unchanged.
6. Deterministic regression matrix passes unchanged (22/22).

## Rollback criterion

The intervention is a single-constant source change; rollback is revert + normal deploy. Automatic trigger for rollback review: any v1.2 non-regression invariant fails in production, or the deployed review pipeline shows bundle truncation where the readiness proof predicts none (structural safety violation).

## Stop conditions

- Any non-regression invariant fails.
- `bundle_truncated` appears in production coverage records (predicted zero).
- Provider errors unrelated to the intervention (do not attribute; stop and investigate).
- Coverage metrics move opposite to prediction (share decreases or truncations increase).

## Provider-call manifest and spend ceiling

- **Deterministic coverage arm**: zero provider spend — measurable from durable coverage records alone on any post-deploy organic traffic.
- **Quality arm (optional)**: requires NEW model outputs on a fixed evaluation cohort (same PRs, same heads, reviews re-run at 12k) — estimated ≤ 25 reviews × ~16k tokens median ≈ ≤ 400k tokens. Any execution of the quality arm requires a separately bounded provider-call manifest and a fresh spend grant. NOT authorized by this document.

## Evaluation cohort

- Coverage arm: next ≥25 organic post-deploy reviews (frozen by the same selection rule as Track B v1) or the fixed cohort re-run if the quality arm is authorized.
- Quality arm: the frozen Track B 25-review cohort's exact heads re-reviewed at 12k; findings adjudicated under the frozen Track B rubric by the same adjudication procedure; comparison against the committed `adjudication-dataset-v1.json` baseline.
