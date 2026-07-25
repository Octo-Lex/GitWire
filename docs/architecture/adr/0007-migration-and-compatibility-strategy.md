# ADR 0007: Migration and compatibility strategy

> **Scope marker.** Records how the Level 1 schema is added, how the
> enforcement cutover proceeds, and how legacy paths are bridged. Part
> of the Level 1 authority architecture (issue #77, output 4).

## Status

Accepted. Settled by [`../authority/level-1-core.md`](../authority/level-1-core.md) §9, §12
and [`../authority/permission-model.md`](../authority/permission-model.md) §2, §13.

## Decision

### Migration files

The Level 1 schema is added by three migration files
(level-1-core.md §12, :1141-1148):

```text
038_level1_schema.sql  — schema, tables, triggers, indexes
039_level1_roles.sql   — roles, schema grants, table privileges
040_level1_seed.sql    — bootstrap admin principal + credential
```

Object creation proceeds in 19 numbered steps; rollback is the reverse
in 22 numbered steps (level-1-core.md:1155-1204). All changes are
additive — no existing tables are modified destructively
(level-1-core.md:553-554).

### Enforcement cutover — four states

Cutover is driven by the `auth_enforcement_state` machine (see
ADR-0005) through exactly four states (level-1-core.md §9, :486-503;
restated at §12, :1348-1363):

1. **Observe-only** (`observed`): the existing direct-write path
   performs mutations; the admission path shadow-validates (compares
   predicted vs actual requests) but does **not** execute a second
   mutation.
2. **Enforce** (`enforce`): new mutations must go through admission +
   executor; the legacy path is blocked at the code level.
3. **Executor-only** (`executor_only`): GitHub write credentials are
   revoked from the application and granted only to the executor.
4. **Legacy removal** (`legacy_removed`): the direct-write code is
   removed.

Transitions are legal only along the graph enforced by
`transition_enforcement_state()` (level-1-core.md:822-830), and only
an operator may drive them (see ADR-0008).

### Prohibited direct-write paths

Ordinary routes, workers, schedulers, Telegram handlers, maintenance
tasks, and repair components must not call GitHub mutation APIs
directly (level-1-core.md §9, :480-484). What is **not** a direct
write: GitHub read APIs; workers creating commands; the executor
calling GitHub APIs (level-1-core.md:505-510).

### Legacy-key bridge

Each shared API key fingerprint registers as a `legacy-key` principal
(permission-model.md §13, :1314-1327; §11, :1253-1266). The bridge
narrows these keys:

- Allowed: `read`, `list`, `create`, `update`, `enqueue` on
  installation-scoped resources.
- Denied: `manage`, `approve`, `revoke`, `audit:export`, `audit:read`.
- **No automatic fleet default.** A legacy key with no explicit scope
  assignment is rejected with `denied:unmapped_legacy_key`
  (permission-model.md:1256-1257).
- Each key has an expiry date and a linked migration ticket.

### Anonymous paths preserved

The following paths remain unauthenticated by design
(permission-model.md:1329-1336):

- `/health` (anonymous)
- `/webhooks/github` (HMAC)
- `/api/auth/login` (key exchange)
- `/api/auth/logout` (cookie)
- `/api/auth/check` (session probe)

### Bootstrap state machine

Bootstrap has two states, `enabled` / `disabled`
(permission-model.md §2, :95-132). Re-enable requires a direct DB
INSERT into `auth_bootstrap_allow` by an operator with production DB
credentials — this is the **only** way to re-enable bootstrap; there
is no API route for it (permission-model.md:1251). See ADR-0008.

## Rationale

1. **Additive only.** Adding a parallel `gitwire_auth` schema and new
   tables lets the cutover proceed without touching existing data,
   preserving a clean rollback path.
2. **Shadow validation first.** The observe-only state lets the
   admission path prove its predictions match reality before it
   becomes authoritative, reducing cutover risk.
3. **Credential withdrawal as a state.** Moving GitHub write
   credentials from application to executor as an explicit cutover
   step makes "the application can no longer write to GitHub" a
   verifiable, auditable transition rather than a code assertion.
4. **Narrow legacy-key scope.** Bridging shared keys with a dedicated,
   tightly-scoped principal type lets existing clients keep working
   during migration without granting them authority they should not
   have.

## Non-goals

- This ADR does not own the executable proof of the migrations. The
  migration **file numbers, object order, and rollback sequence** are
  recorded here as architecture; their apply, rerun, negative-test,
  rollback, and reapply verification against a disposable PostgreSQL
  instance is owned by issue #81 (level-1-core.md:14-23).
- This ADR does not specify the trigger DDL or the
  `transition_enforcement_state` function body — see ADR-0005 and #81.
- This ADR does not specify the F-06 closure mechanism — see ADR-0006.
  (The capability-token design in `permission-model.md §14` is
  superseded for Level 1; Level 1 relies on admission + executor +
  idempotency + CAS.)

## Acceptance criteria

An implementation conforms to this ADR when:

- The three migration files exist with the stated numbers and apply
  additively without modifying existing tables.
- The cutover state machine enforces exactly the four states and the
  legal-transition graph.
- No route, worker, scheduler, or handler outside the executor calls a
  GitHub mutation API directly (in the `legacy_removed` state).
- A legacy key with no explicit scope assignment is rejected with
  `unmapped_legacy_key`.
- The five anonymous paths remain reachable without authentication;
  every other path requires an authenticated principal.
- Bootstrap re-enable requires a direct DB INSERT into
  `auth_bootstrap_allow`; no API route exists for it.

## Cross-references

- Source: [`../authority/level-1-core.md`](../authority/level-1-core.md) §9, §12
- Source: [`../authority/permission-model.md`](../authority/permission-model.md) §2, §13
- Related: [ADR-0005](./0005-policy-storage-and-versioning.md) (state machine + transition function),
  [ADR-0006](./0006-audit-event-integrity-boundary.md) (F-06 Level 1 closure),
  [ADR-0008](./0008-production-security-authority-retained-by-humans.md) (operator authority over cutover and bootstrap)
