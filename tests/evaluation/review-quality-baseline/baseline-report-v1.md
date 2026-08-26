# Advisory AI Review — Production Quality & Coverage Baseline (Track B, v1)

Study: v1.3 Track B. Cohort: frozen manifest v1 (`cohort-manifest-v1.json` @ `a876a4b`) — 25 organic production reviews, 2026-08-25 05:23 UTC through 2026-08-26 01:39 UTC. All numbers below are produced deterministically by `analyze-v1.mjs` from `raw-extract-v1.jsonl`, `coverage-classification-v1.json`, and `adjudication-dataset-v1.json`.

## Cohort and limitations

- 25 reviews: 16 produced under v1.2 (`386f828`), 9 under v1.2.1 (`53d67c5`); zero boundary-spanning.
- Repositories: AgentGears/AlCode 24, Octo-Lex/GitWire 1. The ≥3-repository condition is pool-conditional and not met — a recorded limitation. Findings generalize to AlCode's change profile (1.4k–4.4k-line iterative agent-runtime PRs) more than to a population.
- The PR series is an AI-driven iteration loop (several PRs titled "close … review findings"); lifecycle states are context only and were never used as proof in adjudication.

## Headline results

| Family | Result |
| --- | --- |
| Integrity | 0/25 COMPLETE — **100% INCOMPLETE publication rate** |
| Coverage | 124/443 changed files fully reviewed (**28.0%**); median review covered 6 files of ~20 |
| Finding precision | **0 VALID**, 11 PARTIAL, 27 INVALID, 25 NOT_ADJUDICABLE (63 findings) |
| Usefulness | 2 ACTIONABLE, 28 INFORMATIVE, 33 NOISE |
| Severity calibration | 39 OVERSTATED, 24 CORRECT, 0 UNDERSTATED |
| Publication integrity | 25/25 receipts reconcile 1:1 with GitHub (`COMMENTED`, exact SHA, exact marker); 0 duplicates |
| Operations | median 23.6 s and 15.9 k tokens per review; 390,785 tokens total |

## Coverage loss: the concrete per-review accounting

`patch_truncated` (the 4,000-character per-file bundle cap) is the primary mechanism, not the line budget:

- `patch_truncated`: 201 file-instances across **25/25 reviews** — including files counted as reviewed.
- `max_lines_exceeded`: 118 file-instances across 21/25 reviews.
- **4 reviews went INCOMPLETE from patch truncation alone**, never reaching the line budget.
- 0 files were `unavailable` (no binary/no-patch losses in this cohort).

## Finding quality: what the adjudication shows

Every native-HIGH finding (25) adjudicated to 4 PARTIAL, 13 INVALID, 8 NOT_ADJUDICABLE — **zero valid HIGH findings**. The only two ACTIONABLE findings (587/0 sparse-array canonicalization gap; 565/3 missing negative-path test, itself NOT_ADJUDICABLE-but-actionable-in-kind) are MEDIUM or below.

The v1.2 evidence gate is the cohort's strongest precision signal:

| Evidence status | n | PARTIAL | INVALID | NOT_ADJUDICABLE | ACTIONABLE |
| --- | --- | --- | --- | --- | --- |
| Anchor validated (`evidence_valid=true`) | 26 | 8 | 12 | 6 | 2 |
| No location (`no_location`) | 37 | 3 | 15 | 19 | 0 |

Unverified findings produced zero actionable output. Validated anchors also enabled **definitive refutation**: 12 INVALID verified-at-anchor findings were contradicted by the exact code they cited — including one fabricated runtime error (592/0: a claimed `ReferenceError` where the file contains zero bare references; adjudicated at the exact head) and one claimed missing enforcement that exists verbatim (576/0: the cross-program rejection check at `program-revision.ts:284`).

A recurring template pattern appears across receipts: speculative "memory leak", "race condition", "restart loss" claims against designs that visibly bound them (replay-window cap, in-flight dedup, generation cleanup, locked store). Several findings cite their own truncation ("not visible due to truncation", "if the onlyKeys array does not…") — a direct causal line from coverage loss to speculative findings.

## Segmentation

- **By code version**: v1.2 (16 reviews, 38 findings) 10 P / 16 I / 12 N-A; v1.2.1 (9 reviews, 25 findings) 1 P / 11 I / 13 N-A. Track A changed presentation only; the mix difference tracks the later cohort's larger diffs (median 20 files vs 17), not a code regression.
- **By diff size**: small PRs (3–15 files, 5 reviews) 4 P / 7 I / 4 N-A; large PRs (17–20 files, 20 reviews) 7 P / 20 I / 21 N-A. Larger diffs produce proportionally more unadjudicable and invalid findings, consistent with the truncation-causes-speculation mechanism.

## Ranked failure modes

1. **Coverage loss via per-file patch truncation** — 100% INCOMPLETE prevalence, 28% file coverage, present in every review, primary causal contributor to speculative findings. The aggregate "budget exceeded" shorthand was wrong in both directions: the line budget is the secondary mechanism (21/25), and 4 reviews never hit it.
2. **Finding precision** — 0/63 VALID; 43% INVALID; every INVALID HIGH either contradicted at its own anchor or pure speculation. The reviewer fabricates concrete errors under partial visibility (592/0) and reviews stale context in iteration loops (586/0 describes code the loop had already fixed).
3. **Severity inflation** — 62% of findings OVERSTATED; HIGH is the least trustworthy band.
4. **Locationless speculation** — 59% of findings carry no file anchor and produce strictly worse outcomes (0 actionable).

## Proposed Gate C hypothesis (NOT authorized — proposal only)

The evidence ranks exactly one highest-value experiment:

> **Hypothesis**: the per-file patch cap, not model capability, is the dominant driver of both INCOMPLETE publications and speculative findings.
> **Intervention class**: bundle-budget redistribution — raise `MAX_DIFF_PER_FILE` (4,000 → 12,000 chars) while holding `MAX_BUNDLE_CHARS` (180,000) constant; no model, prompt, or threshold changes.
> **Primary metric**: INCOMPLETE publication rate (baseline: 100%).
> **Secondary**: finding validity distribution (baseline: 0/11/27/25) on a frozen evaluation cohort.
> **v1.2 non-regression**: zero clean-approve on incomplete evidence; evidence-gate behavior unchanged; COMMENT-only publication; exactly-once publication.
> **Bound**: config-only change; fixed review cohort; stop on any non-regression.

This is a proposal for Gate C. It requires its own authorization, including any production configuration change (explicitly prohibited under Gate B) and any associated spend.

## Fact / judgment / inference separation

- **Fact** (durable + GitHub-verified): all coverage numbers, receipt/publication integrity, identity reconciliation, token/duration figures, and every "verified-at-anchor" refutation with its file/line evidence.
- **Human-style adjudication** (judgment): the four rubric labels per finding, with basis notes distinguishing verified refutations from judgment calls.
- **Inference** (labeled as such): the truncation→speculation causal reading and the diff-size/quality association; supported by the segments above but not individually provable per finding.

Reproduce with `node analyze-v1.mjs` in this directory. Inputs are committed alongside; no network or dates are used in computation.
