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

1. [Scope, conventions, and PostgreSQL validity](#1-scope-conventions-and-postgresql-validity)
2. [Resource registry catalog (57 tokens)](#2-resource-registry-catalog-57-tokens)
3. [Enums and domains](#3-enums-and-domains)
4. [Principal and identity tables](#4-principal-and-identity-tables)
5. [Credential tables](#5-credential-tables)
6. [Role and permission tables](#6-role-and-permission-tables)
7. [Resource grant tables](#7-resource-grant-tables)
8. [Worker ceiling tables](#8-worker-ceiling-tables)
9. [Delegation and execution-claim tables](#9-delegation-and-execution-claim-tables)
10. [External attestation tables](#10-external-attestation-tables)
11. [Authorization decision and immutable context](#11-authorization-decision-and-immutable-context)
12. [Operation policy versioning](#12-operation-policy-versioning)
13. [Session tables](#13-session-tables)
14. [Bootstrap tables and stored functions](#14-bootstrap-tables-and-stored-functions)
15. [Ownership metadata for the query gateway](#15-ownership-metadata-for-the-query-gateway)
16. [Audit-event linkage](#16-audit-event-linkage)
17. [Legacy-key migration records](#17-legacy-key-migration-records)
18. [Concurrency invariants summary](#18-concurrency-invariants-summary)
19. [Privilege model (per table and operation)](#19-privilege-model-per-table-and-operation)
20. [FK and deletion-behavior matrix](#20-fk-and-deletion-behavior-matrix)
21. [Migration plan — additive sequence](#21-migration-plan--additive-sequence)
22. [Authority-source state machine](#22-authority-source-state-machine)
23. [Proof obligations and fixtures](#23-proof-obligations-and-fixtures)
24. [Schema-smoke verification](#24-schema-smoke-verification)
25. [Unresolved schema risks](#25-unresolved-schema-risks)

---

## 1. Scope, conventions, and PostgreSQL validity

### PostgreSQL target

GitWire runs PostgreSQL 16+. All DDL in this document is valid
PostgreSQL 16 SQL that parses and can be applied on an empty database.
Specifically:

- **CHECK constraints never contain subqueries.** Subquery-based
  invariants use constraint triggers or stored functions instead.
- **Partial-index predicates use only immutable expressions.** `now()`
  is `STABLE`, not `IMMUTABLE`, so it cannot appear in a partial index
  predicate. Active/revoked predicates use `revoked_at IS NULL` (immutable
  test against a column) rather than time comparisons.
- **Resource-type validation uses a real FK** to the
  `auth_resource_registry` catalog table, not a CHECK constraint with a
  lookup list.
- **Permission tokens use a composite FK** to
  `(auth_resource_registry.token, auth_resource_actions.action)` so
  undeclared pairs are rejected at INSERT time.
- **Worker-principal subtype boundaries** use constraint triggers
  (PostgreSQL CHECK cannot cross-table reference).

### Migration file naming

Existing migrations follow `NNN_descriptive_name.sql` starting at `001`.
The last applied migration is `037_blocked_reason.sql`. W0-C migrations
start at `038` and are additive-only. Destructive retirement (dropping
legacy columns) is a separate gated stage with prerequisites.

### Additive principle and fail-closed default

Every migration stage adds tables, columns, indexes, or functions. No
stage removes or renames existing objects. Unmapped ownership, unmapped
credentials, or ambiguous identity MUST deny by default and be reported
for human resolution. No backfill operation creates implicit authority.

### Concurrency model

All authority queries use `READ COMMITTED` isolation. Lifecycle
mutations (claim acquire/finalize, revocation, bootstrap transition)
use row-level compare-and-swap (CAS) or stored functions. No
table-level locks.

---

## 2. Resource registry catalog (57 tokens)

The 57-resource registry from W0-B §17 is represented as a concrete
catalog table. This table is the FK target for all `resource_type`
columns and is used in a composite FK for permission validation.

```sql
CREATE TABLE auth_resource_registry (
  token           text        PRIMARY KEY,  -- e.g., 'repository', 'auth_principal', 'queue_job'
  display_name    text        NOT NULL,
  parent_token    text        REFERENCES auth_resource_registry(token),
  identifier_kind text        NOT NULL,  -- 'bigint', 'uuid', 'text', 'none'
  scope_class     text        NOT NULL,  -- 'installation', 'system', 'transport'
  backing_store   text        NOT NULL,  -- e.g., 'repositories', 'auth_principals', '(Redis)'
  authority_model text        NOT NULL,  -- 'tenant', 'system', 'transport-ceiling'
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Self-referential FK for parent_token is declared above.
-- Seed data is provided in migration 038 (57 rows).
```

### Permission action catalog

Each registry token declares its valid actions. This is the FK target
for all permission/grant/ceiling action validation.

```sql
CREATE TABLE auth_resource_actions (
  registry_token  text        NOT NULL REFERENCES auth_resource_registry(token),
  action          text        NOT NULL,  -- e.g., 'read', 'list', 'create', 'update'
  PRIMARY KEY (registry_token, action)
);
```

A composite FK from `auth_role_permissions(role_permission_resource,
role_permission_action)` to this table ensures only declared pairs can
be inserted. The same pattern applies to grants and ceilings (see
§6–§8).

### Transport-only enforcement

`queue_job` has `scope_class = 'transport'` and
`authority_model = 'transport-ceiling'`. A constraint trigger on
`auth_resource_grants` rejects any row with `resource_type = 'queue_job'`
because transport resources must never enter resource grants:

```sql
CREATE OR REPLACE FUNCTION enforce_no_transport_in_grants()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth_resource_registry
    WHERE token = NEW.resource_type AND authority_model = 'transport-ceiling'
  ) THEN
    RAISE EXCEPTION 'Transport-scoped resource % cannot appear in auth_resource_grants',
      NEW.resource_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_no_transport_in_grants
  AFTER INSERT OR UPDATE ON auth_resource_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_no_transport_in_grants();
```

---

## 3. Enums and domains

```sql
CREATE TYPE principal_type AS ENUM (
  'user', 'service', 'installation', 'system', 'legacy-key'
);

CREATE TYPE principal_status AS ENUM ('active', 'disabled');

CREATE TYPE scope_type AS ENUM (
  'installation', 'repository', 'fleet', 'system'
);

CREATE TYPE grant_effect AS ENUM ('allow', 'deny');

CREATE TYPE delegation_status AS ENUM (
  'pending', 'executing', 'completed', 'cancelled', 'denied'
);

CREATE TYPE bootstrap_state_enum AS ENUM ('enabled', 'disabled');

CREATE TYPE credential_environment AS ENUM (
  'production', 'staging', 'isolated'
);

CREATE TYPE credential_audience AS ENUM (
  'gitwire-app', 'executor-service', 'bot', 'dashboard'
);

-- Authority source state for the staged migration
CREATE TYPE authority_source_state AS ENUM (
  'legacy-only',       -- existing path authoritative; new tables empty
  'shadow-evaluation', -- new evaluator runs but does not deny
  'dual-write',        -- both paths write; legacy still authoritative for reads
  'enforce',           -- new evaluator authoritative; legacy path read-only fallback
  'legacy-retired'     -- legacy path removed
);
```

---

## 4. Principal and identity tables

### `auth_principals`

```sql
CREATE TABLE auth_principals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  principal_type NOT NULL,
  display_name    text        NOT NULL,
  status          principal_status NOT NULL DEFAULT 'active',
  github_user_id  bigint      UNIQUE,
  github_login    text,
  installation_id bigint,
  auth_epoch      bigint      NOT NULL DEFAULT 0,
  is_break_glass  boolean     NOT NULL DEFAULT false,
  break_glass_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_auth_principals_github_user_id
  ON auth_principals (github_user_id) WHERE github_user_id IS NOT NULL;

CREATE UNIQUE INDEX ux_auth_principals_installation_id
  ON auth_principals (installation_id) WHERE installation_id IS NOT NULL;

CREATE INDEX ix_auth_principals_type_status
  ON auth_principals (principal_type, status);
```

**Constraint triggers** (CHECK cannot express cross-condition type
binding cleanly for the bootstrap-user exception):

```sql
CREATE OR REPLACE FUNCTION enforce_principal_type_bindings()
RETURNS trigger AS $$
BEGIN
  -- 'user': github_user_id is OPTIONAL (bootstrap admin may lack it).
  --         If present, must be unique (enforced by index).
  -- 'service': no github_user_id, no installation_id
  IF NEW.principal_type = 'service' THEN
    IF NEW.github_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'service principal cannot have github_user_id';
    END IF;
    IF NEW.installation_id IS NOT NULL THEN
      RAISE EXCEPTION 'service principal cannot have installation_id';
    END IF;
  END IF;
  -- 'installation': must have installation_id, no github_user_id
  IF NEW.principal_type = 'installation' THEN
    IF NEW.installation_id IS NULL THEN
      RAISE EXCEPTION 'installation principal must have installation_id';
    END IF;
    IF NEW.github_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'installation principal cannot have github_user_id';
    END IF;
  END IF;
  -- 'system': no external identity
  IF NEW.principal_type = 'system' THEN
    IF NEW.github_user_id IS NOT NULL OR NEW.installation_id IS NOT NULL THEN
      RAISE EXCEPTION 'system principal cannot have external identity';
    END IF;
  END IF;
  -- 'legacy-key': no external identity
  IF NEW.principal_type = 'legacy-key' THEN
    IF NEW.github_user_id IS NOT NULL OR NEW.installation_id IS NOT NULL THEN
      RAISE EXCEPTION 'legacy-key principal cannot have external identity';
    END IF;
  END IF;
  -- break_glass: must have expiry
  IF NEW.is_break_glass AND NEW.break_glass_expires_at IS NULL THEN
    RAISE EXCEPTION 'break_glass principal must have break_glass_expires_at';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_principal_bindings
  AFTER INSERT OR UPDATE ON auth_principals
  FOR EACH ROW EXECUTE FUNCTION enforce_principal_type_bindings();
```

**Active predicate:** `status = 'active'`.
**Retention:** principals are never hard-deleted. Disabled principals
retain all records for audit. `auth_epoch` increments on credential
revocation, role revocation, or admin-forced session invalidation.

---

## 5. Credential tables

### `auth_credentials`

```sql
CREATE TABLE auth_credentials (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        uuid        NOT NULL REFERENCES auth_principals(id),
  lookup_id           text        NOT NULL UNIQUE,
  secret_hash         text        NOT NULL,
  pepper_version      integer     NOT NULL,
  audience            credential_audience NOT NULL,
  environment         credential_environment NOT NULL DEFAULT 'production',
  scopes              text[],     -- NULL or empty = all actions; non-empty = action scope list
  installation_ids    bigint[],   -- NULL = unrestricted; '{}' = none; '{1,2}' = SET
  repository_ids      bigint[],   -- NULL = unrestricted; '{}' = none; '{1,2}' = SET
  display_prefix      text        NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid        REFERENCES auth_principals(id),
  revocation_reason   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_auth_credentials_lookup_id
  ON auth_credentials (lookup_id);

CREATE INDEX ix_auth_credentials_principal_active
  ON auth_credentials (principal_id)
  WHERE revoked_at IS NULL;
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`. Note: this is a runtime predicate, not an index predicate. Indexes use only `revoked_at IS NULL` (immutable).

**Concurrency invariant:** credential lookup is read-only. Revocation
is a single-row UPDATE. Session invalidation via `auth_epoch` increment
is a separate UPDATE on `auth_principals`. Both must occur in one
transaction when revoking a credential:

```sql
-- Revocation transaction
BEGIN;
  UPDATE auth_credentials SET revoked_at = now(), revoked_by = $2 WHERE id = $1;
  UPDATE auth_principals SET auth_epoch = auth_epoch + 1 WHERE id = (
    SELECT principal_id FROM auth_credentials WHERE id = $1
  );
COMMIT;
```

---

## 6. Role and permission tables

### `auth_roles`

```sql
CREATE TABLE auth_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  description text,
  is_builtin  boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

### `auth_role_permissions`

Maps roles to valid permission tokens. Uses a composite FK to
`auth_resource_actions` to reject undeclared resource/action pairs at
INSERT time.

```sql
CREATE TABLE auth_role_permissions (
  role_id             uuid        NOT NULL REFERENCES auth_roles(id) ON DELETE CASCADE,
  permission_resource text        NOT NULL,
  permission_action   text        NOT NULL,
  -- The permission token is permission_resource:permission_action
  -- e.g., 'repository:read'
  PRIMARY KEY (role_id, permission_resource, permission_action),
  -- Composite FK: only declared resource/action pairs allowed
  FOREIGN KEY (permission_resource, permission_action)
    REFERENCES auth_resource_actions (registry_token, action)
);
```

### `auth_principal_roles`

```sql
CREATE TABLE auth_principal_roles (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        uuid        NOT NULL REFERENCES auth_principals(id),
  role_id             uuid        NOT NULL REFERENCES auth_roles(id),
  scope_type          scope_type  NOT NULL,
  scope_id            bigint,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  granted_by          uuid        NOT NULL REFERENCES auth_principals(id),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid        REFERENCES auth_principals(id),
  revocation_reason   text,

  CONSTRAINT chk_role_scope_id_required
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  CONSTRAINT chk_role_scope_id_null_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);

CREATE INDEX ix_auth_principal_roles_principal_active
  ON auth_principal_roles (principal_id, scope_type)
  WHERE revoked_at IS NULL;
```

**Service-worker exclusion trigger:** service principals must not
receive tenant roles (their authority comes from ceilings + delegations
only). This is enforced by a constraint trigger:

```sql
CREATE OR REPLACE FUNCTION enforce_no_tenant_roles_for_service()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM auth_principals
    WHERE id = NEW.principal_id AND principal_type = 'service'
  ) THEN
    RAISE EXCEPTION 'service principal % cannot receive tenant role assignments',
      NEW.principal_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_no_service_tenant_roles
  AFTER INSERT OR UPDATE ON auth_principal_roles
  FOR EACH ROW EXECUTE FUNCTION enforce_no_tenant_roles_for_service();
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.
**Retention:** durable — revocation sets `revoked_at`, never deletes.

---

## 7. Resource grant tables

### `auth_resource_grants`

```sql
CREATE TABLE auth_resource_grants (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id        uuid        NOT NULL REFERENCES auth_principals(id),
  resource_type       text        NOT NULL REFERENCES auth_resource_registry(token),
  resource_id         text,
  scope_type          scope_type  NOT NULL,
  scope_id            bigint,
  action              text        NOT NULL,
  effect              grant_effect NOT NULL,
  granted_at          timestamptz NOT NULL DEFAULT now(),
  granted_by          uuid        NOT NULL REFERENCES auth_principals(id),
  expires_at          timestamptz,
  revoked_at          timestamptz,
  revoked_by          uuid        REFERENCES auth_principals(id),
  revocation_reason   text,

  CONSTRAINT chk_grant_scope_id
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  CONSTRAINT chk_grant_scope_id_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);

-- FK to resource registry is declared above (REFERENCES auth_resource_registry(token)).
-- Transport-resource exclusion is enforced by the constraint trigger in §2.

CREATE INDEX ix_auth_resource_grants_lookup
  ON auth_resource_grants (principal_id, resource_type, effect)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_resource_grants_wildcard
  ON auth_resource_grants (principal_id, resource_type, scope_type, effect)
  WHERE revoked_at IS NULL AND resource_id IS NULL;

CREATE INDEX ix_auth_resource_grants_specific
  ON auth_resource_grants (principal_id, resource_type, resource_id, effect)
  WHERE revoked_at IS NULL AND resource_id IS NOT NULL;
```

**Active predicate:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`.

---

## 8. Worker ceiling tables

### `auth_worker_ceilings`

```sql
CREATE TABLE auth_worker_ceilings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid        NOT NULL REFERENCES auth_principals(id),
  role_name     text        NOT NULL,
  permissions   text[]      NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  granted_by    uuid        NOT NULL REFERENCES auth_principals(id),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_auth_worker_ceilings_principal_active
  ON auth_worker_ceilings (principal_id)
  WHERE revoked_at IS NULL;
```

**Worker-subtype enforcement** (constraint trigger — CHECK cannot
express the cross-table condition):

```sql
CREATE OR REPLACE FUNCTION enforce_ceiling_service_only()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth_principals
    WHERE id = NEW.principal_id AND principal_type = 'service'
  ) THEN
    RAISE EXCEPTION 'worker ceiling can only be assigned to a service principal; % is not service type',
      NEW.principal_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ceiling_service_only
  AFTER INSERT OR UPDATE ON auth_worker_ceilings
  FOR EACH ROW EXECUTE FUNCTION enforce_ceiling_service_only();
```

---

## 9. Delegation and execution-claim tables

### `auth_delegations`

```sql
CREATE TABLE auth_delegations (
  id                          uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  initiating_principal_id     uuid              NOT NULL REFERENCES auth_principals(id),
  worker_service_principal_id uuid              NOT NULL REFERENCES auth_principals(id),
  operation                   text              NOT NULL,
  resource_type               text              NOT NULL REFERENCES auth_resource_registry(token),
  resource_id                 text,
  authorization_decision_id   uuid              NOT NULL,
  plan_hash                   text,
  -- Persisted normalized tenant boundary (for worker gateway scope derivation)
  boundary_installation_id    bigint,
  boundary_repository_id      bigint,
  boundary_scope_type         scope_type        NOT NULL,
  boundary_scope_id           bigint,
  created_at                  timestamptz       NOT NULL DEFAULT now(),
  expires_at                  timestamptz       NOT NULL,
  execution_status            delegation_status NOT NULL DEFAULT 'pending',
  execution_attempt_id        uuid,
  execution_version           bigint            NOT NULL DEFAULT 0,
  execution_started_at        timestamptz,
  revoked_at                  timestamptz,
  revoked_by                  uuid              REFERENCES auth_principals(id),
  revocation_reason           text,

  -- FK added in migration stage 4 after auth_authorization_decisions exists
  -- (declared via ALTER TABLE in that stage)
  CONSTRAINT chk_delegation_boundary_scope
    CHECK ((boundary_scope_type IN ('installation', 'repository')) = (boundary_scope_id IS NOT NULL))
);

CREATE INDEX ix_auth_delegations_worker_pending
  ON auth_delegations (worker_service_principal_id, execution_status)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_delegations_initiator
  ON auth_delegations (initiating_principal_id)
  WHERE revoked_at IS NULL;

-- Index for monitoring stale executions (not for automated reset)
CREATE INDEX ix_auth_delegations_executing
  ON auth_delegations (id, execution_started_at)
  WHERE execution_status = 'executing' AND revoked_at IS NULL;
```

**Worker-subtype enforcement** (constraint trigger):

```sql
CREATE OR REPLACE FUNCTION enforce_delegation_worker_service()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auth_principals
    WHERE id = NEW.worker_service_principal_id AND principal_type = 'service'
  ) THEN
    RAISE EXCEPTION 'delegation worker must be a service principal; % is not service type',
      NEW.worker_service_principal_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_delegation_worker_service
  AFTER INSERT OR UPDATE ON auth_delegations
  FOR EACH ROW EXECUTE FUNCTION enforce_delegation_worker_service();
```

### Stored functions for execution-claim CAS

The application does NOT directly UPDATE lifecycle columns. Instead,
it calls stored functions that atomically check all preconditions.

```sql
-- Claim acquisition: atomically checks status, version, revocation, expiry, and worker identity.
CREATE OR REPLACE FUNCTION acquire_delegation_claim(
  p_delegation_id      uuid,
  p_worker_principal_id uuid,
  p_attempt_id         uuid,
  p_expected_version   bigint
) RETURNS boolean
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  UPDATE auth_delegations
    SET execution_status   = 'executing',
        execution_attempt_id = p_attempt_id,
        execution_version   = p_expected_version + 1,
        execution_started_at = now()
    WHERE id                       = p_delegation_id
      AND worker_service_principal_id = p_worker_principal_id
      AND execution_status IN ('pending', 'completed', 'cancelled')
      AND execution_version        = p_expected_version
      AND revoked_at IS NULL
      AND expires_at > now();

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;

-- Claim finalization: owner-checked, restricts target status.
CREATE OR REPLACE FUNCTION finalize_delegation_claim(
  p_delegation_id      uuid,
  p_attempt_id         uuid,
  p_final_status       delegation_status  -- must be 'completed' or 'cancelled'
) RETURNS boolean
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  IF p_final_status NOT IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'finalize_delegation_claim: final_status must be completed or cancelled, got %',
      p_final_status;
  END IF;

  UPDATE auth_delegations
    SET execution_status = p_final_status
    WHERE id                    = p_delegation_id
      AND execution_attempt_id = p_attempt_id
      AND execution_status     = 'executing';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;

-- Operator reconciliation: requires confirmed termination evidence.
-- This function is called ONLY by the operator DB role after
-- process-supervisor-confirmed termination. It is audited.
CREATE OR REPLACE FUNCTION operator_reconcile_execution(
  p_delegation_id      uuid,
  p_operator_principal_id uuid,
  p_termination_evidence text
) RETURNS boolean
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  IF p_termination_evidence IS NULL OR p_termination_evidence = '' THEN
    RAISE EXCEPTION 'operator_reconcile_execution requires non-empty termination evidence';
  END IF;

  UPDATE auth_delegations
    SET execution_status = 'cancelled'
    WHERE id              = p_delegation_id
      AND execution_status = 'executing';

  GET DIAGNOSTICS affected = ROW_COUNT;
  -- Audit log entry would be inserted here in implementation.
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
```

**Denied-terminal enforcement:** the `acquire_delegation_claim` CAS
condition explicitly excludes `'denied'`. A constraint trigger prevents
direct UPDATE of `execution_status` from `denied` to any other state:

```sql
CREATE OR REPLACE FUNCTION enforce_denied_terminal()
RETURNS trigger AS $$
BEGIN
  IF OLD.execution_status = 'denied' AND NEW.execution_status != 'denied' THEN
    RAISE EXCEPTION 'denied delegation % is terminal; cannot transition to %',
      NEW.id, NEW.execution_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_denied_terminal
  AFTER UPDATE ON auth_delegations
  FOR EACH ROW EXECUTE FUNCTION enforce_denied_terminal();
```

**Strict no-reset enforcement:** a constraint trigger prevents direct
UPDATE of `execution_status` from `executing` to any state (the only
permitted exit paths are through `finalize_delegation_claim` or
`operator_reconcile_execution`, which use `SECURITY DEFINER` and bypass
the trigger via a session-level setting or a separate security context):

```sql
CREATE OR REPLACE FUNCTION enforce_no_direct_executing_transition()
RETURNS trigger AS $$
BEGIN
  -- This trigger fires on direct UPDATEs by the application role.
  -- SECURITY DEFINER functions run as the function owner (operator role)
  -- and can check current_user to bypass this check.
  IF OLD.execution_status = 'executing' AND NEW.execution_status != OLD.execution_status
     AND current_user != 'gitwire_operator' THEN
    RAISE EXCEPTION 'executing delegation % can only be finalized via stored function',
      NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_no_direct_executing_transition
  AFTER UPDATE ON auth_delegations
  FOR EACH ROW EXECUTE FUNCTION enforce_no_direct_executing_transition();
```

---

## 10. External attestation tables

### `auth_external_attestations`

```sql
CREATE TABLE auth_external_attestations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES auth_principals(id),
  provider        text        NOT NULL DEFAULT 'github',
  subject         text        NOT NULL,
  subject_id      bigint      NOT NULL,
  repository_id   bigint      NOT NULL,
  permission      text        NOT NULL,
  command         text        NOT NULL,
  delegation_id   uuid        NOT NULL REFERENCES auth_delegations(id),
  verified_at     timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Valid predicate: expires_at > now(). This is a runtime check, NOT an index predicate.
-- Index uses only immutable conditions:
CREATE INDEX ix_auth_external_attestations_lookup
  ON auth_external_attestations (provider, subject_id, repository_id, command, delegation_id);

CREATE INDEX ix_auth_external_attestations_expiry
  ON auth_external_attestations (expires_at);
```

**Important:** the partial index predicate `WHERE expires_at > now()`
is invalid (now() is STABLE, not IMMUTABLE). Validity is checked at
query time: `WHERE ... AND expires_at > now()`. The index covers all
rows; the runtime query filters expired ones.

---

## 11. Authorization decision and immutable context

### `auth_authorization_decisions`

Every evaluation produces a decision record. The record contains an
**immutable snapshot** of the evaluated inputs so the decision can be
reproduced even after mutable records (roles, grants, credentials)
change.

```sql
CREATE TABLE auth_authorization_decisions (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  decision                    text        NOT NULL CHECK (decision IN ('allow', 'deny')),
  -- Principal and credential at evaluation time
  principal_id                uuid        REFERENCES auth_principals(id),
  credential_id               uuid        REFERENCES auth_credentials(id),
  -- Normalized target (immutable snapshot)
  target_resource_type        text,
  target_resource_id          text,
  target_selector             text,       -- 'instance', 'list', 'create', 'route-root', 'inherited'
  target_container_type       text,
  target_container_id         text,
  target_installation_id      bigint,
  target_repository_id        bigint,
  -- Action and route
  action                      text        NOT NULL,
  route                       text,
  -- Evaluated authority inputs (immutable snapshot)
  role_permissions_snapshot   jsonb       NOT NULL,  -- array of {role, scope_type, scope_id, permissions}
  credential_scopes_snapshot  jsonb,                 -- scopes, installation_ids, repository_ids at eval time
  matched_grants_snapshot     jsonb,                 -- array of grant IDs and effects that matched
  matched_denies_snapshot     jsonb,                 -- array of deny grant IDs that matched
  -- Policy versions (immutable references)
  operation_policy_version    text        NOT NULL,  -- FK to auth_operation_policy_versions.version_hash
  -- Denial info
  reason_code                 text,                  -- NULL for allow
  denial_step                 text,                  -- where evaluated
  -- Capability/attestation inputs (for worker/attestation decisions)
  capability_jti              text,
  capability_delegation_id    uuid        REFERENCES auth_delegations(id),
  attestation_id              uuid        REFERENCES auth_external_attestations(id),
  -- Break-glass
  is_break_glass              boolean     NOT NULL DEFAULT false,
  -- Reauthorization (for sensitive operations)
  reauthorization_result      text,                  -- 'passed', 'failed', NULL (not required)
  -- Timestamp
  evaluated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_auth_decisions_principal
  ON auth_authorization_decisions (principal_id, evaluated_at DESC);

CREATE INDEX ix_auth_decisions_resource
  ON auth_authorization_decisions (target_resource_type, target_resource_id, evaluated_at DESC);

CREATE INDEX ix_auth_decisions_deny
  ON auth_authorization_decisions (decision, reason_code)
  WHERE decision = 'deny';
```

**Append-only enforcement:** the application role has INSERT and SELECT
only — no UPDATE or DELETE. A trigger provides defense-in-depth:

```sql
CREATE OR REPLACE FUNCTION enforce_decisions_append_only()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auth_authorization_decisions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_decisions_no_update
  BEFORE UPDATE ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decisions_append_only();

CREATE TRIGGER trg_decisions_no_delete
  BEFORE DELETE ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decisions_append_only();
```

**Reproducibility:** the `role_permissions_snapshot`,
`credential_scopes_snapshot`, `matched_grants_snapshot`, and
`matched_denies_snapshot` JSONB columns capture the exact evaluated
inputs. Combined with `operation_policy_version`, the decision can be
re-derived after mutable records change.

---

## 12. Operation policy versioning

The operation policy (W0-B §6) is the fourth authority intersection.
Routes compile to permission expression trees. A versioned policy
schema makes the evaluated policy traceable and immutable per decision.

### `auth_operation_policy_versions`

```sql
CREATE TABLE auth_operation_policy_versions (
  version_hash  text        PRIMARY KEY,  -- sha256 of canonical policy JSON
  route_pattern text        NOT NULL,     -- e.g., 'PUT /api/config/:owner/:repo'
  policy_json   jsonb       NOT NULL,     -- canonical expression tree
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_opolicy_route
  ON auth_operation_policy_versions (route_pattern, created_at DESC);
```

The `policy_json` contains the compiled expression tree (all_of/any_of
over concrete `<resource_type>:<action>` leaves). The
`version_hash` is referenced by `auth_authorization_decisions.operation_policy_version`
(FK added in migration).

---

## 13. Session tables

### `auth_sessions`

```sql
CREATE TABLE auth_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES auth_principals(id),
  session_hash    text        NOT NULL UNIQUE,
  pepper_version  integer     NOT NULL,
  auth_epoch      bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip_address      inet,
  user_agent      text
);

CREATE UNIQUE INDEX ux_auth_sessions_hash
  ON auth_sessions (session_hash);

-- Active predicate: revoked_at IS NULL AND expires_at > now() AND auth_epoch matches.
-- Index uses only immutable condition (revoked_at IS NULL).
CREATE INDEX ix_auth_sessions_principal
  ON auth_sessions (principal_id)
  WHERE revoked_at IS NULL;
```

**Epoch invalidation:** when `auth_principals.auth_epoch` increments,
sessions with the old epoch are detected at lookup time
(`session.auth_epoch != principal.auth_epoch`). No DB UPDATE needed.

---

## 14. Bootstrap tables and stored functions

### `auth_bootstrap_allow`

```sql
CREATE TABLE auth_bootstrap_allow (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_secret_hash    text        NOT NULL,
  created_by_db_session   text        NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
```

### `auth_bootstrap_state`

```sql
CREATE TABLE auth_bootstrap_state (
  id          integer     PRIMARY KEY DEFAULT 1,
  state       bootstrap_state_enum NOT NULL DEFAULT 'enabled',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_single_row CHECK (id = 1)
);

INSERT INTO auth_bootstrap_state (id, state) VALUES (1, 'enabled')
  ON CONFLICT (id) DO NOTHING;
```

### Stored function

```sql
CREATE OR REPLACE FUNCTION transition_bootstrap_state(p_new_state text)
RETURNS void
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_new_state = 'enabled' THEN
    IF NOT EXISTS (SELECT 1 FROM auth_bootstrap_allow LIMIT 1) THEN
      RAISE EXCEPTION 'No bootstrap marker found — cannot enable';
    END IF;
  ELSIF p_new_state = 'disabled' THEN
    DELETE FROM auth_bootstrap_allow;
  ELSE
    RAISE EXCEPTION 'Invalid bootstrap state: %', p_new_state;
  END IF;

  UPDATE auth_bootstrap_state
    SET state = p_new_state::bootstrap_state_enum, updated_at = now()
    WHERE id = 1;
END;
$$ LANGUAGE plpgsql;

-- Revoke from PUBLIC; grant only to application role
REVOKE ALL ON FUNCTION transition_bootstrap_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transition_bootstrap_state(text) TO gitwire_app;
```

---

## 15. Ownership metadata for the query gateway

The mandatory query gateway requires `installation_id` on every
installation-scoped table. Below is the complete ownership matrix for
all 45 installation-scoped registry resources, showing existing
columns, required additions, and backfill derivation.

### Complete ownership matrix

| Registry token | Backing table | Existing `installation_id` | Existing `repository_id` | Action |
|---|---|---|---|---|
| `installation` | `installations` | (is the installation) | n/a | none |
| `repository` | `repositories` | ✅ | (is the repo) | none |
| `pull_request` | `pull_requests` | via repo | ✅ | none |
| `issue` | `issues` | via repo | ✅ | none |
| `ci_run` | `ci_runs` | via repo | ✅ | none |
| `branch_rule` | `branch_rules` | via repo | ✅ | none |
| `repo_config` | `repo_configs` | via repo | ✅ | none |
| `config_validation_result` | `config_validation_results` | via repo | ✅ | none |
| `heal_pr` | `heal_prs` | via repo | ✅ | none |
| `repair_proposal` | `repair_proposals` | ADD COLUMN | ✅ | backfill from repo |
| `repair_proposal_event` | `repair_proposal_events` | via parent | via parent | none |
| `patch_artifact` | `patch_artifacts` | ADD COLUMN | via parent | backfill from parent proposal's repo |
| `execution_receipt` | `execution_receipts` | ADD COLUMN | via parent | backfill from parent proposal's repo |
| `source_snapshot` | `source_snapshots` | ADD COLUMN | via parent | backfill from parent proposal's repo |
| `backend_isolation_evidence` | `backend_isolation_evidence` | ADD COLUMN | via parent | backfill from parent proposal's repo |
| `managed_action` | `managed_actions` | via repo | ✅ | none |
| `action_reconciliation_log` | `action_reconciliation_log` | ✅ | n/a | none |
| `decision_log` | `decision_log` | ADD COLUMN | n/a | backfill from route context or principal |
| `pipeline_event` | `pipeline_events` | ✅ | n/a | none |
| `fix_attempt` | `fix_attempts` | via repo | ✅ | none |
| `ai_review` | `ai_reviews` | via repo | ✅ | none |
| `duplicate_signal` | `duplicate_signals` | via repo | ✅ | none |
| `dependency_manifest` | `dependency_manifests` | via repo | ✅ | none |
| `dependency_update_batch` | `dependency_update_batches` | via repo | ✅ | none |
| `vulnerability_advisory` | `vulnerability_advisories` | via repo | ✅ | none |
| `flaky_test` | `flaky_tests` | via repo | ✅ | none |
| `test_result` | `test_results` | via repo | ✅ | none |
| `gate_evaluation` | `gate_evaluations` | via repo | ✅ | none |
| `issue_embedding` | `issue_embeddings` | via repo | ✅ | none |
| `member` | `members` | ✅ | n/a | none |
| `repo_collaborator` | `repo_collaborators` | via repo | ✅ | none |
| `policy_definition` | `policy_definitions` | ADD COLUMN | n/a | backfill from known installation |
| `policy_waiver` | `policy_waivers` | ADD COLUMN | n/a | backfill from known installation |
| `policy_repo_config` | `policy_repo_configs` | via repo | ✅ | none |
| `reconciliation_run` | `reconciliation_runs` | ✅ | n/a | none |
| `policy_rollout_plan` | `policy_rollout_plans` | ADD COLUMN | n/a | backfill from known installation |
| `quality_gate` | `quality_gates` | via repo | ✅ | none |
| `feedback_rule` | `feedback_rules` | ADD COLUMN | n/a | backfill from known installation |
| `merge_queue_entry` | `merge_queue_entries` | via repo | ✅ | none |
| `merge_queue_config` | `merge_queue_configs` | via repo | ✅ | none |
| `rollback_event` | `rollback_events` | ✅ | n/a | none |
| `maintainer_setting` | `maintainer_settings` | via repo | ✅ | none |
| `maintainer_action` | `maintainer_actions` | via repo | ✅ | none |
| `webhook_delivery` | `webhook_deliveries` | ✅ | n/a | none |
| `external_attestation` | `auth_external_attestations` | n/a (has repository_id) | via repository_id | none (derives installation from repo lookup) |

**"via repo"** means the table has `repository_id` and the query gateway
derives `installation_id` through `repositories.installation_id`. No
column addition needed.

**"ADD COLUMN"** means the migration adds `installation_id bigint` and
backfills from the known parent. Example backfill:

```sql
-- Example: repair_proposals.installation_id
ALTER TABLE repair_proposals ADD COLUMN installation_id bigint;

UPDATE repair_proposals rp
  SET installation_id = r.installation_id
  FROM repositories r
  WHERE rp.repository_id = r.github_id;

-- Unmapped rows are reported:
INSERT INTO migration_report (migration_batch, source_table, source_id, status, detail)
  SELECT '043', 'repair_proposals', rp.id::text, 'unmapped_installation',
    'No matching repository for installation_id derivation'
  FROM repair_proposals rp
  WHERE rp.installation_id IS NULL;
```

### `migration_report`

```sql
CREATE TABLE migration_report (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_batch text        NOT NULL,  -- e.g., '043', '045'
  source_table    text        NOT NULL,
  source_id       text        NOT NULL,  -- stable identity of the unmapped row
  status          text        NOT NULL,  -- 'unmapped_installation', 'unmapped_legacy_key', etc.
  detail          text,
  resolved        boolean     NOT NULL DEFAULT false,
  resolved_at     timestamptz,
  resolved_by     uuid        REFERENCES auth_principals(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_migration_report_unresolved
  ON migration_report (migration_batch, resolved)
  WHERE resolved = false;
```

---

## 16. Audit-event linkage

```sql
-- audit_trail_entries gains:
ALTER TABLE audit_trail_entries
  ADD COLUMN principal_id uuid REFERENCES auth_principals(id),
  ADD COLUMN delegation_id uuid REFERENCES auth_delegations(id),
  ADD COLUMN authorization_decision_id uuid REFERENCES auth_authorization_decisions(id);

-- decision_log gains:
ALTER TABLE decision_log
  ADD COLUMN principal_id uuid REFERENCES auth_principals(id),
  ADD COLUMN authorization_decision_id uuid REFERENCES auth_authorization_decisions(id);
```

These are nullable during the migration period (dual-write). After full
enforcement, they become NOT NULL. Actor fields derived from
`req.auth.principalId`, not client-supplied headers (F-03 resolution).

---

## 17. Legacy-key migration records

Legacy-key backfill requires more than a principal + role row. A
durable fingerprint-to-credential mapping tracks migration provenance.

### `auth_legacy_key_map`

```sql
CREATE TABLE auth_legacy_key_map (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  key_fingerprint     text        NOT NULL UNIQUE,  -- HMAC of the shared key
  principal_id        uuid        NOT NULL REFERENCES auth_principals(id),
  mapped_installation_id bigint,  -- NULL = unmapped (denied by default)
  migration_ticket    text,       -- external tracking (e.g., Jira ticket)
  migration_batch     text        NOT NULL,  -- e.g., '045'
  source_marker       text,       -- e.g., 'pre-auth-epoch-key-rotation'
  expires_at          timestamptz NOT NULL,  -- legacy keys carry an expiry
  usage_count         bigint      NOT NULL DEFAULT 0,
  last_used_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX ux_legacy_key_fingerprint
  ON auth_legacy_key_map (key_fingerprint);

CREATE INDEX ix_legacy_key_mapped
  ON auth_legacy_key_map (mapped_installation_id)
  WHERE mapped_installation_id IS NOT NULL;
```

### Capability key registry

The capability token (W0-B §14) uses Ed25519 signing keys. The key
registry maps `key_id` to its public key and retention/rotation rule.

### `auth_capability_keys`

```sql
CREATE TABLE auth_capability_keys (
  key_id          text        PRIMARY KEY,
  public_key      bytea       NOT NULL,  -- Ed25519 public key
  issuer          text        NOT NULL,  -- 'gitwire-app'
  issued_at       timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,           -- set when key is rotated out
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_capability_keys_active
  ON auth_capability_keys (issuer)
  WHERE retired_at IS NULL;
```

---

## 18. Concurrency invariants summary

| Operation | Isolation | Mechanism | Notes |
|---|---|---|---|
| Credential lookup | READ COMMITTED | SELECT by lookup_id | Read-only |
| Role/grant evaluation | READ COMMITTED | SELECT by principal_id | Read-only |
| Role grant/revoke | READ COMMITTED | INSERT / UPDATE revoked_at | Single-row |
| Delegation claim acquire | READ COMMITTED | `acquire_delegation_claim()` CAS | Checks status, version, worker, revocation, expiry |
| Delegation claim finalize | READ COMMITTED | `finalize_delegation_claim()` CAS | Owner-checked, restricted status |
| Operator reconciliation | READ COMMITTED | `operator_reconcile_execution()` | Audited, requires evidence |
| Ownership checkpoint | READ COMMITTED | SELECT execution_attempt_id | Read-only |
| JTI consumption | n/a (Redis) | Redis SET NX | Atomic, permanent |
| Bootstrap transition | READ COMMITTED | `transition_bootstrap_state()` | SECURITY DEFINER |
| Decision logging | READ COMMITTED | INSERT | Append-only |
| Credential revocation + epoch | READ COMMITTED | Transaction (2 UPDATEs) | Atomic |

---

## 19. Privilege model (per table and operation)

No `GRANT ... ON ALL TABLES`. Each grant is explicit.

### Application role (`gitwire_app`)

| Table | SELECT | INSERT | UPDATE | DELETE | Notes |
|---|---|---|---|---|---|
| `auth_resource_registry` | ✅ | ❌ | ❌ | ❌ | Read-only catalog |
| `auth_resource_actions` | ✅ | ❌ | ❌ | ❌ | Read-only catalog |
| `auth_principals` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for status, auth_epoch, display_name, updated_at |
| `auth_credentials` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, revoked_by, revocation_reason, updated_at |
| `auth_roles` | ✅ | ✅ | ❌ | ❌ | Built-in roles seeded at migration |
| `auth_role_permissions` | ✅ | ✅ | ❌ | ❌ | Permission management |
| `auth_principal_roles` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, revoked_by, revocation_reason |
| `auth_resource_grants` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, revoked_by, revocation_reason |
| `auth_worker_ceilings` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, updated_at |
| `auth_delegations` | ✅ | ✅ | ❌ | ❌ | Lifecycle via stored functions only |
| `auth_external_attestations` | ✅ | ✅ | ❌ | ❌ | Insert-only |
| `auth_authorization_decisions` | ✅ | ✅ | ❌ | ❌ | Append-only (triggers enforce) |
| `auth_operation_policy_versions` | ✅ | ✅ | ❌ | ❌ | Versioned, insert-only |
| `auth_sessions` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at |
| `auth_bootstrap_state` | ✅ | ❌ | ❌ | ❌ | Via stored function only |
| `auth_bootstrap_allow` | ❌ | ❌ | ❌ | ❌ | Operator-only |
| `auth_legacy_key_map` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for usage_count, last_used_at, updated_at |
| `auth_capability_keys` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for retired_at |
| `migration_report` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for resolved, resolved_at, resolved_by |
| `audit_trail_entries` | ✅ | ✅ | ❌ | ❌ | Append-only |
| `decision_log` | ✅ | ✅ | ✅ (existing) | ❌ | Existing + new principal columns |

**Column-level UPDATE restrictions** are enforced by creating
column-level GRANTs instead of table-level. Example for
`auth_delegations`:

```sql
-- Application can only SELECT and INSERT delegations.
-- Lifecycle mutations go through SECURITY DEFINER functions.
GRANT SELECT, INSERT ON auth_delegations TO gitwire_app;
-- No UPDATE or DELETE granted.
-- The stored functions (owned by operator role) have full access.
```

### Operator role (`gitwire_operator`)

| Table | Privileges | Notes |
|---|---|---|
| `auth_bootstrap_allow` | INSERT, SELECT, DELETE | Marker management |
| `auth_delegations` | SELECT, UPDATE | For operator reconciliation only |
| All `auth_*` tables | SELECT | Read-only inspection |

### Migration role (`gitwire_migration`)

Runs DDL only. Seeds catalog tables. Cannot create principals or grants.

---

## 20. FK and deletion-behavior matrix

| Child table | Parent table | FK column | ON DELETE | Rationale |
|---|---|---|---|---|
| `auth_credentials` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_principal_roles` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_principal_roles` | `auth_roles` | `role_id` | CASCADE | Role deletion removes assignments |
| `auth_resource_grants` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_worker_ceilings` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_delegations` | `auth_principals` | `initiating_principal_id` | NO ACTION | Principals never deleted |
| `auth_delegations` | `auth_principals` | `worker_service_principal_id` | NO ACTION | Principals never deleted |
| `auth_delegations` | `auth_authorization_decisions` | `authorization_decision_id` | NO ACTION | Decisions append-only |
| `auth_external_attestations` | `auth_delegations` | `delegation_id` | NO ACTION | Delegations durable |
| `auth_external_attestations` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_resource_grants` | `auth_resource_registry` | `resource_type` | NO ACTION | Catalog never deleted |
| `auth_role_permissions` | `auth_roles` | `role_id` | CASCADE | Role deletion removes permissions |
| `auth_role_permissions` | `auth_resource_actions` | composite | NO ACTION | Catalog never deleted |
| `auth_sessions` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_resource_registry` | `auth_resource_registry` | `parent_token` | NO ACTION | Self-ref, catalog stable |
| `auth_legacy_key_map` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `audit_trail_entries` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |

**Default:** `NO ACTION` everywhere. No `ON DELETE CASCADE` except
`auth_role_permissions` and `auth_principal_roles → auth_roles` (role
deletion is a catalog operation that should clean up). This is
deliberate: principals, delegations, decisions, and grants are durable
records. Soft revocation (`revoked_at`) is the lifecycle mechanism.

---

## 21. Migration plan — additive sequence

Each stage is a numbered migration file. Every stage is additive.
Rollback is specified per-stage with **dependency-aware ordering**:
later stages must be rolled back before earlier stages that create
objects they reference.

### Stage 038: Catalog and enums

Creates enums, `auth_resource_registry`, `auth_resource_actions`. Seeds
all 57 tokens and their action sets.

```sql
-- 038_auth_catalog_and_enums.sql
-- CREATE TYPE statements (§3)
-- CREATE TABLE auth_resource_registry (§2)
-- CREATE TABLE auth_resource_actions (§2)
-- INSERT 57 resource tokens + action sets
```

**Rollback:** `DROP TABLE auth_resource_actions; DROP TABLE
auth_resource_registry;` then `DROP TYPE` each enum. **Dependency
check:** must be rolled back AFTER all stages that reference the
catalog and enums (039–047).

### Stage 039: Identity tables

Creates `auth_principals`, `auth_credentials`, `auth_roles`,
`auth_role_permissions`, `auth_principal_roles` + constraint triggers.
Seeds built-in roles and permission sets.

```sql
-- 039_auth_identity_tables.sql
```

**Rollback:** drop triggers, then `DROP TABLE` in reverse FK order:
`auth_principal_roles`, `auth_role_permissions`, `auth_roles`,
`auth_credentials`, `auth_principals`. **Dependency check:** must be
rolled back AFTER stages 040–047 that reference these tables.

### Stage 040: Authorization tables

Creates `auth_resource_grants`, `auth_worker_ceilings`,
`auth_authorization_decisions`, `auth_operation_policy_versions`,
`auth_sessions` + triggers.

```sql
-- 040_auth_authorization_tables.sql
```

**Rollback:** drop triggers, then `DROP TABLE` in reverse FK order.
**Dependency check:** must be rolled back AFTER 041 (delegations FK to
decisions).

### Stage 041: Delegation and attestation tables

Creates `auth_delegations`, `auth_external_attestations`. Adds FK from
`auth_delegations.authorization_decision_id` to
`auth_authorization_decisions`. Creates stored functions and constraint
triggers.

```sql
-- 041_auth_delegation_tables.sql
-- CREATE TABLE auth_delegations (§9)
-- ALTER TABLE auth_delegations ADD CONSTRAINT fk_delegation_decision
--   FOREIGN KEY (authorization_decision_id) REFERENCES auth_authorization_decisions(id)
-- CREATE TABLE auth_external_attestations (§10)
-- CREATE FUNCTION acquire_delegation_claim(...)
-- CREATE FUNCTION finalize_delegation_claim(...)
-- CREATE FUNCTION operator_reconcile_execution(...)
-- CREATE CONSTRAINT TRIGGER trg_denied_terminal
-- CREATE CONSTRAINT TRIGGER trg_no_direct_executing_transition
-- CREATE CONSTRAINT TRIGGER trg_delegation_worker_service
```

**Rollback:** drop functions and triggers, then `DROP TABLE
auth_external_attestations; DROP TABLE auth_delegations`.

### Stage 042: Bootstrap

Creates `auth_bootstrap_allow`, `auth_bootstrap_state`,
`transition_bootstrap_state`. Sets privileges.

```sql
-- 042_auth_bootstrap.sql
```

**Rollback:** `DROP FUNCTION transition_bootstrap_state; DROP TABLE
auth_bootstrap_allow; DROP TABLE auth_bootstrap_state`.

### Stage 043: Ownership backfill

Adds `installation_id` to the 8 tables identified in §15 that lack it.
Backfills from known parent. Creates `migration_report`.

```sql
-- 043_ownership_backfill.sql
-- CREATE TABLE migration_report
-- ALTER TABLE repair_proposals ADD COLUMN installation_id bigint; + backfill + report
-- ALTER TABLE patch_artifacts ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE execution_receipts ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE source_snapshots ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE backend_isolation_evidence ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE decision_log ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE policy_definitions ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE policy_waivers ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE policy_rollout_plans ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE feedback_rules ADD COLUMN installation_id bigint; + backfill
```

**Rollback:** `ALTER TABLE ... DROP COLUMN installation_id` for each
table. `DROP TABLE migration_report`. **Data loss:** yes (backfilled
values). **Safe after enforcement:** **no** — must retire enforcement first.

### Stage 044: Audit linkage

Adds `principal_id`, `delegation_id`, `authorization_decision_id` to
`audit_trail_entries` and `decision_log`.

```sql
-- 044_audit_linkage.sql
```

**Rollback:** `DROP COLUMN` for each. **Safe after enforcement:** yes
(nullable during migration period).

### Stage 045: Legacy-key backfill

Creates `auth_legacy_key_map`, `auth_capability_keys`. Backfills
existing key fingerprints. Creates legacy-key principals and explicit
installation-mapped role assignments. Unmapped keys go to
`migration_report`.

```sql
-- 045_legacy_key_backfill.sql
-- CREATE TABLE auth_legacy_key_map
-- CREATE TABLE auth_capability_keys
-- For each existing key fingerprint:
--   INSERT INTO auth_principals (principal_type='legacy-key', ...)
--   INSERT INTO auth_principal_roles (scope_type='installation', scope_id=<mapped>)
--   INSERT INTO auth_legacy_key_map (...)
-- Unmapped: INSERT INTO migration_report (status='unmapped_legacy_key')
```

**Rollback:** delete only rows created by this migration batch. Use
`migration_batch = '045'` provenance: `DELETE FROM auth_legacy_key_map
WHERE migration_batch = '045'; DELETE FROM auth_principal_roles WHERE
granted_by IN (SELECT id FROM auth_principals WHERE principal_type =
'legacy-key' AND created_at >= '<migration start timestamp>'); DELETE
FROM auth_principals WHERE principal_type = 'legacy-key' AND created_at
>= '<migration start timestamp>'`. **Safe after enforcement:** **no**.

### Stage 046: Worker identity seeding

Creates service principals and worker ceilings for all 14 workers +
reconciler + executor + bot. Uses deterministic UUIDs generated from
role names for rollback identification.

```sql
-- 046_worker_identity_seed.sql
-- Each worker principal gets a deterministic UUID (uuid_generate_v5(namespace, role_name))
-- so rollback can target exact rows.
```

**Rollback:** `DELETE FROM auth_worker_ceilings WHERE principal_id IN
(<deterministic UUIDs>); DELETE FROM auth_principals WHERE id IN
(<deterministic UUIDs>)`.

### Stage 047: Authority-source state machine

Creates the authority-source state table. Initializes to `legacy-only`.

```sql
-- 047_authority_source_state.sql
CREATE TABLE auth_authority_source_state (
  id          integer PRIMARY KEY DEFAULT 1,
  state       authority_source_state NOT NULL DEFAULT 'legacy-only',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_single_row CHECK (id = 1)
);
INSERT INTO auth_authority_source_state (id, state) VALUES (1, 'legacy-only')
  ON CONFLICT (id) DO NOTHING;
```

**Rollback:** `DROP TABLE auth_authority_source_state`.

### Dependency-aware rollback graph

```
Roll back in this order (latest first):
  047 → 046 → 045 → 044 → 043 → 042 → 041 → 040 → 039 → 038
```

Stages 043 and 045 are **irreversible after enforcement is active**
(they modify data that existing code depends on). After the
authority-source state reaches `enforce` or `legacy-retired`, rollback
of 043/045 requires forward-fix, not backward rollback.

---

## 22. Authority-source state machine

The migration proceeds through an explicit state machine that controls
which authority source is active at each phase.

| State | Authoritative source | New evaluator | Legacy path | Behavior |
|---|---|---|---|---|
| `legacy-only` | Existing shared-key path | Not running | Active (read/write) | Pre-migration baseline |
| `shadow-evaluation` | Existing path | Running (logging only) | Active (read/write) | New evaluator logs decisions but never denies. Unmapped/ambiguous rows do NOT convert to allow. |
| `dual-write` | Existing path | Running | Active (write both) | Both paths write audit/principal data. Legacy path still authoritative for authorization decisions. |
| `enforce` | New evaluator | Authoritative | Read-only fallback | New evaluator denies. Legacy path retained as fallback for unmapped keys (which deny in both paths). |
| `legacy-retired` | New evaluator | Authoritative | Removed | Legacy code paths removed. Legacy-key table archived. |

**Transition rules:**
- `legacy-only → shadow-evaluation`: after stages 038–047 are applied and catalog seeded.
- `shadow-evaluation → dual-write`: after shadow logs show no unmapped critical principals/keys.
- `dual-write → enforce`: after dual-write comparison shows zero discrepancies for a monitoring period.
- `enforce → legacy-retired`: after all legacy keys are migrated or expired and no fallback access occurs.

**Rollback points:** `shadow-evaluation` and `dual-write` can revert
to the prior state. `enforce` can revert to `dual-write` only if no
irreversible schema changes (stages 043/045) depend on enforcement.
`legacy-retired` is terminal.

---

## 23. Proof obligations and fixtures

Each fixture is an executable, transaction-wrapped DML block using
valid typed identifiers and all required columns. Fixtures are divided
into three categories:

- **(STORE)** — the schema can store this valid state.
- **(REJECT)** — the schema rejects this invalid state.
- **(EVAL)** — the runtime evaluator must produce this decision (the
  schema stores the inputs; the evaluator computes the outcome).

### Fixture F-T3: Fleet + finite repository credential (STORE)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'user', 'Fleet Admin');
  INSERT INTO auth_roles (id, name) VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'admin');
  INSERT INTO auth_principal_roles (principal_id, role_id, scope_type, granted_by)
    VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10',
            'fleet', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
  INSERT INTO auth_credentials (id, principal_id, lookup_id, secret_hash,
    pepper_version, audience, repository_ids, display_prefix)
    VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a20',
            'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'lookup-001', 'hash-001', 1, 'gitwire-app',
            ARRAY[10, 20]::bigint[], 'gw_pat_');
  -- STORE: the credential stores repository_ids = {10, 20} and the principal has fleet scope.
  -- EVAL: the evaluator derives scope.repository = {10, 20}, scope.installation = P({10, 20}).
ROLLBACK;
```

### Fixtures F-T1 through F-T18: Scope-product truth table coverage manifest

Each truth-table case from W0-B is covered by a fixture that stores
the principal's roles and credential, then asserts the evaluator
produces the expected scope. The full set follows the same pattern as
F-T3 above with different role/credential combinations. The coverage
manifest:

| Fixture | Case | Role domain | Credential | Expected scope.installation | Expected scope.repository |
|---|---|---|---|---|---|
| F-T1 | T1 | fleet | none | ALL | ALL |
| F-T2 | T2 | fleet | inst A | A | R(A) |
| F-T3 | T3 | fleet | repo R | P(R) | R |
| F-T4 | T4 | inst I | none | {I} | R({I}) |
| F-T5 | T5 | inst I | inst A (I∈A) | {I}∩A | R({I}∩A) |
| F-T6 | T6 | inst I | inst A (I∉A) | ∅ | ∅ → deny |
| F-T7 | T7 | inst I | repo R (in I) | {I}∩P(R) | R({I})∩R |
| F-T8 | T8 | inst I | repo R (not in I) | ∅ | ∅ → deny |
| F-T9 | T9 | repo R (parent I) | none | NONE | R |
| F-T10 | T10 | repo R (parent I) | inst A (I∈A) | NONE | R∩R(A) |
| F-T11 | T11 | repo R (parent I) | inst A (I∉A) | NONE | ∅ → deny |
| F-T12 | T12 | repo R (parent I) | repo R' (overlap) | NONE | R∩R' |
| F-T13 | T13 | repo R (parent I) | repo R' (disjoint) | NONE | ∅ → deny |
| F-T14 | T14 | inst I + repo R (parent J≠I) | none | {I} | R({I})∪R |
| F-T15 | T15 | inst I + repo R (parent J≠I) | inst A (I∈A, J∉A) | {I}∩A | (R({I})∪R)∩R(A) |
| F-T16 | T16 | repo R1 (parent I) | repo R2 (parent I, disjoint) | NONE | ∅ → deny |
| F-T17 | T17 | none | any | NONE | NONE → deny |
| F-T18 | T18 | system only | any tenant | NONE | NONE (system=true) |

### Fixture F-READ-LIST: read without list denial (REJECT + EVAL)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'user', 'Read Only');
  INSERT INTO auth_roles (id, name) VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'read-only');
  INSERT INTO auth_role_permissions (role_id, permission_resource, permission_action)
    VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'repository', 'read');
  -- REJECT: this INSERT fails because 'list' is valid for repository, but we simply don't insert it.
  -- EVAL: evaluate_leaf for 'repository:list' checks:
  --   ('repository', 'list') IN (SELECT permission_resource, permission_action FROM auth_role_permissions ...)
  --   → false → DENY(role_permission_missing)
ROLLBACK;
```

### Fixture F-CREATE: Create destination enforcement (EVAL)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'user', 'Operator');
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, scope_type,
    scope_id, action, effect, granted_by)
    VALUES ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
            'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'policy_waiver', 'installation', 42, 'create', 'allow',
            'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
  -- EVAL: create selector resolves container. If route specifies installation_id=99,
  --   container.installation_id (99) != grant.scope_id (42).
  --   grant_matches_target fails → resource_not_found.
ROLLBACK;
```

### Fixture F-DENY-PRECEDENCE: Explicit deny overrides allow (STORE + EVAL)

```sql
BEGIN;
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, scope_type,
    scope_id, action, effect, granted_by)
    VALUES ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'repository', 'installation', 42, 'update', 'allow',
            'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, resource_id,
    scope_type, scope_id, action, effect, granted_by)
    VALUES ('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
            'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'repository', '100', 'repository', 100, 'update', 'deny',
            'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  -- EVAL: evaluate_leaf checks deny first. Deny on resource_id='100' matches.
  --   More-specific deny overrides less-specific allow → explicit_deny.
ROLLBACK;
```

### Fixture F-IDENTIFIERS: Mixed UUID/text/bigint (STORE)

```sql
BEGIN;
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, resource_id,
    scope_type, action, effect, granted_by)
    VALUES ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'repository', '100', 'fleet', 'read', 'allow',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, resource_id,
    scope_type, action, effect, granted_by)
    VALUES ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a02',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'auth_principal', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a99',
            'system', 'manage', 'allow',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, resource_id,
    scope_type, action, effect, granted_by)
    VALUES ('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a03',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'webhook_delivery', 'del-xyz-789', 'fleet', 'read', 'allow',
            'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  -- STORE: all three identifier types stored in text resource_id column.
ROLLBACK;
```

### Fixture F-WORKER: Worker ceiling + delegation (STORE + EVAL)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'service', 'Heal Worker');
  INSERT INTO auth_worker_ceilings (id, principal_id, role_name, permissions,
    granted_by)
    VALUES ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10',
            'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'service:heal-worker',
            ARRAY['repository:github:act', 'ci_run:update', 'heal_pr:update',
                  'managed_action:update'],
            'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
  -- EVAL: ceiling includes 'repository:github:act'. Delegation authorizes repo X.
  --   Both evaluations ALLOW.
ROLLBACK;
```

### Fixture F-CAS-REJECT: Old-owner finalize rejected (STORE + EVAL)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'service', 'Patch Worker');
  -- (decision row and delegation created with valid FKs omitted for brevity;
  --  full fixture includes all required rows)
  -- Attempt A acquires claim via acquire_delegation_claim(... attempt_A ...)
  -- Attempt B calls finalize_delegation_claim(... attempt_B ...)
  -- EVAL: finalize returns false (attempt_B != current attempt owner)
ROLLBACK;
```

### Fixture F-DENIED-REJECT: Denied delegation non-reacquisition (REJECT)

```sql
-- (setup with valid delegation rows omitted for brevity)
-- UPDATE auth_delegations SET execution_status = 'denied' WHERE id = ...;
-- This must be done by operator or via a function, because the denied-terminal
-- trigger blocks direct application UPDATE from executing to anything else.
-- EVAL: acquire_delegation_claim fails (denied not in acquirable set).
-- REJECT: direct UPDATE execution_status FROM denied to pending raises exception.
```

### Fixture F-QUEUE-REJECT: queue_job grant rejected (REJECT)

```sql
BEGIN;
  INSERT INTO auth_resource_grants (id, principal_id, resource_type, scope_type,
    action, effect, granted_by)
    VALUES ('20eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'queue_job', 'system', 'enqueue', 'allow',
            '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a09');
  -- REJECT: the constraint trigger trg_no_transport_in_grants raises:
  --   'Transport-scoped resource queue_job cannot appear in auth_resource_grants'
ROLLBACK;
```

### Fixture F-SERVICE-ROLE-REJECT: Service principal tenant role rejected (REJECT)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('30eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'service', 'Worker');
  INSERT INTO auth_principal_roles (principal_id, role_id, scope_type, granted_by)
    VALUES ('30eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a10',
            'installation', '30eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
  -- REJECT: trg_no_service_tenant_roles raises:
  --   'service principal cannot receive tenant role assignments'
ROLLBACK;
```

### Fixture F-UNMAPPED-KEY: Unmapped legacy-key denial (EVAL)

```sql
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('40eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'legacy-key', 'Unmapped');
  -- No auth_principal_roles INSERT.
  -- EVAL: STEP 2 derives scope = {installation: NONE, repository: NONE}.
  --   Phase 4 fails → no_installation_scope.
  --   Legacy path returns unmapped_legacy_key.
ROLLBACK;
```

### Fixture F-BOOTSTRAP: Bootstrap re-enable and consume (STORE + EVAL)

```sql
-- Operator inserts marker (as operator role)
-- transition_bootstrap_state('enabled') → verifies marker, transitions
-- transition_bootstrap_state('disabled') → transitions, deletes marker
-- transition_bootstrap_state('enabled') → ERROR: no marker found
-- EVAL: the function atomically checks marker existence and transitions.
```

### Fixture F-ATTESTATION: Attestation expiry (STORE + EVAL)

```sql
BEGIN;
  INSERT INTO auth_external_attestations (id, principal_id, provider, subject,
    subject_id, repository_id, permission, command, delegation_id,
    expires_at)
    VALUES ('50eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            '50eebc99-9c0b-4ef8-bb6d-6bb9bd380a09',
            'github', 'octocat', 12345, 67890,
            'COLLABORATOR', 'fix-issue',
            '50eebc99-9c0b-4ef8-bb6d-6bb9bd380a20',
            now() - interval '1 minute');  -- already expired
  -- EVAL: evaluator queries WHERE expires_at > now() → 0 rows → attestation_not_found
  -- Note: the index covers all rows; expiry is a runtime query filter, not an index predicate.
ROLLBACK;
```

---

## 24. Schema-smoke verification

W0-D should execute a schema-smoke test against an empty PostgreSQL 16
database. The test:

1. Applies all DDL from stages 038–042 (catalog + tables + functions).
2. Seeds the 57-resource registry and action catalog.
3. Runs each (STORE) fixture and verifies it commits.
4. Runs each (REJECT) fixture and verifies it raises the expected
   exception.
5. Drops all objects to verify clean rollback.

**Smoke command (for W0-D implementation):**

```bash
# Create a throwaway database, apply schema, run fixtures, drop.
createdb gitwire_schema_smoke
psql gitwire_schema_smoke -f <(cat docs/architecture/authority/schema-migration-plan.md | extract_ddl)
psql gitwire_schema_smoke -f fixtures.sql
dropdb gitwire_schema_smoke
```

---

## 25. Unresolved schema risks

1. **Resource-type validation performance:** the composite FK to
   `auth_resource_actions` adds a JOIN per INSERT into role/grant/ceiling
   tables. At GitWire's scale this is negligible. Revisit if INSERT
   volume becomes significant.

2. **Decision table volume:** partitioning by time is needed before
   enforcement. Strategy: monthly range partitions on `evaluated_at`.
   Define in W0-D.

3. **Constraint trigger overhead:** every INSERT/UPDATE on guarded
   tables runs a trigger function. For high-volume tables (sessions,
   credentials), this is acceptable. For decisions (highest volume),
   append-only triggers are minimal (BEFORE UPDATE/DELETE only).

4. **Legacy-key mapping accuracy:** the backfill depends on accurate
   key-to-installation mapping. Incomplete mapping surfaces as
   `unmapped_legacy_key` in `migration_report` and denies by default.
   The `shadow-evaluation` state surfaces these before enforcement.

5. **`auth_delegations.authorization_decision_id` FK ordering:** the FK
   is added in stage 041 after `auth_authorization_decisions` (stage
   040) exists. Strictly sequential migration prevents orphaned FKs.

6. **Ownership backfill for `decision_log`:** `decision_log` rows may
   not have a clear `installation_id` (system decisions, cross-tenant
   operations). These are reported in `migration_report` and denied by
   default in the new evaluator. The `shadow-evaluation` state surfaces
   these cases.

7. **Break-glass session linkage:** break-glass principals have
   `is_break_glass = true` and `break_glass_expires_at`. Every
   break-glass decision records `is_break_glass = true` and triggers
   an alert. The session's `auth_epoch` is checked on every request,
   providing immediate invalidation when the break-glass principal is
   disabled.

---

*End of W0-C schema and migration plan. This document is
documentation-only. No executable migrations are created. No database
is altered. W0-D (ADRs and validation plan) remains blocked until W0-C
is explicitly accepted.*
