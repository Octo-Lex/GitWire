# ADR 0003: Evaluation and deny semantics

> **Scope marker.** Records how an authorization request is evaluated
> and how denials are expressed. Part of the Level 1 authority
> architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/permission-model.md`](../authority/permission-model.md) §6
"Evaluation algebra" and §7 "Default-deny and explicit-deny semantics".

## Context

The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records inconsistent denial behavior across routes: some return 404
(hiding existence), some return 403 with varying bodies, some silently
return empty results (F-09). A deterministic evaluation order and a
stable denial vocabulary are required for audit, testing, and a
consistent external contract.

## Decision

### Evaluation algorithm

Authorization is evaluated in five deterministic steps
(permission-model.md §6, :319-891):

1. **Authenticate** the principal. Failure → `no_authenticated_principal`.
2. **Derive tenant scope** — tri-state per dimension
   (`ALL | NONE | SET(ids)`), default `NONE` (permission-model.md:719-726).
3. **Install the data-access boundary** — the query gateway receives
   the full scope (see ADR-0001, ADR-0004).
4. **Evaluate the operation policy expression tree** — `all_of` /
   `any_of` over concrete `<resource_type>:<action>` leaves
   (permission-model.md:349, 372).
5. **Issue a decision** with a unique `decision_id`
   (permission-model.md:866-887).

### Default deny

The default-deny reason is the **single** canonical code
`resource_grant_missing` (permission-model.md:897-898).
`no_matching_allow` is **not** used. Authentication alone is necessary
but not sufficient — being authenticated does not confer any authority
(permission-model.md:908-910).

### Explicit deny precedence

- An explicit deny grant overrides any allow from role, credential, or
  resource grant (permission-model.md:899-901).
- Evaluation order: explicit deny is checked inside `evaluate_leaf`,
  **after** the role permission check and **before** the credential
  scope check (permission-model.md:902-904).
- Deny specificity: a deny on a specific resource overrides an allow on
  a parent; an allow on a specific resource does **not** override a
  deny on a parent (permission-model.md:905-907).

### Truth table

The scope-product algebra is normatively specified as 18 rows (T1–T18)
with seven enforced invariants (permission-model.md §6 truth table,
:728-801): co-dimension narrowing is unconditional; empty intersection
denies; fleet collapse; system is orthogonal; repository roles do not
grant installation authority; mixed roles union correctly;
survivor-based co-dimension narrowing.

### Denial reason codes

There are exactly **25 denial reason codes**
(permission-model.md §12, :1273-1302), including
`no_authenticated_principal`, `no_installation_scope`,
`resource_not_found`, `no_active_role`, `role_permission_missing`,
`explicit_deny`, `credential_scope_denied`,
`credential_resource_restricted`, `wrong_environment`, `expired`,
`resource_grant_missing`, `operation_policy_denied`,
`reauthorization_failed`, plus `attestation_*` and `capability_*`
codes.

### External denial shape

All denials return `403 Forbidden` with body
`{"error": "insufficient_permissions"}` (permission-model.md:1306-1308).
Detailed reason codes appear only in internal audit events, never in
external responses.

## Rationale

1. **Determinism.** A fixed evaluation order makes the outcome of any
   (principal, operation, resource) triple reproducible — required for
   the negative-test matrix (ADR-0006's rejection contract and the
   wave-validation-plan).
2. **One default code.** A single `resource_grant_missing` default
   prevents information leakage through varied denial messages while
   keeping audit granular via the 25 internal codes.
3. **Deny wins, narrowly.** Explicit-deny precedence with the stated
   specificity rules lets a deployment lock down a subtree without
   accidentally locking its parent, and prevents an allow on a child
   from escaping a deny on a parent.
4. **Stable external contract.** One external shape (`403` +
   `insufficient_permissions`) means clients cannot infer existence or
   reason from response variation.

## Non-goals

- This ADR does not specify the SQL DDL backing these semantics. The
  evaluator is application code; the schema constraints are an
  implementation target owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify job-authorization capability denial codes
  (`capability_*`). The capability-token mechanism is superseded for
  the Level 1 closure of F-06 — see ADR-0006.
- This ADR does not specify the tenant-scope dimensions or inheritance
  — see ADR-0004.

## Acceptance criteria

An implementation conforms to this ADR when:

- Every decision follows the five-step algorithm in order.
- The default denial code is `resource_grant_missing`.
- Explicit deny overrides allow per the specificity rules.
- Exactly the 25 enumerated denial codes are emitted internally.
- Every external denial is `403` + `{"error":"insufficient_permissions"}`.
- The truth-table invariants hold for every (principal, operation,
  resource) triple.

## Cross-references

- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §6, §7, §12
- Related: [ADR-0001](./0001-authority-source-of-truth.md) (where decisions live),
  [ADR-0002](./0002-principal-resource-action-model.md) (vocabulary),
  [ADR-0004](./0004-tenancy-and-resource-inheritance.md) (scope dimensions),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (JTI/capability supersession for Level 1)
