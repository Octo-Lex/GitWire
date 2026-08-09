# Review Integrity — Current Engine Baseline (RI-1)

Recorded 2026-08-10 against production engine at `190cc59`.

## Baseline methodology

The regression harness exercises the real `reviewPR()` pipeline with a mock
Anthropic SDK that returns controlled review responses. Each broken fixture
is run with a "clean" LLM response (zero findings) to simulate the LLM
missing the defect. Each fixed fixture is also run with a clean response.

The harness does NOT test LLM intelligence — it tests whether the review
**pipeline** correctly processes what the LLM returns.

## Baseline results

### Broken fixtures (defect present, LLM misses it)

| Case | Defect | LLM returns | Engine verdict | False APPROVE? |
|---|---|---|---|---|
| RI-01 broken | Cross-file status contradiction | 0 findings (clean) | `approved` | **YES** |
| RI-02 broken | Overstated roadmap claim | 0 findings (clean) | `approved` | **YES** |
| RI-03 broken | basePath omitted from URL | 0 findings (clean) | `approved` | **YES** |
| RI-04 broken | Missing pagination in marker lookup | 0 findings (clean) | `approved` | **YES** |

**False approval rate: 4/4 (100%)** — every broken fixture is falsely approved
when the LLM misses the defect. This is the core problem the v2 implementation
must fix.

### Fixed fixtures (no defect, clean code)

| Case | LLM returns | Engine verdict | Correct? |
|---|---|---|---|
| RI-01 fixed | 0 findings (clean) | `approved` | YES |
| RI-02 fixed | 0 findings (clean) | `approved` | YES |
| RI-03 fixed | 0 findings (clean) | `approved` | YES |
| RI-04 fixed | 0 findings (clean) | `approved` | YES |

All fixed fixtures are correctly approved.

### LLM-found case (broken fixture, LLM does find the defect)

| Case | LLM returns | Engine verdict | Correct? |
|---|---|---|---|
| RI-03 broken (LLM found) | 1 P1 finding | `needs_discussion` | Partially — verdict is not `approved` (good) but should be `request_changes` for a P1 |

When the LLM does find the defect, the pipeline correctly avoids APPROVE.
This confirms the pipeline processes findings correctly — the gap is the
absence of independent verification when the LLM misses something.

## Key findings from the baseline

1. **The current engine has zero safeguards against false approvals.** When
   the LLM returns zero findings, the engine always produces `approved` with
   `high` confidence — regardless of whether the PR has a material defect.

2. **The verdict comes from `reportToLegacy`** which maps
   `"patch is correct" + 0 findings → approved/high`. There is no evidence
   check, no coverage verification, no independent review.

3. **Two inconsistent verdict algorithms exist** (`reportToLegacy` uses
   `high>=2 → request_changes`; `computeVerdict` uses `high>=3`). The
   adversarial path uses the looser threshold.

4. **The LLM-found RI-03 case produced `needs_discussion` instead of
   `request_changes`** for a P1 finding — because `reportToLegacy` requires
   `critical OR >=2 high` for `request_changes`, and a single `high` (P1)
   maps to `needs_discussion`.

5. **`fetchDiff` fetches only one page of 100 files** — PRs larger than 100
   files have remaining content silently dropped.

6. **Bundle truncation is silent** — no signal in the return value indicates
   the bundle was truncated.

## What the v2 implementation must change

The baseline proves that the current engine's `approved` verdict is
meaningless as a quality signal — it simply means "the LLM didn't find
anything." The v2 implementation must add:

- Evidence-bound findings (P0/P1/P2 require evidence references)
- Coverage accounting (every changed file accounted for)
- Independent approval verifier (separate invocation, no primary verdict)
- Deterministic decision policy (model discovers, code authorizes)
- Partial evidence forbids APPROVE (but can still REQUEST_CHANGES)

The regression corpus will grow with each new material production review miss.
