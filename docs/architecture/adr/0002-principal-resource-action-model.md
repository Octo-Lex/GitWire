# ADR 0002: Principal/resource/action model

> **Scope marker.** Records the identities, resources, and actions that
> the Level 1 authority vocabulary operates over. Part of the Level 1
> authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §3
"Server-owned identities" and
[`../authority/permission-model.md`](../authority/permission-model.md) §2,
§3, §4, §17.

## Context

An authorization decision is only as stable as the vocabulary it
operates over. The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records eight ad-hoc principal types (P-1..P-8), inconsistent resource
naming, and an action vocabulary that conflated read and mutate
(`github:mutate (read-only)` was self-contradictory —
permission-model.md:250-251). A canonical vocabulary must be small,
closed, and stable across Level 2/3 enrichments.

## Decision

### Principal types

Level 1 supports exactly **five principal types**
(level-1-core.md:145, 150):

```text
'user' | 'service' | 'installation' | 'system' | 'legacy-key'
```

Each carries subtype constraints enforced by CHECK constraints on
`auth_principals` (level-1-core.md:583-600):

- `user` — may have `github_user_id`; must not have `installation_id`.
- `service` — must not have `github_user_id` or `installation_id`.
- `installation` — must have `installation_id`; no `github_user_id`.
- `system` — no external identity.
- `legacy-key` — no external identity; one per shared API key
  fingerprint, the migration bridge (see ADR-0007).

Every principal carries a monotonically increasing `auth_epoch`
(level-1-core.md:155, 168-171) that increments on credential
revocation, role revocation, or admin-forced session invalidation;
sessions compare their epoch against the principal's current epoch on
every request.

### Resources

The canonical resource set is the **57-resource registry**
(permission-model.md §17): 45 installation-scoped + 11 system-scoped +
1 transport-scoped (`queue_job`) (permission-model.md:1871-1872). The
hierarchy is `system → installation → repository → {pull_request,
issue, ci_run, branch_rule, repo_config, ...}` (permission-model.md
§3). Resources outside this registry are not authorizable.

### Actions

The action vocabulary is exactly **twelve actions**
(permission-model.md:215-231):

```text
read, list, create, update, delete,
github:act, github:read, enqueue, approve, revoke, manage,
audit:read, audit:export
```

- No undeclared verbs (permission-model.md:249).
- `github:act` and `github:read` are separate actions; the legacy
  `github:mutate (read-only)` is removed (permission-model.md:250-251).
- `read` and `list` are independent — both must be explicitly granted
  (permission-model.md:252-254).

### Permission tokens

A permission token is `<resource_type>:<action>` using the exact Token
from the registry (permission-model.md §4). Naming follows the
registry's rules (e.g. `policy_rollout_plan`, not `rollout_plan`;
`webhook_delivery`, not `webhook_deliveries` —
permission-model.md:1960-1961).

### Scope modifiers

Four scope modifiers qualify how a grant applies
(permission-model.md:258-262): `own`, `installation`, `fleet`,
`system`. `system` scope does **not** match installation-scoped
resources, and transport-scoped resources (`queue_job`) are governed by
`auth_worker_ceilings`, not by system scope.

## Rationale

1. **Closure.** A fixed, enumerated vocabulary makes unauthorized
   operations fail-closed: a permission token with an unknown resource
   or verb cannot match anything.
2. **Stability.** The five principal types and 57 resources are stable
   across Level 2/3; richer deployments enrich the *evidence* attached
   to a command (see ADR-0006), not the vocabulary.
3. **Separation of read and mutate.** Splitting `github:act` from
   `github:read` and `read` from `list` prevents the accidental grant
   of write authority through a read-only permission name.
4. **`legacy-key` bridge.** A dedicated principal type for shared API
   keys lets existing clients migrate without a flag day, while being
   narrowly scoped (see ADR-0007).

## Non-goals

- This ADR does not specify how tokens are *evaluated* — see ADR-0003.
- This ADR does not specify the CHECK-constraint DDL — that is an
  implementation target owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify job-authorization capability tokens or JTI.
  `permission-model.md §14` specifies a signed capability-token
  mechanism, but ADR-0006 records that this mechanism is **superseded
  for the Level 1 closure of F-06** and retained only as optional
  Level 2 design guidance. See ADR-0006 for the binding resolution.

## Acceptance criteria

An implementation conforms to this ADR when:

- The principal type is one of the five enumerated values and satisfies
  its subtype constraints.
- Every permission token is of the form `<resource_type>:<action>` with
  both halves drawn from the registry.
- The action vocabulary is exactly the twelve listed; no synonyms or
  aliases are accepted.
- `read` and `list` are granted independently; `github:act` and
  `github:read` are distinct.

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §3, §11 (`auth_principals`)
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §2, §3, §4, §17
- Related: [ADR-0001](./0001-authority-source-of-truth.md) (where decisions live),
  [ADR-0003](./0003-evaluation-and-deny-semantics.md) (evaluation),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (JTI/capability supersession for Level 1),
  [ADR-0007](./0007-migration-and-compatibility-strategy.md) (`legacy-key` bridge)
