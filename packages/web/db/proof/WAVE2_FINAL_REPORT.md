# Wave 2 Final Local Report — Issue #94

## Status

Wave 2 runtime principal identity and scoped authorization is implemented in **observe-only mode**.

The original complete local proof package was frozen at:

```text
9d3791090ead52de4475818d45a901747becaba8
```

Independent review of PR #95 identified four correctness defects. They were fixed forward on the same branch. The corrective source-and-test delta ends at:

```text
72d0c158145809423a2de5245926ed319e0331f3
```

Documentation-only reconciliation commits follow that delta. The authoritative PR head is recorded in the PR description and GitHub metadata rather than hard-coded here, avoiding a self-referential stale SHA.

The corrective delta adds targeted unit coverage and passes repository CI, DCO, and CodeQL. The complete 19-harness disposable proof package must be rerun locally at the current PR head before merge authorization; results below distinguish original complete-proof evidence from current-head CI evidence.

## Observe-only invariant

Wave 2 records authorization decisions and authoritative attribution without globally blocking legacy operations. It does not perform enforcement cutover, legacy shutdown, centralized mutation execution, governed-policy implementation, production credential rotation, or destructive schema retirement.

## Protected surfaces

```text
Non-HTTP declared:           22 / 22
Non-HTTP wired:              22 / 22
Non-HTTP adoption-proven:    22 / 22
Non-HTTP integration-proven:  6 / 22
HTTP protected routes:       22 / 22
```

The 22 non-HTTP surfaces are not claimed as 22 full vertical integrations. Six have deep end-to-end integration proofs; the remaining surfaces have executable adoption-completeness evidence.

## Writer attribution

```text
Canonical writer boundaries: 5 / 5
Writer callers attributed:   42 / 42
Positive attribution gaps:    0
```

Guarded tables:

- `decision_log`
- `audit_trail_entries`
- `repair_proposals`
- `repair_proposal_events`
- `managed_actions`

## Migrations

- `041_wave2_runtime_identity.sql`
- `042_attribution_gap_evidence.sql`

Both are additive. The disposable proof package covers apply, rerun, collision handling, privilege boundaries, rollback, ledger removal, reapply, and schema/grant equivalence. Rollbacks contain no `CASCADE`.

## Independent review corrections

PR #95 review findings fixed forward:

1. Bootstrap now calls `complete_bootstrap()` under transaction-local `SESSION AUTHORIZATION gitwire_app`, matching the database function's `session_user` contract while restoring the pooled connection identity automatically at transaction end.
2. Session validity is bound to the presented token's derived `session_hash` and, when available, the Redis `sessionId`; a token cannot borrow another session's validity.
3. CI-heal resolves `runId` through trusted `ci_runs -> repositories` state before authorization.
4. Repository-targeted installation routes resolve an exact server-owned installation ID. Aggregate routes are explicitly fleet-scoped. Unresolved installation resources fail closed as `resource_unknown`.

Targeted correction tests cover all four findings.

## Validation evidence

### Complete local package at `9d379109...`

```text
Wave 2 unit tests:       79 / 79
Rules tests:            251 / 251
Runtime tests:           16 / 16
Disposable harnesses:    19 / 19
Disposable assertions:  622
HTTP gate:               exit 0
Secret scan:             clean
Docker build/health:     green
Cumulative local review: no blocking findings
```

### Corrective source/test head `72d0c158...`

```text
Repository CI:             success
DCO:                       success
CodeQL:                    success
Web unit suites:           118 / 118
Web unit assertions:       3165 / 3165
Targeted correction tests: 7 / 7
Docker app build/health CI: success
Release tooling validation: success
```

The complete 19-harness disposable package has not yet been rerun at the current PR head; do not describe that head as final-proof complete until the rerun is recorded.

## Tier 3 disposition

Forty-five server-backed suites are not selected by current CI policy and were not run. They require a deployed test environment, external fixtures, and in some cases real GitHub operations. They are not described as passed.

## Production exclusions

```text
No authorization enforcement transition
No legacy API-key shutdown
No session cutover
No direct-writer shutdown
No credential rotation
No bootstrap recovery
No destructive migration
No actor-column removal
```

## Delivery disposition

```text
PR:                         #95
Independent diff review:    corrective delta pending rereview
Merge:                      not authorized
Deployment:                 not authorized
Production access:          not authorized
Enforcement transition:     not authorized
```
