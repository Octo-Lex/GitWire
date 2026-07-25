# ADR 0004: Tenancy and resource inheritance

> **Scope marker.** Records what a tenant is, how scope is derived, and
> how grants inherit across the resource hierarchy. Part of the Level 1
> authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/permission-model.md`](../authority/permission-model.md) §3
"Resource hierarchy and inheritance" and §8 "Tenant and repository
boundaries".

## Context

The inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records that list endpoints today are global by default (F-09): a
caller with any valid credential can enumerate resources across all
installations. There is no tenant concept enforced at the data-access
layer. A Level 1 deployment must define a tenant, derive scope
deterministically, and apply it fail-closed at the data-access
boundary.

## Decision

### Tenant definition

The tenant is the **GitHub App installation**
(current-state-inventory.md:172-173; permission-model.md §3, §8).
Every installation-scoped resource carries the installation it belongs
to; authorization scope is expressed in terms of installations and
their repositories.

### Inheritance rules

Grants inherit **downward** through the hierarchy
(permission-model.md:190-201):

- A grant on `installation` applies to all repositories and
  installation-scoped resources within it.
- A grant on `repository` applies to all child resources within it.
- A grant on a specific resource applies only to that resource.
- Identity-scoped and system-scoped resources do **not** inherit from
  installation — they require explicit fleet-level or system-level
  grants.

**Denials do not inherit upward** (permission-model.md:199-200): a
denial at the repository level does not deny access to the
installation. Denial flows downward only. This pairs with the
specificity rule in ADR-0003.

### Two-phase evaluation

Authorization runs in two phases (permission-model.md §8, :922-956):

- **Phase A — derive tenant scope**, before resource resolution. The
  scope is tri-state per dimension (`ALL | NONE | SET(ids)`).
- **Phase B — install the data-access boundary.** The mandatory query
  gateway (see ADR-0001) applies the scope to every SQL query against
  installation-scoped tables.

Fail-closed: if scope is all-`NONE` with no fleet/system component,
the gateway returns empty result sets for all installation-scoped
queries. A route that forgets to request tenant filtering gets nothing
(permission-model.md:951-955).

### Worker scope

Workers do **not** receive tenant scope from the job payload. The
payload's `installation_id` and `repository_id` are **comparison
claims, not authority sources** (permission-model.md:961). The
worker's gateway scope is derived solely from the validated
delegation's resource boundary.

### Queue authority model

`queue_job` is transport-scoped, not a tenant resource
(permission-model.md §8, :978-1029). It has two distinct enforcement
points:

1. **Initiating enqueue authority** — `<resource_type>:enqueue`,
   tenant-scoped, evaluated at enqueue time.
2. **Worker ceiling for downstream enqueue** — `queue_job:enqueue` in
   `auth_worker_ceilings`, transport-scoped, governing a worker's
   ability to enqueue the next stage of a chain.

### Resource categories

(permission-model.md:182-188)

- **Installation-scoped** — tenant-scoped; the bulk of the registry.
- **Identity-scoped** — system-scoped (e.g. `auth_principal`,
  `auth_role`); not tenant-filtered.
- **System-scoped** — fleet-wide.
- **Transport-scoped** — `queue_job`; not a tenant resource.
- **Worker-internal** — governed by ceilings, not the standard
  permission model.

## Rationale

1. **Fail-closed by construction.** Defaulting scope to `NONE` and
   applying it at the data-access layer means a missing scope check
   produces empty results, not a data leak. This closes F-09.
2. **Payloads are claims.** Treating worker payloads as comparison
   claims closes F-06's trust-the-payload failure at the architectural
   level: even a forged payload cannot widen a worker's scope beyond
   its validated delegation.
3. **Two enforcement points for queues.** Separating initiating
   authority from worker ceiling prevents a worker from arbitrarily
   enqueuing work outside its chain.
4. **Downward-only denial.** Lets a deployment lock down a subtree
   without accidentally locking its parent (paired with ADR-0003's
   specificity rules).

## Non-goals

- This ADR does not specify the query gateway's implementation — that
  is application code.
- This ADR does not specify per-worker database identity. Today workers
  share the `gitwire_app` DB role; per-worker database login is a
  Level 2 concern (level-1-core.md:124, 1461).
- This ADR does not specify the delegation/capability mechanism for
  jobs. The capability-token mechanism in `permission-model.md §14` is
  superseded for the Level 1 closure of F-06 — see ADR-0006.

## Acceptance criteria

An implementation conforms to this ADR when:

- The tenant is the GitHub App installation on every installation-scoped
  resource.
- Grants inherit downward per the rules above; denials do not inherit
  upward.
- The query gateway applies the derived tenant scope to every
  installation-scoped query.
- A request with all-`NONE` scope and no fleet/system component
  receives empty result sets (fail-closed).
- Worker scope is derived from the validated delegation, not from the
  job payload.

## Cross-references

- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §3, §8
- Source: [`../authority/current-state-inventory.md`](../authority/current-state-inventory.md) (F-09)
- Related: [ADR-0001](./0001-authority-source-of-truth.md) (query gateway as authoritative boundary),
  [ADR-0003](./0003-evaluation-and-deny-semantics.md) (denial specificity),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (JTI/capability supersession for Level 1)
