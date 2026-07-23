# Schema and Migration Plan (W0-C)

> **Wave 0 checkpoint C.** This is a no-execution design document. It
> translates the accepted W0-B permission model
> ([`permission-model.md`](./permission-model.md), commit `51e3f70`) into
> concrete proposed DDL, constraints, indexes, privileges, concurrency
> invariants, additive migration ordering, backfill rules, rollback
> boundaries, and schema-level proof obligations.
>
> **No executable migration files are created.** No database is altered.
> No runtime identity, RBAC, or query-gateway implementation is introduced.
> This document is the authoritative schema specification for W0-D (ADRs
> and validation plan) and Waves 1–4 (implementation).

## Table of contents

1. [Scope and conventions](#1-scope-and-conventions)
2. [Enums, domains, and resource-reference representation](#2-enums-domains-and-resource-reference-representation)
3. [Principal and identity tables](#3-principal-and-identity-tables)
4. [Credential tables](#4-credential-tables)
5. [Role and permission tables](#5-role-and-permission-tables)
6. [Resource grant tables](#6-resource-grant-tables)
7. [Worker ceiling tables](#7-worker-ceiling-tables)
8. [Delegation and execution-claim tables](#8-delegation-and-execution-claim-tables)
9. [External attestation tables](#9-external-attestation-tables)
10. [Authorization decision tables](#10-authorization-decision-tables)
11. [Session tables](#11-session-tables)
12. [Bootstrap tables and stored functions](#12-bootstrap-tables-and-stored-functions)
13. [Ownership metadata for the query gateway](#13-ownership-metadata-for-the-query-gateway)
14. [Audit-event linkage](#14-audit-event-linkage)
15. [Concurrency invariants summary](#15-concurrency-invariants-summary)
16. [Privilege model](#16-privilege-model)
17. [Migration plan — additive 10-stage sequence](#17-migration-plan--additive-10-stage-sequence)
18. [Proof obligations and fixtures](#18-proof-obligations-and-fixtures)
19. [Unresolved schema risks](#19-unresolved-schema-risks)

---

## 1. Scope and conventions

### Source of truth

The accepted W0-B model (`permission-model.md` at `51e3f70`) is the
normative input. Every table, column, constraint, and enum in this
document encodes a W0-B requirement. Where W0-B defines a field, this
document defines its SQL type and constraints. Where W0-B references a
table without a full column list (`auth_credentials`, `auth_roles`,
`auth_bootstrap_allow`, `auth_bootstrap_state`), this document fills
the gap from the W0-B lifecycle requirements (§10, §2, §11).

### Migration file naming

Existing migrations follow `NNN_descriptive_name.sql` starting at `001`.
The last applied migration is `037_blocked_reason.sql`. W0-C migrations
start at `038` and are additive-only — no destructive `ALTER` or `DROP`
in the initial sequence. Destructive retirement (dropping legacy columns)
is a separate gated stage with prerequisites.

### PostgreSQL version

GitWire runs PostgreSQL 16+. DDL uses:
- `CREATE TYPE` for enums (not inline `VARCHAR` + `CHECK`).
- `UUID` via `pgcrypto` (already a dependency).
- `GEN_RANDOM_UUID()` for default primary keys.
- `TIMESTAMPTZ` for all timestamps.
- Partial indexes for active/revoked predicates.
- `SECURITY DEFINER` functions for bootstrap transitions.

### Additive principle

Every migration stage adds tables, columns, indexes, or functions. No
stage removes or renames existing objects. Existing application code
continues to work unchanged at every stage boundary. Enforcement
(observed mode) is a flag flip at the application level, not a schema
change.

### Fail-closed default

Unmapped ownership, unmapped credentials, or ambiguous identity MUST
deny by default and be reported for human resolution. No backfill
operation creates implicit authority.

---

## 2. Enums, domains, and resource-reference representation

### Enums

```sql
-- Principal types (W0-B §2)
CREATE TYPE principal_type AS ENUM (
  'user', 'service', 'installation', 'system', 'legacy-key'
);

-- Principal/credential status
CREATE TYPE principal_status AS ENUM ('active', 'disabled');

-- Scope types (W0-B §5, §6)
CREATE TYPE scope_type AS ENUM (
  'installation', 'repository', 'fleet', 'system'
);

-- Grant effect
CREATE TYPE grant_effect AS ENUM ('allow', 'deny');

-- Delegation execution lifecycle (W0-B §9, §14)
CREATE TYPE delegation_status AS ENUM (
  'pending', 'executing', 'completed', 'cancelled', 'denied'
);

-- Bootstrap state machine (W0-B §2)
CREATE TYPE bootstrap_state AS ENUM ('enabled', 'disabled');

-- Credential environment binding (W0-B §10)
CREATE TYPE credential_environment AS ENUM (
  'production', 'staging', 'isolated'
);

-- Credential audience (W0-B §10)
CREATE TYPE credential_audience AS ENUM (
  'gitwire-app', 'executor-service', 'bot', 'dashboard'
);
```

### Resource-reference representation

The 57-resource registry uses three identifier types: `bigint`
(installation/repository-scoped, from GitHub IDs), `UUID` (system-scoped
identity resources), and `text` (hash-based or delivery-ID-based
resources). All resource references in grant/delegation tables use
`text` for `resource_id` to accommodate all three uniformly:

```sql
-- resource_type is always the canonical singular token from §17 registry.
-- resource_id is text to accommodate bigint, UUID, and hash identifiers.
-- NULL resource_id = wildcard (all resources of this type within scope).
-- The application validates resource_type against the 57-token registry.
```

**Why `text` and not polymorphic:** PostgreSQL has no clean polymorphic
FK. Using `text` allows a single column to reference any resource type.
Referential integrity is enforced at the application layer by the
`resolve_target` function (W0-B §6), which resolves the canonical type
and validates existence through the query gateway. A `CHECK` constraint
on `resource_type` ensures it matches the registry:

```sql
-- This CHECK is populated from the §17 canonical registry.
-- It prevents typos and unregistered resource types at the DB level.
-- The full list is enumerated in migration 039_auth_resource_types.sql.
```

### Credential scope-restriction storage

Credential installation/repository restrictions are stored as arrays
to support the tri-state intersection algebra (ALL = NULL array, SET =
non-empty array, NONE = empty array):

```sql
-- installation_ids bigint[] NULL  -- NULL = unrestricted (ALL)
-- repository_ids   bigint[] NULL  -- NULL = unrestricted (ALL)
-- An empty array '{}' = explicitly no access (NONE).
-- A non-empty array = finite restriction (SET).
```

---

## 3. Principal and identity tables

### `auth_principals`

```sql
CREATE TABLE auth_principals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  principal_type NOT NULL,
  display_name    text        NOT NULL,
  status          principal_status NOT NULL DEFAULT 'active',
  github_user_id  bigint      UNIQUE,  -- only for type='user'
  github_login    text,               -- only for type='user'
  installation_id bigint,             -- only for type='installation'
  auth_epoch      bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Type-binding constraints (W0-B §2)
  CONSTRAINT chk_user_has_github
    CHECK ((principal_type = 'user') = (github_user_id IS NOT NULL)),
  CONSTRAINT chk_service_no_external
    CHECK (principal_type != 'service'
           OR (github_user_id IS NULL AND installation_id IS NULL)),
  CONSTRAINT chk_installation_has_id
    CHECK (principal_type != 'installation' OR installation_id IS NOT NULL),
  CONSTRAINT chk_system_no_external
    CHECK (principal_type != 'system'
           OR (github_user_id IS NULL AND installation_id IS NULL)),
  CONSTRAINT chk_legacy_no_external
    CHECK (principal_type != 'legacy-key'
           OR (github_user_id IS NULL AND installation_id IS NULL))
);
```

**Indexes:**
```sql
CREATE UNIQUE INDEX ux_auth_principals_github_user_id
  ON auth_principals (github_user_id) WHERE github_user_id IS NOT NULL;
CREATE UNIQUE INDEX ux_auth_principals_installation_id
  ON auth_principals (installation_id) WHERE installation_id IS NOT NULL;
CREATE INDEX ix_auth_principals_type_status
  ON auth_principals (principal_type, status);
```

**Active predicate:** `status = 'active'`.
**Disabled predicate:** `status = 'disabled'`.
**Retention:** principals are never hard-deleted. Disabled principals
retain all role/grant/credential records for audit. `auth_epoch`
increments on credential revocation, role revocation, or admin-forced
session invalidation.

---

## 4. Credential tables

### `auth_credentials`

Derived from W0-B §10 lifecycle requirements (HMAC proof, lookup ID,
audience, environment, scope restrictions, revocation, expiry):

```sql
CREATE TABLE auth_credentials (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        UUID        NOT NULL REFERENCES auth_principals(id),
  lookup_id           text        NOT NULL UNIQUE,  -- random, collision-resistant
  secret_hash         text        NOT NULL,  -- HMAC(secret, pepper_version)
  pepper_version      integer     NOT NULL,
  audience            credential_audience NOT NULL,
  environment         credential_environment NOT NULL DEFAULT 'production',
  scopes              text[],     -- action scopes; NULL/empty = all actions
  installation_ids    bigint[],   -- NULL = unrestricted; {} = none; {1,2} = SET
  repository_ids      bigint[],   -- NULL = unrestricted; {} = none; {1,2} = SET
  display_prefix      text        NOT NULL,  -- e.g., 'gw_pat_'
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,  -- NULL = no expiry
  revoked_at          timestamptz,
  revoked_by          UUID        REFERENCES auth_principals(id),
  revocation_reason   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
```

**Indexes:**
```sql
CREATE UNIQUE INDEX ux_auth_credentials_lookup_id
  ON auth_credentials (lookup_id);
CREATE INDEX ix_auth_credentials_principal_active
  ON auth_credentials (principal_id)
  WHERE revoked_at IS NULL;
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
**Revoked predicate:** `revoked_at IS NOT NULL`.
**Expired predicate:** `expires_at IS NOT NULL AND expires_at <= now()`.

**Concurrency invariant:** credential lookup is a read-only operation
(`SELECT ... WHERE lookup_id = $1`). Revocation is a single-row UPDATE
(`SET revoked_at = now(), revoked_by = $2`). No multi-row transaction
needed for revocation. Session invalidation is handled by
`auth_epoch` increment on the principal (the session check compares
the session's epoch against the principal's current epoch).

**Pepper rotation:** `pepper_version` references an external config
source (env var or sealed file). Old peppers remain available until
`SELECT count(*) FROM auth_credentials WHERE pepper_version = $old AND
revoked_at IS NULL` returns 0. Pepper removal is an operational
procedure, not a schema migration.

---

## 5. Role and permission tables

### `auth_roles`

Defines the role catalog (built-in + custom roles). Roles are
templates; `auth_principal_roles` binds them to principals with scope.

```sql
CREATE TABLE auth_roles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,  -- e.g., 'admin', 'viewer', 'service:heal-worker'
  description text,
  is_builtin  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### `auth_role_permissions`

Maps roles to their permission set. Permissions are
`<resource_type>:<action>` tokens using the exact registry token and
action vocabulary.

```sql
CREATE TABLE auth_role_permissions (
  role_id     UUID        NOT NULL REFERENCES auth_roles(id) ON DELETE CASCADE,
  permission  text        NOT NULL,  -- e.g., 'repository:read', 'repository:list'
  PRIMARY KEY (role_id, permission)
);
```

**Proof obligation:** every `permission` value must decompose as
`<registry_token>:<action>` where `<registry_token>` is in the 57-token
registry and `<action>` is in that token's declared action set. This is
validated by a `CHECK` constraint backed by a lookup table (see
migration 039) or by application-layer validation at seed time.

### `auth_principal_roles`

Durable role assignments binding a principal to a role with a specific
scope. This is the tenant-scope authority source (W0-B §6 STEP 2).

```sql
CREATE TABLE auth_principal_roles (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        UUID        NOT NULL REFERENCES auth_principals(id),
  role_id             UUID        NOT NULL REFERENCES auth_roles(id),
  scope_type          scope_type  NOT NULL,
  scope_id            bigint,     -- installation_id or repo github_id; NULL for fleet/system
  granted_at          timestamptz NOT NULL DEFAULT now(),
  granted_by          UUID        NOT NULL REFERENCES auth_principals(id),
  expires_at          timestamptz,  -- NULL = no expiry
  revoked_at          timestamptz,
  revoked_by          UUID        REFERENCES auth_principals(id),
  revocation_reason   text,

  -- scope_id is required for installation/repository scopes
  CONSTRAINT chk_scope_id_required
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  -- scope_id must be NULL for fleet/system
  CONSTRAINT chk_scope_id_null_for_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);
```

**Indexes:**
```sql
CREATE INDEX ix_auth_principal_roles_principal_active
  ON auth_principal_roles (principal_id, scope_type)
  WHERE revoked_at IS NULL;
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
**Retention:** assignments are durable — revocation sets `revoked_at`,
never deletes.

**Concurrency invariant:** role queries in STEP 2 are read-only
(`SELECT ... WHERE principal_id = $1 AND revoked_at IS NULL AND ...`).
Granting and revoking are single-row INSERT/UPDATE. No race condition
on scope derivation because each request re-reads the current state.

---

## 6. Resource grant tables

### `auth_resource_grants`

Explicit allow/deny grants on specific or wildcard resources. Used in
`evaluate_leaf` (W0-B §6) for the allow/deny intersection.

```sql
CREATE TABLE auth_resource_grants (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        UUID        NOT NULL REFERENCES auth_principals(id),
  resource_type       text        NOT NULL,  -- canonical registry token
  resource_id         text,       -- NULL = wildcard within scope
  scope_type          scope_type  NOT NULL,
  scope_id            bigint,     -- NULL for fleet/system
  action              text        NOT NULL,  -- action or '*'
  effect              grant_effect NOT NULL,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  granted_by          UUID        NOT NULL REFERENCES auth_principals(id),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by          UUID        REFERENCES auth_principals(id),
  revocation_reason   text,

  CONSTRAINT chk_grant_scope_id
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  CONSTRAINT chk_grant_scope_id_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);
```

**Indexes:**
```sql
-- Primary lookup: grants for a principal on a resource type
CREATE INDEX ix_auth_resource_grants_lookup
  ON auth_resource_grants (principal_id, resource_type, effect)
  WHERE revoked_at IS NULL;

-- Wildcard grant lookup (resource_id IS NULL)
CREATE INDEX ix_auth_resource_grants_wildcard
  ON auth_resource_grants (principal_id, resource_type, scope_type, effect)
  WHERE revoked_at IS NULL AND resource_id IS NULL;

-- Specific grant lookup
CREATE INDEX ix_auth_resource_grants_specific
  ON auth_resource_grants (principal_id, resource_type, resource_id, effect)
  WHERE revoked_at IS NULL AND resource_id IS NOT NULL;
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.

**Grant specificity (W0-B §7):** a grant on a specific `resource_id`
is more specific than a grant on `resource_id IS NULL`. Deny at a more
specific level overrides allow at a less specific level. Allow at a
more specific level does NOT override deny at a less specific level.
This specificity is evaluated in the application's
`grant_matches_target` function, not as a DB constraint.

**Concurrency invariant:** grant evaluation is read-only. Granting and
revoking are single-row INSERT/UPDATE. The `evaluate_leaf` function
re-reads the current state per request (or per re-authorization
checkpoint for sensitive operations).

---

## 7. Worker ceiling tables

### `auth_worker_ceilings`

Action ceilings for service principals. These are **never** consulted
during tenant scope derivation (STEP 2). Worker authority comes
exclusively from ceilings (action) + delegations (resource boundary).

```sql
CREATE TABLE auth_worker_ceilings (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  UUID        NOT NULL REFERENCES auth_principals(id),
  role_name     text        NOT NULL,  -- e.g., 'service:heal-worker'
  permissions   text[]      NOT NULL,  -- e.g., ['repository:github:act', 'managed_action:update']
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    UUID        NOT NULL REFERENCES auth_principals(id),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- Only service principals can have ceilings
  CONSTRAINT chk_worker_ceiling_service_only
    CHECK (principal_id IN (
      SELECT id FROM auth_principals WHERE principal_type = 'service'
    ))
);
```

**Index:**
```sql
CREATE INDEX ix_auth_worker_ceilings_principal_active
  ON auth_worker_ceilings (principal_id)
  WHERE revoked_at IS NULL;
```

**Active predicate:** `revoked_at IS NULL`.

**Concurrency invariant:** ceiling check is read-only. Ceiling updates
are single-row INSERT/UPDATE. No tenant-scope interaction.

---

## 8. Delegation and execution-claim tables

### `auth_delegations`

Delegation records binding initiating authority to worker execution.
Includes the owner/version CAS execution-claim fields (W0-B §14).

```sql
CREATE TABLE auth_delegations (
  id                          UUID              PRIMARY KEY DEFAULT gen_random_uuid(),
  initiating_principal_id     UUID              NOT NULL REFERENCES auth_principals(id),
  worker_service_principal_id UUID              NOT NULL REFERENCES auth_principals(id),
  operation                   text              NOT NULL,
  resource_type               text              NOT NULL,
  resource_id                 text,
  authorization_decision_id   UUID              NOT NULL,  -- FK to auth_authorization_decisions
  plan_hash                   text,
  created_at                  timestamptz       NOT NULL DEFAULT now(),
  expires_at                  timestamptz       NOT NULL,
  execution_status            delegation_status NOT NULL DEFAULT 'pending',
  execution_attempt_id        UUID,
  execution_version           bigint            NOT NULL DEFAULT 0,
  execution_started_at        timestamptz,
  revoked_at                  timestamptz,
  revoked_by                  UUID              REFERENCES auth_principals(id),
  revocation_reason           text
);
```

**Indexes:**
```sql
CREATE INDEX ix_auth_delegations_worker_pending
  ON auth_delegations (worker_service_principal_id, execution_status)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_delegations_initiator
  ON auth_delegations (initiating_principal_id)
  WHERE revoked_at IS NULL;
```

**Execution-claim CAS invariants (W0-B §14):**

1. **Acquire claim (owner-safe CAS):**
```sql
UPDATE auth_delegations
  SET execution_status = 'executing',
      execution_attempt_id = :attempt_id,
      execution_version = :execution_version + 1,
      execution_started_at = now()
  WHERE id = :delegation_id
    AND execution_status IN ('pending', 'completed', 'cancelled')
    AND execution_version = :expected_version;
-- affected_rows = 1 → claim acquired
-- affected_rows = 0 → blocked (executing or denied)
```

2. **Finalize claim (owner-checked CAS):**
```sql
UPDATE auth_delegations
  SET execution_status = :final_status  -- 'completed' or 'cancelled'
  WHERE id = :delegation_id
    AND execution_attempt_id = :my_attempt_id
    AND execution_status = 'executing';
-- affected_rows = 1 → finalized
-- affected_rows = 0 → this attempt no longer owns the claim
```

3. **Ownership checkpoint before side effects:**
```sql
SELECT execution_attempt_id, execution_status
  FROM auth_delegations WHERE id = :delegation_id;
-- Abort if execution_attempt_id != :my_attempt_id
--         OR execution_status != 'executing'
```

**Strict no-reset rule:** `execution_status = 'executing'` can only
transition out via:
- Owner-checked finalization (step 2 above), OR
- Explicit operator reconciliation after process-supervisor-confirmed
  termination (audited manual UPDATE by an operator DB session).

There is **no** time-based staleness trigger, automated timer, or
heartbeat-based reset. A `CHECK` constraint does not enforce this
(it is an operational procedure), but a partial index can detect
stale executions for alerting:

```sql
CREATE INDEX ix_auth_delegations_stale_executing
  ON auth_delegations (id, execution_started_at)
  WHERE execution_status = 'executing' AND revoked_at IS NULL;
-- This index exists for monitoring/alerting, not for automated reset.
```

**Denied delegations:** `execution_status = 'denied'` is permanently
terminal. The CAS acquire condition (`IN ('pending', 'completed',
'cancelled')`) excludes `denied`. No UPDATE can move `denied` back to
an acquirable state without operator DB access (which bypasses the
application role entirely).

**Reusability:** `completed` and `cancelled` delegations CAN acquire a
new claim (fresh `execution_attempt_id`, incremented
`execution_version`). This permits legitimate re-enqueue after crash
recovery.

---

## 9. External attestation tables

### `auth_external_attestations`

Bounded GitHub attestations for `/gitwire` comment commands (W0-B §13).
The attestation is the primary authority source — not evidence attached
to standing role/grant authority.

```sql
CREATE TABLE auth_external_attestations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    UUID        NOT NULL REFERENCES auth_principals(id),
  provider        text        NOT NULL DEFAULT 'github',
  subject         text        NOT NULL,  -- GitHub user login
  subject_id      bigint      NOT NULL,  -- GitHub user ID
  repository_id   bigint      NOT NULL,  -- GitHub repo ID
  permission      text        NOT NULL,  -- 'OWNER', 'MEMBER', 'COLLABORATOR'
  command         text        NOT NULL,  -- 'fix-issue', 'close-issue'
  delegation_id   UUID        NOT NULL REFERENCES auth_delegations(id),
  verified_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,  -- short (e.g., 5 minutes)
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**Indexes:**
```sql
CREATE INDEX ix_auth_external_attestations_lookup
  ON auth_external_attestations (provider, subject_id, repository_id, command, delegation_id)
  WHERE expires_at > now();

CREATE INDEX ix_auth_delegations_attestation_expiry
  ON auth_external_attestations (expires_at);
```

**Valid predicate:** `expires_at > now()`.
**Binding invariant:** the `delegation_id` filter ensures the
attestation authorizes only the specific delegation that created it.
A valid attestation cannot be reused for a different delegation, even
within its TTL.

**Retention:** expired attestations are retained for audit. A periodic
cleanup job may archive records older than a retention window (e.g.,
90 days), but this does not affect the authority model.

---

## 10. Authorization decision tables

### `auth_authorization_decisions`

Every evaluation (allow OR deny) produces a decision record (W0-B §6,
§12). This table is the audit trail for all authorization outcomes.

```sql
CREATE TABLE auth_authorization_decisions (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision                    text        NOT NULL,  -- 'allow' or 'deny'
  principal_id                UUID        REFERENCES auth_principals(id),
  credential_id               UUID        REFERENCES auth_credentials(id),
  resource_type               text,
  resource_id                 text,
  action                      text        NOT NULL,
  route                       text,
  reason_code                 text,       -- NULL for allow; denial code for deny
  role_permissions_hash       text,       -- hash of active roles evaluated
  credential_scopes_evaluated boolean     NOT NULL DEFAULT false,
  resource_grants_evaluated   boolean     NOT NULL DEFAULT false,
  operation_policy_version    text,       -- hash of route operation policy
  break_glass                 boolean     NOT NULL DEFAULT false,
  timestamp                   timestamptz NOT NULL DEFAULT now()
);
```

**Indexes:**
```sql
CREATE INDEX ix_auth_authorization_decisions_principal
  ON auth_authorization_decisions (principal_id, timestamp DESC);

CREATE INDEX ix_auth_authorization_decisions_resource
  ON auth_authorization_decisions (resource_type, resource_id, timestamp DESC);

CREATE INDEX ix_auth_authorization_decisions_reason
  ON auth_authorization_decisions (decision, reason_code)
  WHERE decision = 'deny';
```

**Retention:** append-only. Decisions are never UPDATEd or DELETEd.
The `id` is referenced by `auth_delegations.authorization_decision_id`
to bind worker execution to the specific decision that permitted it.

**Reproducibility:** `role_permissions_hash`,
`operation_policy_version`, and the evaluated-input flags allow
re-deriving the decision from the recorded inputs. This supports
post-hoc verification and dispute resolution.

---

## 11. Session tables

### `auth_sessions`

Principal-aware sessions replacing the current raw-session model. The
raw session token is never persisted; only its HMAC hash (W0-B §10).

```sql
CREATE TABLE auth_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    UUID        NOT NULL REFERENCES auth_principals(id),
  session_hash    text        NOT NULL UNIQUE,  -- HMAC(session_token, session_pepper_version)
  pepper_version  integer     NOT NULL,
  auth_epoch      bigint      NOT NULL,  -- principal's epoch at creation time
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip_address      inet,
  user_agent      text
);
```

**Index:**
```sql
CREATE UNIQUE INDEX ux_auth_sessions_hash
  ON auth_sessions (session_hash);

CREATE INDEX ix_auth_sessions_principal_active
  ON auth_sessions (principal_id)
  WHERE revoked_at IS NULL AND expires_at > now();
```

**Active predicate:** `revoked_at IS NULL AND expires_at > now() AND
auth_epoch = (principal's current epoch)`.

**Epoch invalidation:** when `auth_principals.auth_epoch` increments,
all sessions with the old epoch are effectively invalidated. The
application checks `session.auth_epoch = principal.auth_epoch` on every
request. No database UPDATE is needed to invalidate — the mismatch is
detected at lookup time.

---

## 12. Bootstrap tables and stored functions

### `auth_bootstrap_allow`

One-time markers that re-enable the bootstrap endpoint (W0-B §2). The
application DB role CANNOT write to this table directly — only the
operator DB role can INSERT.

```sql
CREATE TABLE auth_bootstrap_allow (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_secret_hash    text        NOT NULL,
  created_by_db_session   text        NOT NULL,  -- operator session identifier
  created_at              timestamptz NOT NULL DEFAULT now()
);
```

### `auth_bootstrap_state`

Single-row state table for the bootstrap state machine.

```sql
CREATE TABLE auth_bootstrap_state (
  id              integer     PRIMARY KEY DEFAULT 1,
  state           bootstrap_state NOT NULL DEFAULT 'enabled',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_single_row CHECK (id = 1)
);

INSERT INTO auth_bootstrap_state (id, state) VALUES (1, 'enabled')
  ON CONFLICT (id) DO NOTHING;
```

### Stored functions (SECURITY DEFINER)

The application DB role calls these functions to transition bootstrap
state. The functions are owned by the operator DB role and execute
with elevated privileges.

```sql
CREATE OR REPLACE FUNCTION transition_bootstrap_state(new_state text)
RETURNS void
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF new_state = 'enabled' THEN
    -- Verify a marker exists before enabling
    IF NOT EXISTS (SELECT 1 FROM auth_bootstrap_allow LIMIT 1) THEN
      RAISE EXCEPTION 'No bootstrap marker found — cannot enable';
    END IF;
  ELSIF new_state = 'disabled' THEN
    -- Consume (delete) all markers when disabling after successful bootstrap
    DELETE FROM auth_bootstrap_allow;
  ELSE
    RAISE EXCEPTION 'Invalid bootstrap state: %', new_state;
  END IF;

  UPDATE auth_bootstrap_state
    SET state = new_state::bootstrap_state, updated_at = now()
    WHERE id = 1;
END;
$$ LANGUAGE plpgsql;
```

**Privilege boundary:**
- Application DB role: `EXECUTE` on `transition_bootstrap_state`. No
  direct INSERT/UPDATE/DELETE on `auth_bootstrap_allow` or
  `auth_bootstrap_state`.
- Operator DB role: full access to `auth_bootstrap_allow` (INSERT),
  owns the stored function.

---

## 13. Ownership metadata for the query gateway

The mandatory query gateway (W0-B §8) needs
`installation_id`/`repository_id` on every installation-scoped and
repository-scoped table to enforce tenant filtering. Most existing
tables already have these columns. This section identifies the
supplemental columns needed.

### Existing columns (no change needed)

The following tables already have `installation_id` and/or
`repository_id`:
- `repositories` (has `installation_id`)
- `pull_requests`, `issues`, `ci_runs`, `branch_rules`,
  `repo_configs`, `heal_prs`, `managed_actions`, `fix_attempts`,
  `ai_reviews`, `dependency_manifests`, `vulnerability_advisories`,
  `flaky_tests`, `test_results`, `gate_evaluations`, `issue_embeddings`
  (have `repository_id` → parent `installation_id` via `repositories`)

### Supplemental ownership columns

Tables in the registry that may lack explicit `installation_id` will
receive it as an additive `ALTER TABLE ... ADD COLUMN` in migration
stage 4. The query gateway requires:

```sql
-- Every installation-scoped table MUST have installation_id.
-- Every repository-scoped table MUST have repository_id (from which
--   installation_id is derived via repositories.installation_id).
-- Ambiguous or unmapped ownership denies by default.
```

**Backfill rule:** for existing rows, `installation_id` is derived
from the record's known parent (e.g., a `policy_definition` belongs to
the installation that created it). Rows that cannot be mapped are
flagged in a `migration_report` table for human resolution and denied
by default until resolved.

---

## 14. Audit-event linkage

Existing audit tables (`audit_trail_entries`, `decision_log`) gain
principal/delegation/decision references:

```sql
-- audit_trail_entries gains:
ALTER TABLE audit_trail_entries
  ADD COLUMN principal_id UUID REFERENCES auth_principals(id),
  ADD COLUMN delegation_id UUID REFERENCES auth_delegations(id),
  ADD COLUMN authorization_decision_id UUID REFERENCES auth_authorization_decisions(id);

-- decision_log (the existing application-level log) gains:
ALTER TABLE decision_log
  ADD COLUMN principal_id UUID REFERENCES auth_principals(id),
  ADD COLUMN authorization_decision_id UUID REFERENCES auth_authorization_decisions(id);
```

These are nullable during the migration period (dual-write). After
full enforcement, they become NOT NULL.

**F-03 resolution (W0-A):** actor fields are derived from
`req.auth.principalId` (the authenticated principal), not from
client-supplied headers. The `principal_id` column is populated by
the application, never by the client.

---

## 15. Concurrency invariants summary

| Operation | Isolation level | Locking | Notes |
|-----------|----------------|---------|-------|
| Credential lookup | READ COMMITTED | none | `SELECT WHERE lookup_id = $1` |
| Role/grant evaluation | READ COMMITTED | none | `SELECT WHERE principal_id = $1 AND revoked_at IS NULL` |
| Role grant/revoke | READ COMMITTED | row-level | `INSERT` / `UPDATE SET revoked_at` |
| Delegation claim acquire | READ COMMITTED | row-level CAS | `UPDATE ... WHERE execution_version = $expected` |
| Delegation claim finalize | READ COMMITTED | row-level CAS | `UPDATE ... WHERE execution_attempt_id = $mine` |
| Ownership checkpoint | READ COMMITTED | none | `SELECT execution_attempt_id, execution_status` |
| JTI consumption | n/a (Redis) | Redis SET NX | Atomic, permanent |
| Bootstrap transition | SERIALIZABLE | function-level | `SECURITY DEFINER` stored function |
| Decision logging | READ COMMITTED | none | Append-only INSERT |

**Key invariant:** no two attempts can hold the same delegation's
execution claim simultaneously. The CAS condition
(`execution_version = :expected`) ensures atomicity without explicit
table-level locks. If the CAS fails (affected_rows = 0), the caller
receives `capability_delegation_in_use`.

---

## 16. Privilege model

### Application DB role (`gitwire_app`)

- `SELECT`, `INSERT`, `UPDATE` on: `auth_principals`,
  `auth_credentials`, `auth_roles`, `auth_role_permissions`,
  `auth_principal_roles`, `auth_resource_grants`,
  `auth_worker_ceilings`, `auth_delegations`,
  `auth_external_attestations`, `auth_authorization_decisions`,
  `auth_sessions`.
- `SELECT` on `auth_bootstrap_state`.
- `EXECUTE` on `transition_bootstrap_state`.
- **Cannot** INSERT/UPDATE/DELETE `auth_bootstrap_allow`.
- **Cannot** INSERT/UPDATE/DELETE `auth_bootstrap_state` directly.
- All existing application tables retain their current privileges.

### Operator DB role (`gitwire_operator`)

- `INSERT` on `auth_bootstrap_allow`.
- Owns `transition_bootstrap_state` function.
- **Cannot** authenticate to the application API.
- Used only for bootstrap re-enable and disaster recovery.

### Migration DB role (`gitwire_migration`)

- Runs DDL migrations (`CREATE TABLE`, `CREATE INDEX`, `CREATE TYPE`,
  `CREATE FUNCTION`).
- Seeds built-in roles and permissions.
- **Cannot** create principals, credentials, or grants (those are
  application-level operations post-migration).

```sql
-- Stage 1 migration privileges
GRANT USAGE ON SCHEMA public TO gitwire_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gitwire_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO gitwire_app;

-- Bootstrap tables: application can only SELECT state, not write
REVOKE INSERT, UPDATE, DELETE ON auth_bootstrap_allow, auth_bootstrap_state FROM gitwire_app;
GRANT SELECT ON auth_bootstrap_state TO gitwire_app;

-- Operator can INSERT bootstrap markers
GRANT INSERT ON auth_bootstrap_allow TO gitwire_operator;
```

---

## 17. Migration plan — additive 10-stage sequence

Each stage is a numbered migration file (`038_*.sql` through `047_*.sql`).
Every stage is independently reversible (rollback = `DROP TABLE` /
`DROP COLUMN` / `DROP FUNCTION` for additive objects). No stage modifies
existing runtime behavior.

### Stage 1 (038): Enum and domain creation

Creates all `CREATE TYPE` enums and the resource-type validation table.

```sql
-- 038_auth_enums.sql
-- All CREATE TYPE statements from §2.
-- Creates auth_resource_types(text) lookup table seeded with 57 tokens.
```

**Rollback:** `DROP TYPE` each enum; `DROP TABLE auth_resource_types`.
**Risk:** none — purely additive types.

### Stage 2 (039): Core identity tables

Creates `auth_principals`, `auth_credentials`, `auth_roles`,
`auth_role_permissions`, `auth_principal_roles`.

```sql
-- 039_auth_identity_tables.sql
-- All CREATE TABLE from §3, §4, §5.
-- Seeds built-in roles (admin, operator, reviewer, viewer, legacy-key)
--   and their permission sets from the W0-B role table.
```

**Rollback:** `DROP TABLE` in reverse dependency order.
**Risk:** low — tables are empty, no existing code references them.

### Stage 3 (040): Authorization tables

Creates `auth_resource_grants`, `auth_worker_ceilings`,
`auth_authorization_decisions`, `auth_sessions`.

```sql
-- 040_auth_authorization_tables.sql
-- All CREATE TABLE from §6, §7, §10, §11.
```

**Rollback:** `DROP TABLE` in reverse dependency order.
**Risk:** low — empty tables.

### Stage 4 (041): Delegation and attestation tables

Creates `auth_delegations`, `auth_external_attestations`.

```sql
-- 041_auth_delegation_tables.sql
-- All CREATE TABLE from §8, §9.
-- Includes execution-claim CAS fields.
```

**Rollback:** `DROP TABLE auth_external_attestations; DROP TABLE auth_delegations`.
**Risk:** low — empty tables.

### Stage 5 (042): Bootstrap tables and stored functions

Creates `auth_bootstrap_allow`, `auth_bootstrap_state`,
`transition_bootstrap_state`.

```sql
-- 042_auth_bootstrap.sql
-- All CREATE TABLE and CREATE FUNCTION from §12.
-- Seeds auth_bootstrap_state with ('enabled') for fresh deploys,
--   or ('disabled') for existing deploys with admins.
-- Sets privileges (REVOKE direct write from app; GRANT EXECUTE).
```

**Rollback:** `DROP FUNCTION transition_bootstrap_state; DROP TABLE`.
**Risk:** low — stored function, no existing code calls it.

### Stage 6 (043): Ownership metadata backfill

Adds `installation_id` to installation-scoped tables that lack it.
Backfills from known parent relationships.

```sql
-- 043_ownership_backfill.sql
-- ALTER TABLE ... ADD COLUMN installation_id bigint;
-- UPDATE ... SET installation_id = (derived from parent);
-- Creates migration_report table for unmapped rows.
```

**Rollback:** `ALTER TABLE ... DROP COLUMN installation_id`.
**Risk:** **medium** — backfill may encounter unmapped rows. These are
reported and denied by default. No implicit authority is created.

### Stage 7 (044): Audit linkage columns

Adds `principal_id`, `delegation_id`, `authorization_decision_id` to
`audit_trail_entries` and `decision_log`.

```sql
-- 044_audit_linkage.sql
-- ALTER TABLE ... ADD COLUMN (nullable).
```

**Rollback:** `ALTER TABLE ... DROP COLUMN`.
**Risk:** low — nullable columns, dual-write starts later.

### Stage 8 (045): Legacy-key fingerprinting and backfill

Creates `auth_principals` records for each existing shared-key
fingerprint. Maps to explicit installation scope. No fleet default.

```sql
-- 045_legacy_key_backfill.sql
-- For each existing API key fingerprint:
--   INSERT INTO auth_principals (principal_type='legacy-key', ...);
--   INSERT INTO auth_principal_roles (scope_type='installation', scope_id=<mapped>);
-- Unmapped keys: INSERT INTO migration_report (status='unmapped_legacy_key').
```

**Rollback:** `DELETE FROM auth_principal_roles WHERE principal_id IN (legacy principals); DELETE FROM auth_principals WHERE principal_type = 'legacy-key'`.
**Risk:** **medium** — requires accurate key-to-installation mapping.
Unmapped keys are reported and denied by default.

### Stage 9 (046): Worker and service-identity seeding

Creates `auth_principals` (type='service') and `auth_worker_ceilings`
for each of the 14 workers + reconciler + executor-service + bot.

```sql
-- 046_worker_identity_seed.sql
-- INSERT INTO auth_principals (principal_type='service', ...) for each worker;
-- INSERT INTO auth_worker_ceilings (...) with permission arrays from W0-B §5 role table.
```

**Rollback:** `DELETE FROM auth_worker_ceilings; DELETE FROM auth_principals WHERE principal_type = 'service'`.
**Risk:** low — identity seeding, no existing code references yet.

### Stage 10 (047): Observe-only integration gate

Creates a feature-flag table (or uses existing config) to control
observe-only vs. enforce mode. In observe-only mode, the authorization
evaluator runs and logs decisions but does not deny.

```sql
-- 047_auth_observe_mode.sql
-- CREATE TABLE auth_enforcement_mode (mode text DEFAULT 'observed');
-- INSERT INTO auth_enforcement_mode VALUES ('observed');
```

**Rollback:** `DROP TABLE auth_enforcement_mode`.
**Risk:** none — this is a flag, not enforcement. The application reads
this to decide whether to enforce or only observe.

### Rollback boundaries summary

| Stage | Rollback action | Data loss? | Safe after enforcement? |
|-------|----------------|------------|------------------------|
| 1-5 | DROP objects | no (empty) | yes |
| 6 | DROP COLUMN | yes (backfill data) | **no** — must retire enforcement first |
| 7 | DROP COLUMN | no (nullable) | yes |
| 8 | DELETE rows | yes (legacy mapping) | **no** — must retire legacy auth first |
| 9 | DELETE rows | yes (worker identity) | **no** — must retire ceiling checks first |
| 10 | DROP table | no (flag) | yes |

**Hard rollback boundary:** stages 6, 8, and 9 are irreversible once
enforcement is active. They must be retired (legacy auth path removed,
enforcement mode switched) before rollback. The migration plan is
designed so that stages 1–5 and 7 and 10 are always safe to roll back.

---

## 18. Proof obligations and fixtures

Each fixture proves the schema can represent a specific W0-B decision
case. Fixtures are expressed as DML examples against the proposed DDL.

### Fixture 1: Scope-product truth-table case T3

**Case:** fleet role + finite repository credential restriction.
**Expected:** `installation = P(R)`, `repository = R`, `fleet = false`.

```sql
-- Principal with fleet role
INSERT INTO auth_principals (id, principal_type, display_name)
  VALUES ('p-fleet', 'user', 'Fleet Admin');
INSERT INTO auth_principal_roles (principal_id, role_id, scope_type)
  VALUES ('p-fleet', 'role-admin', 'fleet');

-- Credential restricted to repos {10, 20} (parent installations {1, 2})
INSERT INTO auth_credentials (id, principal_id, lookup_id, secret_hash,
  pepper_version, audience, repository_ids)
  VALUES ('cred-r10-20', 'p-fleet', 'lookup-1', 'hash-1', 1, 'gitwire-app',
    ARRAY[10, 20]::bigint[]);

-- Proof: the evaluator derives:
--   scope.fleet = true (from role) → false (credential collapses fleet)
--   scope.repository = ALL → SET({10, 20}) (credential intersection)
--   scope.installation = ALL → P({10, 20}) = {1, 2} (survivor-based)
-- The schema stores repository_ids as bigint[] and the evaluator
-- computes the intersection at runtime.
```

### Fixture 2: `read` without `list` denial

**Case:** custom role with `repository:read` but NOT `repository:list`.
**Expected:** `repository:list` → `role_permission_missing`.

```sql
INSERT INTO auth_roles (id, name) VALUES ('role-read-only', 'read-only');
INSERT INTO auth_role_permissions (role_id, permission)
  VALUES ('role-read-only', 'repository:read');
-- Note: NO 'repository:list' entry.

-- Proof: evaluate_leaf for action='repository:list' checks
--   if 'repository:list' NOT IN (SELECT permission FROM auth_role_permissions
--                                 WHERE role_id = 'role-read-only')
--   → DENY(role_permission_missing)
-- The schema enforces this because auth_role_permissions is an exact
-- set — no implicit inheritance.
```

### Fixture 3: Create destination-container enforcement

**Case:** operator attempts to create a `policy_waiver` in installation
99 but their grant is scoped to installation 42.
**Expected:** `resource_not_found` (destination outside tenant scope).

```sql
-- Operator scoped to installation 42
INSERT INTO auth_resource_grants (principal_id, resource_type, scope_type,
  scope_id, action, effect)
  VALUES ('p-op', 'policy_waiver', 'installation', 42, 'create', 'allow');

-- Proof: resolve_target for selector='create' resolves the container
-- from the route body. If the body specifies installation_id=99,
-- the container's installation_id (99) != grant's scope_id (42).
-- grant_matches_target fails → resource_not_found.
-- The schema stores scope_id as bigint, enabling exact comparison.
```

### Fixture 4: Explicit deny precedence

**Case:** operator has an allow grant on `repository:update` at
installation scope, but a deny grant on the same action at specific
resource scope.
**Expected:** `explicit_deny`.

```sql
-- Allow at installation scope
INSERT INTO auth_resource_grants (principal_id, resource_type, scope_type,
  scope_id, action, effect)
  VALUES ('p-op', 'repository', 'installation', 42, 'update', 'allow');

-- Deny at specific resource scope
INSERT INTO auth_resource_grants (principal_id, resource_type, resource_id,
  scope_type, scope_id, action, effect)
  VALUES ('p-op', 'repository', '100', 'repository', 100, 'update', 'deny');

-- Proof: evaluate_leaf checks deny grants first. The deny grant on
-- resource_id='100' matches the target instance. The more-specific
-- deny overrides the less-specific allow.
```

### Fixture 5: Mixed UUID/text/bigint resource identifiers

**Case:** grants on a bigint-identified resource (`repository:100`),
a UUID-identified resource (`auth_principal:abc-123`), and a
text-identified resource (`webhook_delivery:del-xyz`).

```sql
INSERT INTO auth_resource_grants (principal_id, resource_type, resource_id,
  scope_type, action, effect)
  VALUES ('p-admin', 'repository', '100', 'fleet', 'read', 'allow');

INSERT INTO auth_resource_grants (principal_id, resource_type, resource_id,
  scope_type, action, effect)
  VALUES ('p-admin', 'auth_principal', 'abc-123-def', 'system', 'manage', 'allow');

INSERT INTO auth_resource_grants (principal_id, resource_type, resource_id,
  scope_type, action, effect)
  VALUES ('p-admin', 'webhook_delivery', 'del-xyz-789', 'fleet', 'read', 'allow');

-- Proof: resource_id is text, accommodating all three identifier types.
-- The evaluator casts to the appropriate type during resolve_target.
```

### Fixture 6: Worker ceiling + delegation intersection

**Case:** heal-worker executes under delegation. Ceiling includes
`repository:github:act`; delegation authorizes repo X.
**Expected:** ALLOW (both evaluations pass).

```sql
-- Worker ceiling
INSERT INTO auth_worker_ceilings (principal_id, role_name, permissions)
  VALUES ('p-heal-worker', 'service:heal-worker',
    ARRAY['repository:github:act', 'ci_run:update', 'heal_pr:update', 'managed_action:update']);

-- Delegation
INSERT INTO auth_delegations (id, initiating_principal_id,
  worker_service_principal_id, operation, resource_type, resource_id,
  authorization_decision_id, expires_at)
  VALUES ('del-1', 'p-op', 'p-heal-worker', 'heal-run', 'repository', '100',
    'dec-1', now() + interval '1 hour');

-- Proof: Evaluation A (delegation) and Evaluation B (ceiling) both ALLOW.
-- The schema stores ceiling permissions as text[] and delegation
-- resource_type/resource_id as text.
```

### Fixture 7: Duplicate/old-owner execution-claim rejection

**Case:** attempt A acquires the claim. Attempt B (old, paused) tries
to finalize.
**Expected:** attempt B's finalize CAS fails (affected_rows = 0).

```sql
-- Attempt A acquires claim
UPDATE auth_delegations
  SET execution_status = 'executing',
      execution_attempt_id = 'attempt-A',
      execution_version = 1,
      execution_started_at = now()
  WHERE id = 'del-1'
    AND execution_status IN ('pending', 'completed', 'cancelled')
    AND execution_version = 0;
-- affected_rows = 1 → success

-- Attempt B (old) tries to finalize
UPDATE auth_delegations
  SET execution_status = 'completed'
  WHERE id = 'del-1'
    AND execution_attempt_id = 'attempt-B'  -- wrong owner
    AND execution_status = 'executing';
-- affected_rows = 0 → rejected (attempt B does not own the claim)

-- Proof: the CAS condition on execution_attempt_id prevents an old
-- attempt from finalizing a newer attempt's claim.
```

### Fixture 8: Denied delegation non-reacquisition

**Case:** delegation is `denied`. A new attempt tries to acquire.
**Expected:** CAS fails (denied is not acquirable).

```sql
UPDATE auth_delegations SET execution_status = 'denied' WHERE id = 'del-2';

-- New attempt tries to acquire
UPDATE auth_delegations
  SET execution_status = 'executing',
      execution_attempt_id = 'attempt-C',
      execution_version = 1
  WHERE id = 'del-2'
    AND execution_status IN ('pending', 'completed', 'cancelled')  -- denied NOT in list
    AND execution_version = 0;
-- affected_rows = 0 → denied delegation cannot reacquire

-- Proof: the CAS condition explicitly excludes 'denied' from the
-- acquirable set.
```

### Fixture 9: Queue-job exclusion from resource grants

**Case:** no `auth_resource_grants` entry for `queue_job` exists.
Worker ceiling references `queue_job:enqueue`.
**Expected:** ceiling check passes; no resource grant needed.

```sql
-- No INSERT into auth_resource_grants for resource_type='queue_job'.
-- The evaluator never checks resource grants for transport-scoped resources.

-- Worker ceiling includes queue_job:enqueue
INSERT INTO auth_worker_ceilings (principal_id, role_name, permissions)
  VALUES ('p-patch-worker', 'service:patch-worker',
    ARRAY['patch_artifact:create', 'repair_proposal_event:update', 'queue_job:enqueue']);

-- Proof: the schema allows queue_job in auth_worker_ceilings.permissions
-- (text[]), but the evaluator's grant_matches_target function never
-- queries auth_resource_grants for transport-scoped resource types.
```

### Fixture 10: Unmapped legacy-key denial

**Case:** legacy key with no installation mapping.
**Expected:** `unmapped_legacy_key`.

```sql
-- Legacy-key principal with no auth_principal_roles entry
INSERT INTO auth_principals (id, principal_type, display_name)
  VALUES ('p-legacy-unmapped', 'legacy-key', 'Unmapped Legacy Key');
-- NO auth_principal_roles INSERT.

-- Proof: STEP 2 derives scope = {installation: NONE, repository: NONE,
-- fleet: false, system: false}. Phase 4 visibility check fails.
-- Additionally, the legacy-key path checks for explicit mapping and
-- returns unmapped_legacy_key before the generic visibility check.
```

### Fixture 11: Bootstrap re-enable and consume transitions

**Case:** operator inserts marker → application transitions to enabled
→ successful bootstrap → transitions to disabled → marker consumed.

```sql
-- Operator inserts marker
INSERT INTO auth_bootstrap_allow (consumer_secret_hash, created_by_db_session)
  VALUES ('hash-of-secret', 'operator-session-1');

-- Application detects marker, calls stored function
SELECT transition_bootstrap_state('enabled');
-- Function verifies marker exists, transitions state to 'enabled'.

-- Successful bootstrap creates admin principal...
-- Application calls:
SELECT transition_bootstrap_state('disabled');
-- Function transitions to 'disabled' AND deletes the marker.

-- Proof: second call to transition_bootstrap_state('enabled') fails
-- because the marker was consumed (deleted) in the previous transition.
SELECT transition_bootstrap_state('enabled');
-- ERROR: No bootstrap marker found — cannot enable
```

### Fixture 12: External-attestation expiry/revocation binding

**Case:** GitHub attestation created at ingress with 5-minute TTL.
Worker evaluates at dequeue (6 minutes later).
**Expected:** `attestation_not_found` (expired).

```sql
INSERT INTO auth_external_attestations (id, principal_id, provider,
  subject, subject_id, repository_id, permission, command, delegation_id,
  verified_at, expires_at)
  VALUES ('att-1', 'p-user', 'github', 'octocat', 12345, 67890,
    'COLLABORATOR', 'fix-issue', 'del-3', now(), now() + interval '5 minutes');

-- At dequeue (6 minutes later):
SELECT 1 FROM auth_external_attestations
  WHERE provider = 'github'
    AND subject_id = 12345
    AND repository_id = 67890
    AND command = 'fix-issue'
    AND delegation_id = 'del-3'
    AND expires_at > now();
-- Returns 0 rows (expired) → attestation_not_found

-- Proof: the expires_at > now() condition in the valid predicate
-- and the partial index ensure expired attestations are invisible
-- to the evaluator.
```

---

## 19. Unresolved schema risks

### Risk 1: `auth_resource_types` validation table vs. CHECK constraint

The 57-resource registry could be enforced via a lookup table with a
FK, or via a large `CHECK (resource_type IN (...))` constraint. The
lookup table is more maintainable (W0-D may add resources); the CHECK
is more performant (no JOIN). **Recommendation:** lookup table with
application-layer caching; revisit in W0-D.

### Risk 2: Credential restriction array vs. junction table

Credential `installation_ids`/`repository_ids` are stored as `bigint[]`
arrays. An alternative is a junction table
(`auth_credential_restrictions`). Arrays are simpler and faster for
the intersection algebra; junction tables are more normalized.
**Recommendation:** arrays for now (the intersection is always a
set operation); revisit if restriction sets grow large.

### Risk 3: `auth_authorization_decisions` volume

Every authorization decision produces a row. At GitWire's current scale
(hundreds of requests/minute), this table grows rapidly. Partitioning
by time (e.g., monthly) should be considered before enforcement.
**Recommendation:** add table partitioning in the enforcement
migration (not W0-C scope); document the partitioning strategy in W0-D.

### Risk 4: Ownership backfill for ambiguous records

Stage 6 backfill may encounter records without a clear
`installation_id` (e.g., system-created records, historical data).
These are reported in `migration_report` and denied by default.
**Risk:** legitimate data may become inaccessible if the backfill is
incomplete. **Mitigation:** the observe-only mode (stage 10) runs
before enforcement, surfacing these cases without denying access.

### Risk 5: Legacy-key-to-installation mapping accuracy

Stage 8 requires mapping existing shared API keys to specific
installations. If the mapping is incomplete or incorrect, legitimate
clients may be denied or over-scoped. **Mitigation:** the mapping is
audited, time-bounded, and reversible (stage 8 rollback is available
until enforcement is active).

### Risk 6: Delegation `authorization_decision_id` FK

`auth_delegations.authorization_decision_id` references
`auth_authorization_decisions.id`, but the decisions table is created
in stage 3 while delegations are created in stage 4. The FK is added
in stage 4. If stage 3 is rolled back after stage 4, the FK is
orphaned. **Mitigation:** migration ordering is strictly sequential;
stage 4 cannot run without stage 3.

---

*End of W0-C schema and migration plan. This document is
documentation-only. No executable migrations are created. No database
is altered. W0-D (ADRs and validation plan) remains blocked until W0-C
is explicitly accepted.*
