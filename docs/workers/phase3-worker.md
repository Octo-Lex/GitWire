# Phase 3 Worker

Flaky test detection, dependency scanning, and policy reconciliation.

## Queue: `phase3`

## Flaky Test Detection

1. Ingest test results from CI runs
2. Track pass/fail history per test
3. Calculate flakiness score: `fail_count / run_count`
4. If score > threshold → create `flaky_tests` record
5. Quarantine flaky tests (exclude from CI gating)

### Actions
- **Graduate**: Mark as no longer flaky after consistent passes
- **Dismiss**: Maintainer dismisses the flaky detection

## Dependency Scanning

1. Scan repository for manifest files (`package.json`, `requirements.txt`, etc.)
2. Parse dependencies and versions
3. Check against vulnerability databases (GHSA/CVE)
4. Create `vulnerability_advisories` entries
5. Optionally create batch update PRs

### Manifest Parsing

Uses GitHub Contents API to fetch files, then parses based on ecosystem:
- `npm` → `package.json`
- `pip` → `requirements.txt`, `pyproject.toml`

## Policy Reconciliation

1. Load `policy_repo_configs` for each repo
2. Compare `desired_state` vs GitHub's actual settings
3. If drift detected → update `drift_fields`
4. If `mode: enforce` → apply changes to GitHub
5. Record reconciliation run results

→ [Phase 4 Worker](/workers/phase4-worker)
