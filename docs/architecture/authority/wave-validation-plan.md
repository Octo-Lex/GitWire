# Wave Validation Plan

> **Scope marker.** Defect-sensitive validation plan for Waves 1–4 of
> the Level 1 authority rollout. This is a **documentation-only**
> specification: fixtures, expected results, and rejection contracts.
> It does **not** include executable migrations, DB smoke tests, or
> runtime test harnesses — those are owned by
> [issue #81](https://github.com/Octo-Lex/GitWire/issues/81) and the
> post-Wave-0 implementation waves. Wave 0 may add documentation-only
> validation manifests or pure inventory tooling, but must not
> introduce runtime authorization behavior.

## Purpose

This plan defines the validation that later waves must perform to prove
the Level 1 authority architecture is correctly implemented. It is
organized around the inventory findings (F-01..F-15) recorded in
[`./current-state-inventory.md`](./current-state-inventory.md), the
test matrix in [`./level-1-core.md`](./level-1-core.md) §15, and the
binding decisions in [`../adr/`](../adr/) ADR-0001..0008.

Every entry names a defect or invariant and the expected observable
result. Where the expected result depends on database rejection, the
contract appears in
[Expected database rejection contract](#expected-database-rejection-contract)
below; exact SQLSTATE values are stated only where the accepted
architecture explicitly assigns one.

## Permission matrix fixtures (positive and negative)

Reference: ADR-0002 (vocabulary), ADR-0003 (algorithm),
[`./level-1-core.md`](./level-1-core.md) §15.

| Fixture | Expected result | Defect / invariant closed |
|---------|-----------------|---------------------------|
| Principal with `read` on `repair_proposal` reads one | allow | positive baseline |
| Principal with `read` on `repair_proposal` lists them | deny `resource_grant_missing` | `read` ≠ `list` (ADR-0002) |
| Principal with no matching allow calls any endpoint | deny `resource_grant_missing` | default deny (ADR-0003) |
| Principal with `github:read` attempts a GitHub write | deny `role_permission_missing` | `github:read` ≠ `github:act` (ADR-0002) |
| `legacy-key` principal attempts `manage` | deny `role_permission_missing` | narrow bridge (ADR-0007) |
| `legacy-key` principal with no explicit scope | deny `unmapped_legacy_key` | no fleet default (ADR-0007) |

## Cross-tenant and resource-isolation tests

Reference: ADR-0004, F-02, F-09.

| Fixture | Expected result | Defect closed |
|---------|-----------------|---------------|
| Principal scoped to installation A lists installation B's resources | empty result set | F-09 |
| Principal scoped to repo R1 reads repo R2 in same installation | deny `credential_scope_denied` | F-02 / F-09 |
| Route forgets to request tenant filtering | empty result set (fail-closed) | F-09 fail-closed |
| Worker payload claims installation B; delegation is installation A | out-of-scope reads return empty | F-06 (payload = claim, not authority) |
| Identity-scoped resource accessed via installation grant | deny `resource_grant_missing` | no cross-category inheritance (ADR-0004) |

## Default-deny and explicit-deny tests

Reference: ADR-0003 truth table T1–T18
([`./permission-model.md`](./permission-model.md) §6, :728-801).

| Fixture | Expected result | Invariant |
|---------|-----------------|-----------|
| Authenticated principal, no grants | deny `resource_grant_missing` | auth necessary not sufficient |
| Explicit deny on repo R; allow on installation | deny `explicit_deny` | deny wins, narrow |
| Allow on repo R; explicit deny on installation | deny `explicit_deny` | deny on parent beats allow on child |
| Fleet scope intersected with empty installation set | deny `resource_grant_missing` | empty intersection denies |
| System-scoped grant used for installation resource | deny `resource_grant_missing` | system orthogonal to installation |

(The full 18-row truth table is normative in `permission-model.md` §6;
each row is a fixture here.)

## Confused-deputy and service-account scope tests

Reference: ADR-0006 (F-06 Level 1 closure), F-07, F-10.

| Fixture | Expected result | Defect closed |
|---------|-----------------|---------------|
| Worker receives forged payload widening scope | worker gateway scope = delegation boundary only | F-06 (Level 1 closure) |
| `/gitwire` comment command from unverified GitHub identity | deny at webhook ingress | F-07 |
| Scheduled reconciler job without explicit operation policy | deny `operation_policy_denied` | F-10 |
| Worker attempts downstream enqueue outside its ceiling | deny `role_permission_missing` on `queue_job:enqueue` | queue authority (ADR-0004) |
| Application role attempts INSERT on `execution_receipts` | reject (no INSERT grant) | ADR-0006 partitioned authority |

## Concurrent grant/revoke and stale-decision tests

Reference: ADR-0005 (`auth_epoch`, durable revocation).

| Fixture | Expected result | Invariant |
|---------|-----------------|-----------|
| Session established; principal's `auth_epoch` incremented mid-session | session denied on next request | epoch invalidation |
| Role revoked concurrently with an in-flight decision | decision reflects pre-revoke state; subsequent requests deny | durable revocation, snapshot in command |
| Credential revoked mid-request | principal derivation fails | immediate revocation |
| `transition_enforcement_state` called with caller-supplied `updated_by` | rejected; `updated_by` from `session_user` | ADR-0005 / ADR-0008 |

## Audit attribution and deterministic denial-code tests

Reference: ADR-0006, F-03, F-11, ADR-0003 (25 denial codes).

| Fixture | Expected result | Defect closed |
|---------|-----------------|---------------|
| Request supplies forged `x-actor-login` header | event `actor_principal` = authenticated principal, not header | F-03 |
| Request supplies `req.body.created_by` | event attribution ignores body field | F-03 |
| Two concurrent INSERTs race the hash chain | exactly one prev_hash links; no fork | F-11 |
| External client receives a denial | `403` + `{"error":"insufficient_permissions"}` only | stable external shape (ADR-0003) |
| Internal audit event for a denial | one of the 25 enumerated codes | denial-code closure (ADR-0003) |

## Migration and backfill invariants

Reference: ADR-0007, ADR-0005.

| Fixture | Expected result | Invariant |
|---------|-----------------|-----------|
| Apply 038/039/040 to fresh DB | additive; no existing table modified | additive-only (ADR-0007) |
| Re-apply migrations | idempotent / safe rerun | rerun safety |
| Roll back in reverse order | clean rollback | rollback sequence (ADR-0007) |
| Re-apply after rollback | succeeds | reapply |
| `transition_enforcement_state` illegal transition (e.g. `observed` → `legacy_removed`) | reject | legal-transition graph (ADR-0005) |
| Bootstrap re-enable via API route | no such route exists | ADR-0007 / ADR-0008 |

Executable apply/rerun/rollback proof is owned by issue #81. The
fixtures above are the specification #81 must satisfy.

## Static checks preventing new ungoverned mutation surfaces

Reference: source-of-truth and stress-isolation gates already in CI.

| Check | Expected result | Invariant |
|-------|-----------------|-----------|
| New route added without operation policy | CI gate fails | no ungoverned mutation surface |
| New worker added without ceiling assignment | CI gate fails | ADR-0004 queue authority |
| New GitHub mutation call outside executor | CI/static gate fails | ADR-0007 prohibited direct writes |
| New authority-sensitive file lacks CODEOWNERS owner | CI gate fails | ADR-0008 |
| Migration file added outside authorized wave | CI gate fails | ADR-0007 wave boundary |

## Expected database rejection contract

For every future executable negative test, the following five fields
are specified. An exact SQLSTATE is stated **only** where the accepted
architecture explicitly assigns one. The accepted SQL examples use
plain `RAISE EXCEPTION` without an explicit `ERRCODE`; PostgreSQL may
currently map those to `P0001`, but this plan does **not** bind that
code as a product contract. Where no SQLSTATE is architecture-bound,
the entry reads "to be frozen and proven under #81".

| Attempted operation | Expected rejection point | Required semantic rejection (stable message fragment) | SQLSTATE architecture-bound? | Owner of executable verification |
|---|---|---|---|---|
| UPDATE of `mutation_commands.auth_result_snapshot` after INSERT | `enforce_command_immutability()` BEFORE UPDATE trigger (level-1-core.md:885-934) | `mutation_commands` provenance fields are immutable | No — `RAISE EXCEPTION` without `ERRCODE` | #81 |
| UPDATE of `mutation_commands.auth_policy_version` after INSERT | same trigger | same | No | #81 |
| UPDATE of `mutation_commands.extension` after INSERT | same trigger (includes `extension`, level-1-core.md:906, 1425-1427) | `extension` is immutable after creation | No | #81 |
| DELETE on `mutation_events` | `enforce_events_append_only()` trigger (level-1-core.md:1107-1137) | `mutation_events` is append-only | No | #81 |
| UPDATE on `mutation_events` | same trigger | `mutation_events` is append-only | No | #81 |
| DELETE on `execution_receipts` | `enforce_receipts_append_only()` trigger (level-1-core.md:1107-1137) | `execution_receipts` is append-only | No | #81 |
| UPDATE on `execution_receipts` | same trigger | `execution_receipts` is append-only | No | #81 |
| INSERT of execution event by `gitwire_app` role | `enforce_event_source_partition()` BEFORE INSERT trigger (level-1-core.md:936-969) | event source not permitted for current role | No | #81 |
| INSERT of admission event by `gitwire_executor` role | same trigger | event source not permitted for current role | No | #81 |
| INSERT on `execution_receipts` by `gitwire_app` | no INSERT grant (level-1-core.md:409-427) | permission denied | No (standard Postgres `permission denied for table`) | #81 |
| `transition_enforcement_state` with caller-supplied `updated_by` | function ignores caller value; uses `session_user` (level-1-core.md:835, 849-851) | (not a rejection; an override-prevention invariant) | n/a | #81 |
| Illegal cutover transition (e.g. `observed` → `legacy_removed`) | `transition_enforcement_state()` raises (level-1-core.md:818, 822-830) | illegal enforcement-state transition | No — `RAISE EXCEPTION 'transition_enforcement_state: ...'` | #81 |
| `principal_type` violating subtype CHECK (e.g. `user` with `installation_id`) | CHECK constraint (level-1-core.md:583-600) | new row violates check constraint | No (standard Postgres `new row for relation violates check constraint`) | #81 |
| `auth_principal_roles` row with `fleet` scope and non-null `scope_id` | `chk_scope_id_null_fleet_system` (level-1-core.md:670-673) | new row violates check constraint | No (standard Postgres) | #81 |
| Duplicate idempotency key on `mutation_commands` | `ux_mutation_commands_idempotency` unique constraint (level-1-core.md:722) | duplicate key value violates unique constraint | No (standard Postgres) | #81 |

```text
SQLSTATE: to be frozen and proven under #81
Required semantic rejection: <message fragment from the accepted doc, per row above>
```

## What this plan does NOT include

- **Executable migrations.** The migration files 038/039/040 are
  specified in `level-1-core.md §12` and recorded in ADR-0007;
  applying them is #81.
- **Executable DB smoke tests.** The fixtures above name expected
  results; running them against a disposable PostgreSQL is #81.
- **Runtime test harnesses.** Any code that exercises the evaluator,
  query gateway, or triggers at runtime belongs to #81 / post-Wave-0
  waves.
- **Capability-token / JTI tests as Level 1 conformance.** The
  capability-token mechanism is superseded for the Level 1 closure of
  F-06 (ADR-0006). Tests of the capability/JTI protocol belong to a
  Level 2 conformance suite, not this Level 1 plan.

## Cross-references

- ADRs: [`../adr/0001-authority-source-of-truth.md`](../adr/0001-authority-source-of-truth.md) ..
  [`../adr/0008-production-security-authority-retained-by-humans.md`](../adr/0008-production-security-authority-retained-by-humans.md)
- Test matrix: [`./level-1-core.md`](./level-1-core.md) §15
- Finding resolutions: [`./permission-model.md`](./permission-model.md) §15
- Inventory: [`./current-state-inventory.md`](./current-state-inventory.md) (F-01..F-15)
- Executable proof owner:
  [issue #81](https://github.com/Octo-Lex/GitWire/issues/81)
