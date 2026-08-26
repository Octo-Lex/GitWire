# Gate C Readiness Proof — exact production mechanics (v1)

Zero-spend readiness proof for the 4k→12k per-file-cap hypothesis, executed under the Pre-Gate-C authorization. Nothing here deploys, mutates production, or calls a provider. Baseline pinned at execution start: `origin/master = 53d67c5893e864f8f13dcf0dd00e590c6542d26e`; the study branch contains master exactly.

## Method: production algorithm, not approximation

Two components replace every approximation from the earlier counterfactual:

1. **Admission** uses the real `buildFileCoverage` imported from production source (`packages/web/src/services/reviewCoverageService.js`), fed the authoritative historical inputs: the actual changed-file objects in GitHub API order, with real patch text (443/443 files, `pr-files-v1.json`, 3.6 MB committed). GitHub delivers the same patch payloads today that it delivered at review time — the files API is not versioned — and the cohort's durable coverage records confirm this below.
2. **Bundle assembly** runs a byte-exact replica of `buildReviewBundle` (`bundle-replica.mjs`) parameterized only by the per-file cap. The jest equivalence proof (`packages/web/tests/unit/gatec-readiness-equivalence.test.js`) asserts the replica produces **byte-identical bundles and identical coverageAdjustments** against the REAL production builder — imported unmodified, defaults untouched — on all 25 reviews in both context scenarios, and pins the existing 4k default behavior as a regression. 3/3 tests pass.

**Historical-context disclosure (criterion 6)**: the repository-context sections (recent issues, CI runs, prior reviews, active configuration, architecture context) are read from the database at review time and were **not durably captured** per review, so historical byte-exact replay of the full bundle is impossible. The proof instead brackets the context with two deterministic bounds: **LO** (all context queries empty — the structural minimum meta+context) and **HI** (every context section populated to its structural maximum: 5 labeled issues, 5 CI runs, 5 prior reviews, a 2,000-char PR description, a 3,000-char architecture context, one quality gate — the largest meta+context the production formatter can emit). Any historical bundle lies between these bounds; results are reported at both.

## Reconciliation against durable production records (criterion 5)

The modeled 4k scenario reproduces the durable coverage record **exactly, with zero per-review mismatches across all 25 reviews**: 124 fully reviewed files of 443, 201 `patch_truncated` instances, 118 `max_lines_exceeded` instances, 21 reviews tripping the line budget. No tuning was performed; the reconciliation is a pure consequence of real inputs + production algorithms.

## Results under exact production mechanics

| Scenario | File share | Evidence-complete | `patch_truncated` | `bundle_truncated` | Line trips | Max bundle chars |
| --- | --- | --- | --- | --- | --- | --- |
| 4k, context LO | 28.0% | 0/25 | 201 | 0 | 21 | 54,379 |
| 4k, context HI | 28.0% | 0/25 | 201 | 0 | 21 | 60,450 |
| 12k, context LO | **64.1%** | 1/25 | **41** | **0** | 21 | **89,948** |
| 12k, context HI | **64.1%** | 1/25 | **41** | **0** | 21 | **96,019** |

**The aggregate-blowout question is closed under exact framing.** The 180k rebuild path is never even triggered at 12k: the largest bundle any review can produce is 96,019 chars at the HI context maximum — 47% headroom. This is structural, not incidental: the 2,000-line admission limit caps admitted files at ~6–7 for this cohort's diff profile, and 7 × 12,000 + maximum metadata/context ≈ 96k < 180k. No `HEADER`/`META_CONTEXT` approximation determines any number above.

**The 12k projection is stable across context bounds**: identical coverage results at LO and HI (64.1% share, 41 truncations, 1 evidence-complete review, 24 INCOMPLETE with the line budget still governing in 21). The earlier approximate counterfactual's numbers are confirmed by exact mechanics.

## Suitability framing (per the authorization)

This proof does not establish that 12k is optimal. It establishes that **this single bounded intervention behaves as modeled under the production bundle algorithm, reconciles perfectly at 4k, cannot blow the aggregate budget within structural context bounds, and is technically suitable for one controlled experiment.** The two prior Track B conclusions stand unchanged: primary movement is in coverage (28%→64.1%), and INCOMPLETE rate will not normalize while the 2,000-line admission limit governs this diff profile.

## Artifacts

- `pr-files-v1.json` — authoritative inputs (25 reviews, 443 files, real patch text, GitHub API order)
- `bundle-replica.mjs` — parameterized byte-exact assembly replica + context-bound factories
- `harness-v1.mjs` + `results-v1.json` — scenarios, per-review accounting, reconciliation (re-run: `node tests/evaluation/review-quality-baseline/gatec-readiness/harness-v1.mjs`)
- `packages/web/tests/unit/gatec-readiness-equivalence.test.js` — the equivalence proof and 4k default regression (requires the committed inputs; ships with this evidence directory)
- `gatec-manifest-v1.md` — the prepared, NOT-executed experiment manifest
