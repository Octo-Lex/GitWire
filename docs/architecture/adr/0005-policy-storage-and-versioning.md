# ADR 0005: Policy storage and versioning

> **Scope marker.** Records where policy data is stored, how it is
> versioned, and how authorization results are captured into commands.
> Part of the Level 1 authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §5, §6, §11, §12
and [`../authority/permission-model.md`](../authority/permission-model.md) §5, §6.

## Context

The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records that current authorization state is implicit — derived from
ad-hoc role checks scattered through code, with no durable record of
*which* policy version authorized a given mutation. Auditing a past
mutation therefore cannot reconstruct what the policy was at decision
time. Level 1 must store policy durably, version it, and capture the
authorizing decision into the mutation record itself.

## Decision

### Policy tables

Policy lives in three tables under the `gitwire_auth` schema
(level-1-core.md §11):

- **`auth_roles`** (level-1-core.md:633-645) — `name UNIQUE`,
  `is_builtin`, `status CHECK ('active','retired')`, `retired_at`.
  Built-in roles ship with the schema; custom roles are added by
  operators.
- **`auth_role_permissions`** (level-1-core.md:647-655) — composite
  primary key `(role_id, permission)`. A role's permission set is the
  set of rows with its `role_id`.
- **`auth_principal_roles`** (level-1-core.md:657-679) — assigns roles
  to principals with `scope_type` (`installation`, `repository`,
  `fleet`, `system`), `scope_id`, `expires_at`, `revoked_at`,
  `revoked_by`. Two CHECK constraints (`chk_scope_id_required`,
  `chk_scope_id_null_fleet_system` — level-1-core.md:670-673) enforce
  that `fleet`/`system` rows have null `scope_id` and the others do
  not.

### Durable revocation

Role assignments are **durable** — revocation sets `revoked_at`, never
deletes the row (permission-model.md:315). The active-assignments
index is partial: `WHERE revoked_at IS NULL` (level-1-core.md:676-678).
This preserves the history needed to reconstruct past decisions.

### Versioning captured in commands

Every Level 1 mutation command carries two versioning columns
(level-1-core.md §6, :302-303; table at :703-704):

- **`auth_result_snapshot jsonb NOT NULL`** — the full authorization
  result that admitted the command.
- **`auth_policy_version text NOT NULL`** — the policy version under
  which the decision was made.

The authorization result is recorded as part of the mutation command's
provenance; the database does not re-run the authorization engine
(level-1-core.md:266-268). This makes every command self-describing
with respect to the policy that authorized it.

### Decision-record versioning

The decision record itself carries
(permission-model.md:866-887): `role_permissions_version` (hash of
active roles), `operation_policy_version` (hash of the route
registry), `credential_scopes_evaluated`, `resource_grants_evaluated`.
These hashes are what get folded into `auth_result_snapshot`.

### Enforcement state machine

A single-row table `auth_enforcement_state`
(level-1-core.md:783-851) holds the cutover state with values
`CHECK ('observed','enforce','executor_only','legacy_removed')`
(level-1-core.md:788-789). It is transitioned **only** via the
`transition_enforcement_state()` SECURITY DEFINER function
(level-1-core.md:806-846); `updated_by` is derived from
`session_user`, not caller-supplied (level-1-core.md:835, 849-851).
See ADR-0007 for the cutover sequence these states drive.

### Assurance profile

Every command carries `assurance_profile text NOT NULL DEFAULT 'level1'`
(level-1-core.md:304, 705). Level 2/3 deployments set this to `level2`
or `level3`. This is the per-command marker of the deployment's
security profile.

## Rationale

1. **Reconstructability.** Capturing `auth_result_snapshot` and
   `auth_policy_version` into each command means a past mutation can be
   audited without time-traveling the policy tables — the decision is
   in the record.
2. **Durable revocation.** Soft-delete preserves the assignment history
   needed to interpret old decisions correctly (a revoked role was
   valid until its `revoked_at`).
3. **Controlled cutover.** A single state machine, advanced only
   through a SECURITY DEFINER function with `session_user`-derived
   attribution, prevents accidental or covert progression of the
   enforcement rollout (see ADR-0007, ADR-0008).
4. **Profile marker.** `assurance_profile` lets a Level 2/3 deployment
   distinguish its commands without a separate schema.

## Non-goals

- This ADR does not specify the DDL of the policy tables or the
  `transition_enforcement_state` function body. The DDL is an
  implementation target owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify the enforcement cutover sequence — see
  ADR-0007.
- This ADR does not specify how command provenance is kept immutable
  after creation — see ADR-0006.

## Acceptance criteria

An implementation conforms to this ADR when:

- The three policy tables exist with the stated columns and
  constraints.
- Role revocation sets `revoked_at`; rows are never deleted.
- Every mutation command carries non-null `auth_result_snapshot` and
  `auth_policy_version`.
- The enforcement state is transitioned only through
  `transition_enforcement_state()`, with `updated_by` derived from
  `session_user`.
- `assurance_profile` defaults to `level1` and is overridable only by
  a stricter deployment's admission path.

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §5, §6, §11, §12
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §5, §6
- Related: [ADR-0001](./0001-authority-source-of-truth.md) (where decisions live),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (command immutability),
  [ADR-0007](./0007-migration-and-compatibility-strategy.md) (cutover state machine),
  [ADR-0008](./0008-production-security-authority-retained-by-humans.md) (who may transition state)
