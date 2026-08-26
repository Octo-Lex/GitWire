# Readiness + Manifest Corrections (v1) — appended, v1 artifacts preserved

Two corrections issued with the Gate C1 authorization. Neither rewrites any frozen v1 artifact; both are recorded here and cross-referenced.

## Correction 1 — the readiness regression is pre-intervention evidence, not an intervention gate

`gatec-readiness-equivalence.test.js` pins the production default at **4k**: it asserts a 5,000-char patch truncates at 4k and proves replica ≡ builder at 4k. A correct Gate C intervention commit changes the default to 12k, so that specific assertion **must fail** there. The manifest's requirement that this test pass at the intervention commit was an executable contradiction.

Resolution, effective for the intervention branch:

- `gatec-readiness-equivalence.test.js` is reclassified as the **immutable pre-intervention readiness proof**. It documents the 4k world that produced the Track B baseline and the readiness reconciliation, and it must keep passing **on master and on the study branch** — wherever the 4k default still holds. It is not a gate for the intervention commit.
- The intervention branch carries a **new production regression** pinning the intended 12k default (a 5,000-char patch no longer truncates; a 13,000-char patch does), preserving the 180,000 aggregate behavior and the coverage-adjustment accounting.
- The manifest's regression-protection clause is superseded by this split; everything else in `gatec-manifest-v1.md` stands.

## Correction 2 — `contextHI()` is a deterministic stress scenario, not a structural maximum

The readiness report described the HI fixture as "the largest meta+context the production formatter can emit" and derived "47% structural headroom" and "cannot blow the aggregate" language from it. That classification was wrong: the formatter inserts issue titles, labels, CI branch names, and quality-gate names/conditions with **no length slices**, while the HI fixture chooses finite 40-char title suffixes, ~20-char branch suffixes, and a single gate. Real contexts can exceed the fixture.

What survives and what is withdrawn:

- **Withdrawn**: "largest context the formatter can emit"; "47% structural headroom"; any universal "cannot blow out" claim.
- **Retained**: the measured result — max bundle **96,019 / 180,000 chars** under the HI stress scenario; zero `bundle_truncated` at 12k in every scenario; the admission-driven argument that ~6–7 admitted files bound the diff section. All are correct as **measurements of defined scenarios**.
- **Sufficient for this experiment**: `bundle_truncated` is deterministic, observable in production coverage records, and already a manifest stop condition. No further universal bound is claimed or required.

## Where each artifact now stands

| Artifact | Status |
| --- | --- |
| `readiness-report-v1.md` | Preserved as written; Correction 2 qualifies its HI-context language |
| `gatec-manifest-v1.md` | Preserved; regression-protection clause superseded by Correction 1 |
| `gatec-readiness-equivalence.test.js` | Immutable 4k readiness proof (passes wherever the 4k default holds) |
| Intervention branch | Carries a NEW 12k default regression + aggregate/accounting regressions |
