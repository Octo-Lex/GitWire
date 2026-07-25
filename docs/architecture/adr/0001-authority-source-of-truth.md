# ADR 0001: Authority source of truth

> **Scope marker.** Records where authorization decisions are made and
> where the authoritative policy data lives. Part of the Level 1
> authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §5
"Repository-scoped authorization" and
[`../authority/permission-model.md`](../authority/permission-model.md) §8
"Tenant and repository boundaries".

## Context

The current-state inventory
([`../authority/current-state-inventory.md`](../authority/current-state-inventory.md))
records that GitWire today has no single authoritative authorization
source. Enforcement is scattered across route handlers, services, and
ad-hoc checks, with several paths that bypass authorization entirely
(findings F-02, F-09, F-10). A Level 1 deployment must answer two
questions unambiguously: *which component* decides whether a request is
authorized, and *which data* that decision is computed from.

Three candidate locations were considered for the decision boundary:

1. **PostgreSQL Row-Level Security (RLS).** The database enforces
   row-level visibility per role.
2. **A mandatory application-layer query gateway.** Every SQL query
   against installation-scoped tables passes through one code path that
   applies the derived tenant scope.
3. **Per-route handler checks.** Each route re-derives authorization
   inline, as today.

## Decision

Authority for an authorization decision lives in the **application
layer**, computed from server-owned policy tables, and the authoritative
data-access boundary is a **mandatory query gateway** — not PostgreSQL
RLS, and not per-route checks.

Concretely:

- Authorization is an **application-layer** evaluation. It is **not**
  deferred to PostgreSQL (level-1-core.md:254). The database does not
  re-run the authorization engine (level-1-core.md:266-268).
- The application derives the decision from the `auth_roles`,
  `auth_role_permissions`, and `auth_principal_roles` tables
  (level-1-core.md:240-241). These are the authoritative policy tables.
- The principal under which a decision is made is **derived from the
  authenticated credential, never from request headers or request body**
  (level-1-core.md:80, 184-185). Client-supplied identity is not an
  authority source (this closes finding F-03).
- The derived tenant scope is installed into a **mandatory query
  gateway** that applies scope to every SQL query against
  installation-scoped tables (permission-model.md §8). PostgreSQL RLS
  is explicitly **not** the chosen boundary (permission-model.md:942-949):
  it is not testable in CI without a production Postgres configuration,
  it cannot express dynamic per-request scope changes, and it produces
  silent row filtering rather than structured denial reasons. RLS may
  be added later as defense-in-depth, but the query gateway is the
  authoritative boundary.
- Default deny: a request with no matching allow is denied
  (permission-model.md:32, 896-898).

## Rationale

1. **Testability.** Application-layer authorization is exercisable in CI
   without standing up a production Postgres configuration. RLS policy
   correctness can only be proven against the real database, which is
   exactly the executable proof owned by issue #81.
2. **Dynamic scope.** A request's tenant scope is per-request and may
   combine fleet, installation, and repository dimensions in ways that
   RLS roles cannot express without a role explosion.
3. **Structured denials.** The query gateway returns empty result sets
   for out-of-scope queries and the evaluator emits one of 25 stable
   denial reason codes (see ADR-0003). RLS silently filters rows,
   defeating deterministic audit and consistent error responses.
4. **Single source.** Routing every installation-scoped query through
   one gateway means a route that forgets to request tenant filtering
   gets nothing — fail-closed by construction
   (permission-model.md:951-955). This closes F-09 (list endpoints
   global by default).

## Non-goals

- This ADR does not specify the evaluator algorithm or denial codes —
  see ADR-0003.
- This ADR does not specify the principal/resource/action vocabulary —
  see ADR-0002.
- This ADR does not specify the SQL DDL of the policy tables or the
  query gateway's implementation. The DDL is an implementation target
  owned by issue #81 (level-1-core.md:14-23).

## Acceptance criteria

An implementation conforms to this ADR when:

- Every authorization decision is computed in the application layer
  from `auth_roles`, `auth_role_permissions`, `auth_principal_roles`.
- The principal is derived from the authenticated credential on every
  request; no client-supplied identity header or body field is treated
  as authoritative.
- Every SQL query against an installation-scoped table passes through
  the query gateway with the derived tenant scope applied.
- A request with no matching allow is denied (default deny).
- PostgreSQL RLS is not the primary enforcement boundary (it may exist
  only as optional defense-in-depth).

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §2, §3, §5
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §8
- Related: [ADR-0002](./0002-principal-resource-action-model.md) (vocabulary),
  [ADR-0003](./0003-evaluation-and-deny-semantics.md) (algorithm),
  [ADR-0004](./0004-tenancy-and-resource-inheritance.md) (scope dimensions)
