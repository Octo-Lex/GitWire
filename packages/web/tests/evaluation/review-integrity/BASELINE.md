# Review Integrity — Baselines (RI-1)

Recorded 2026-08-10 against production engine at `190cc59`.

## Two baselines

This document distinguishes two baselines that serve different purposes:

1. **Deterministic pipeline baseline** — proves the architectural defect.
   Controlled mock LLM returns zero findings; the real `reviewPR()` pipeline
   processes the response. This is what the characterization suite measures.

2. **Live current-model baseline** — the actual pre-v2 model recall, false-
   approval, false-positive, cost, and latency numbers. Requires real
   Anthropic API calls (24 runs). Not yet recorded. Will be measured after
   fixture fidelity is verified.

---

## Deterministic pipeline baseline (measured)

The characterization suite exercises the real `reviewPR()` with a mock
Anthropic SDK that returns zero findings for every fixture. This simulates
the worst case: the primary reviewer misses the defect entirely.

### Broken fixtures (defect present, LLM misses it)

| Case | Source | Defect | LLM returns | Engine verdict | False APPROVE? |
|---|---|---|---|---|---|
| RI-01 broken | AlCode PR #2 (0181b19) | Stale Phase 0 status declarations not synchronized | 0 findings | `approved` | **YES** |
| RI-02 broken | AlCode PR #2 (0181b19) | Gate 0.5 definition lacks Agent-replacement assertion | 0 findings | `approved` | **YES** |
| RI-03 broken | GitWire PR #123 (ef071ff) | basePath omitted from activation URL | 0 findings | `approved` | **YES** |
| RI-04 broken | GitWire PR #124 (624732c) | Unpaginated findCommentByMarker | 0 findings | `approved` | **YES** |

**False approval rate: 4/4 (100%).** Every broken fixture is falsely approved
when the LLM misses the defect. This is the core architectural defect: the
current engine has no safeguard against false approvals.

### Fixed fixtures (no defect, clean code)

| Case | LLM returns | Engine verdict | Correct? |
|---|---|---|---|
| RI-01 fixed | 0 findings | `approved` | YES |
| RI-02 fixed | 0 findings | `approved` | YES |
| RI-03 fixed | 0 findings | `approved` | YES |
| RI-04 fixed | 0 findings | `approved` | YES |

All fixed fixtures are correctly approved.

### What this proves

The current engine's `approved` verdict is meaningless as a quality signal.
It means only "the LLM didn't find anything." There is no evidence gate,
no coverage check, no independent verification, and no deterministic
decision policy.

---

## Live current-model baseline (GitWire-before)

Measured 2026-08-10 against the real Anthropic model (claude-sonnet-4-20250514
via Z.AI) running through the ACTUAL production `reviewPR()` pipeline — real
bundle building, real prompt, real extraction, real validation, real
`reportToLegacy` verdict mapping. Mock GitHub/DB/check surfaces only. No
external mutations.

**Method:** 8 fixtures × 3 independent runs = 24 primary-model evaluations.
Runner: `live-baseline.test.js` (opt-in: `REVIEW_INTEGRITY_LIVE=1` + API key).
Full per-run results in `live-baseline-results.json`.
Config: `adversarial_review: false` (primary-only baseline).

### Results

```
Broken fixtures: 12 evaluations (4 fixtures × 3 runs)
  False APPROVEs:               12/12 (100%)
  Correctly avoided APPROVE:    0/12 (0%)

Fixed fixtures: 12 evaluations (4 fixtures × 3 runs)
  Correctly approved:           9/12 (75%)
  False positives (P0/P1/P2):   3/12 (25%)

Avg tokens per evaluation:      447
Avg latency per evaluation:     10,669ms
```

### Per-fixture breakdown

| Fixture | Run 1 | Run 2 | Run 3 | Verdict |
|---|---|---|---|---|
| RI-01 broken | approved ✗ FALSE | approved ✗ FALSE | approved ✗ FALSE | 3/3 false approve |
| RI-01 fixed | approved ✓ | approved ✓ | approved ✓ | 3/3 correct |
| RI-02 broken | approved ✗ FALSE | approved ✗ FALSE | approved ✗ FALSE | 3/3 false approve |
| RI-02 fixed | approved ✓ | approved ✓ | approved ✓ | 3/3 correct |
| RI-03 broken | approved ✗ FALSE | approved ✗ FALSE | approved ✗ FALSE | 3/3 false approve |
| RI-03 fixed | approved ✓ FP | approved ✓ | needs_discussion FP | 2/3 false positive |
| RI-04 broken | approved ✗ FALSE | approved ✗ FALSE | approved ✗ FALSE | 3/3 false approve |
| RI-04 fixed | approved ✓ | approved ✓ FP | approved ✓ | 1/3 false positive |

### Interpretation

1. **False approval rate is 100% on broken fixtures.** The production
   `reportToLegacy()` verdict mapping approves whenever the model returns
   `overall_correctness: "patch is correct"`, regardless of whether P3
   findings exist. The model returns "patch is correct" on every broken
   fixture — the architectural defect is total, not probabilistic.

2. **Token usage is very low (avg 447).** The model produces minimal output,
   suggesting it is not deeply analyzing the diffs. This correlates with the
   universal false-approval rate.

3. **Fixed fixtures have a 25% false-positive rate.** The model sometimes
   raises P0/P1/P2 findings against clean code, though the production verdict
   mapping still marks these as `approved` when `overall_correctness` is
   `"patch is correct"`.

4. **The production verdict mapping is the primary defect.** The model's
   output often contains useful signals, but `reportToLegacy` discards them
   when `overall_correctness` is "patch is correct." This is the exact gap
   the v2 deterministic decision policy and independent verifier must close.

These numbers are the authoritative `GitWire-before` baseline. The v2
implementation (`GitWire-after`) must achieve 0 false approvals on broken
fixtures and 0 false P0/P1/P2 positives on fixed fixtures.

**Method:** 8 fixtures × 3 independent runs = 24 primary-model evaluations.
Manual and opt-in (`REVIEW_INTEGRITY_LIVE=1` + API credential). No external
mutation (mock GitHub, mock DB, real Anthropic).

**Per-run record:**
```
fixture / variant
model identifier
prompt/integrity version
verdict
findings + severities
expected defect detected?
false APPROVE?
false material finding?
input/output tokens
latency
error/timeout
```

For broken fixtures: whether the expected historical defect was detected.
For fixed fixtures: whether a P0/P1/P2 false positive occurred.

**Note:** the live baseline measures the pre-v2 engine as-is. The current
engine cannot retrieve unchanged supporting files, so if the model misses
a cross-file defect because it never saw the supporting file, that absence
is part of the baseline.

---

## Regression corpus

Each fixture is reconstructed from the exact pre-correction reviewed head
(the broken state that was falsely approved) and the exact correction that
resolved the finding thread (the fixed state).

| Case | Broken source | Fixed source | Defect class |
|---|---|---|---|
| RI-01 | AlCode PR #2 commit 0181b19 | AlCode PR #2 commit 20219bd | Stale status declarations not synchronized |
| RI-02 | AlCode PR #2 commit 0181b19 | AlCode PR #2 commit 20219bd | Gate/contract mismatch (Agent replacement) |
| RI-03 | GitWire PR #123 commit ef071ff | GitWire PR #123 commit 67908f7 | basePath omitted from URL |
| RI-04 | GitWire PR #124 commit 624732c | GitWire PR #124 commit a32a07e | Unpaginated marker lookup |

The corpus is a seed corpus. Every new material production review miss
becomes a new regression case.
