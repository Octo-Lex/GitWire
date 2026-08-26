# Advisory AI Review — Production Quality & Coverage Baseline (Track B, v2)

This version corrects a narrative error in v1, adds the offline counterfactual analysis, and re-presents the Gate C hypothesis with a corrected measurement hierarchy. The frozen cohort (`cohort-manifest-v1.json` @ `a876a4b`) and the adjudication labels (`adjudication-dataset-v1.json`) are unchanged. All other v1 results stand as reported.

## Correction of record (v1 errata)

V1's evidence-status table claimed validated-anchor findings contain 2 ACTIONABLE findings and locationless findings 0. The committed dataset says otherwise, and the dataset is authoritative:

| Evidence status | n | PARTIAL | INVALID | NOT_ADJUDICABLE | ACTIONABLE |
| --- | --- | --- | --- | --- | --- |
| Anchor validated (`evidence_valid=true`) | 26 | 8 | 12 | 6 | **1** (587/0) |
| No location (`no_location`) | 37 | 3 | 15 | 19 | **1** (565/3) |

The two ACTIONABLE findings are 587/0 (sparse-array canonicalization gap, anchored) and 565/3 (missing negative-path test, locationless and itself NOT_ADJUDICABLE). The v1 claims "all actionable findings were anchored" and its stronger framing of the evidence gate are withdrawn and replaced by the narrower, data-supported conclusion:

> Validated anchors make findings substantially more **adjudicable**, enrich the PARTIAL band, sharply reduce severity overstatement, and enable direct refutation at the cited code (12 verified-at-anchor refutations). They do **not** contain all actionable findings, and neither evidence group produced any fully VALID finding in this cohort.

## Offline counterfactual: 4k → 12k per-file cap (analysis only)

`counterfactual-v1.mjs` replays GitWire's exact admission and bundle logic on the frozen cohort's real patch lengths (`pr-patch-lengths-v1.json`, 443/443 files with patches from GitHub), holding the 180,000-char aggregate and the 2,000-line admission limit constant.

**Fidelity**: the modeled 4k baseline reproduces every production observable exactly — 124/443 fully reviewed files (28.0%), 201 patch-truncation instances across 25/25 reviews, 118 line-exceedance instances, 21 reviews tripping the line budget. The simulation matches reality on all five checks.

**Redistribution at 12k**:

| Measure | 4k (production) | 12k (modeled) |
| --- | --- | --- |
| Fully reviewed file share | 124/443 (28.0%) | **284/443 (64.1%)** |
| `patch_truncated` instances | 201 | **41** |
| Reviews with any patch truncation | 25/25 | 23/25 |
| `bundle_truncated` instances | 0 | 0 (aggregate never binds) |
| Reviews evidence-COMPLETE | 0 | **1** |
| Reviews INCOMPLETE | 25 | 24 |

This validates the v2 measurement critique directly: the intervention materially improves coverage — +36.1 points of file share, −160 truncation instances — while the INCOMPLETE publication rate barely moves (25 → 24), because the independent line budget still fires in 21 reviews. An experiment scored primarily on INCOMPLETE rate could succeed at its actual hypothesis and appear to fail.

## Gate C hypothesis, re-presented (PROPOSED ONLY — not authorized)

> **Hypothesis**: the per-file patch cap, not model capability, is the dominant driver of coverage loss, and coverage loss is a primary contributor to speculative findings.
> **Intervention class**: bundle-budget redistribution — `MAX_DIFF_PER_FILE` 4,000 → 12,000 with `MAX_BUNDLE_CHARS` held at 180,000 and no model, prompt, or threshold changes. Modeled expectation: file share 28% → 64%, truncation instances 201 → 41.
> **Primary metric**: fully-reviewed file share and `patch_truncated` file-instance/review rate.
> **Secondary (coverage)**: INCOMPLETE publication rate with exact residual loss mechanisms (the counterfactual predicts it stays ≥24/25 while the line limit binds).
> **Quality secondary**: finding validity/usefulness distribution, especially NOT_ADJUDICABLE and speculative-finding rates.
> **v1.2 non-regression (unchanged)**: zero clean-approve on incomplete evidence; evidence-gate behavior; COMMENT-only publication; exactly-once publication.
> **Bounds**: config-only change; fixed evaluation cohort; stop on any non-regression; any production configuration change and associated spend requires separate authorization.

The counterfactual strengthens the hypothesis (coverage moves substantially and the aggregate budget never binds, so the change is safe against bundle blowout) while honestly bounding expectations (INCOMPLETE rate will not normalize while the 2,000-line admission limit governs these diff sizes — that would be a separate, later hypothesis about the line budget itself, explicitly not bundled here).

## Unchanged from v1

Cohort definition, identity reconciliation, per-review coverage accounting, adjudication labels and all their distributions, publication-integrity results, operations figures, segmentations, and the ranked failure modes (per-file patch truncation remains #1). Reproduce with `node analyze-v1.mjs` and `node counterfactual-v1.mjs`.
