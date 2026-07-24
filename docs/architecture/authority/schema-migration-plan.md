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
24. [Schema-smoke validation plan](#24-schema-smoke-validation-plan)
25. [Retention and archival constraints](#25-retention-and-archival-constraints)
26. [Unresolved schema risks](#26-unresolved-schema-risks)

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

### Extension prerequisites

Two extensions are required before any W0-C migration runs. They are
installed at the top of stage 038 (the first W0-C migration), not as
a separate `037a` file — the existing migration runner does not
support fractional numbering:

```sql
-- Top of 038_auth_catalog_and_enums.sql:
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- provides gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; -- provides uuid_generate_v5()
```

`pgcrypto` provides `gen_random_uuid()` (DEFAULT for all primary keys).
`uuid-ossp` provides `uuid_generate_v5(namespace, name)` for
deterministic seed UUIDs.

**Deterministic seed namespace.** The fixed namespace UUID is
hard-coded as a literal in every seed expression — not stored in a
`SELECT ... AS` constant (which is not a reusable database object):

```sql
-- Every deterministic seed uses this literal UUID as the namespace.
-- Do NOT change after first use.
-- '6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'
-- Example:
--   uuid_generate_v5('6b8a1c2e-d5f4-4a7b-9e3d-1f2c3b4a5d6e'::uuid, 'service:heal-worker')
```

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
  'enforce',           -- new evaluator authoritative; legacy path disabled for authorization
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
  --         Must NOT have installation_id.
  IF NEW.principal_type = 'user' THEN
    IF NEW.installation_id IS NOT NULL THEN
      RAISE EXCEPTION 'user principal cannot have installation_id';
    END IF;
  END IF;
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

**Retyping guard.** Prevents changing a service principal to a
non-service type when ceilings or delegations reference it (and vice
versa for non-service principals receiving ceilings/delegations):

```sql
-- NOTE: This function and trigger are created in stage 041 (not stage 039)
-- because they reference auth_worker_ceilings (stage 040) and
-- auth_delegations (stage 041). Creating them in 039 would be a forward
-- reference. The trigger fires on auth_principals UPDATE, which is safe
-- because principal retyping is rare and only meaningful after the full
-- schema is deployed.
--
-- Stage 041 creates:
-- CREATE OR REPLACE FUNCTION enforce_no_subtype_retype_with_deps()
-- RETURNS trigger AS $$
-- BEGIN
--   IF OLD.principal_type = 'service' AND NEW.principal_type != 'service' THEN
--     IF EXISTS (SELECT 1 FROM auth_worker_ceilings WHERE principal_id = NEW.id) THEN
--       RAISE EXCEPTION 'cannot retype service principal % — worker ceilings exist', NEW.id;
--     END IF;
--     IF EXISTS (SELECT 1 FROM auth_delegations WHERE worker_service_principal_id = NEW.id) THEN
--       RAISE EXCEPTION 'cannot retype service principal % — delegations exist', NEW.id;
--     END IF;
--   END IF;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- CREATE CONSTRAINT TRIGGER trg_no_subtype_retype
--   AFTER UPDATE ON auth_principals
--   FOR EACH ROW EXECUTE FUNCTION enforce_no_subtype_retype_with_deps();
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
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at  timestamptz,
  retired_by  uuid        REFERENCES auth_principals(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Retirement consistency:
  -- active implies no retirement metadata; retired requires both fields
  CONSTRAINT chk_role_retirement_active
    CHECK (status != 'active' OR (retired_at IS NULL AND retired_by IS NULL)),
  CONSTRAINT chk_role_retirement_retired
    CHECK (status != 'retired' OR (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
```

### `auth_role_permissions`

Maps roles to valid permission tokens. Uses a composite FK to
`auth_resource_actions` to reject undeclared resource/action pairs at
INSERT time.

```sql
CREATE TABLE auth_role_permissions (
  role_id             uuid        NOT NULL REFERENCES auth_roles(id) ON DELETE NO ACTION,
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

**Role retirement function.** The application has no UPDATE privilege
on `auth_roles`. Retirement is an audited operation performed via a
`SECURITY DEFINER` function owned by `gitwire_auth_fn_owner`:

```sql
-- Function-owner grants for retirement (applied in stage 040 after
-- auth_roles and auth_authorization_decisions both exist):
-- GRANT SELECT, UPDATE ON auth_roles TO gitwire_auth_fn_owner;
-- GRANT SELECT ON auth_authorization_decisions TO gitwire_auth_fn_owner;
-- GRANT INSERT ON auth_role_retirement_log TO gitwire_auth_fn_owner;

-- The retire_role() function and auth_role_retirement_log table are
-- defined in stage 040 (§11), after auth_authorization_decisions exists,
-- because the retirement log has an FK to that table. See §11 for the
-- complete function DDL including authority validation.
```

**Retirement audit table** (created in stage 040):

```sql
CREATE TABLE auth_role_retirement_log (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id                     uuid        NOT NULL REFERENCES auth_roles(id),
  authorization_decision_id   uuid        REFERENCES auth_authorization_decisions(id) ON DELETE SET NULL,
  db_session_user             text        NOT NULL,  -- session_user at execution
  retired_at                  timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement:
CREATE OR REPLACE FUNCTION enforce_retirement_log_append_only()
RETURNS trigger AS $$
BEGIN
  IF current_user = 'gitwire_auth_fn_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'auth_role_retirement_log is append-only (current_user=%)',
    current_user;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_retirement_log_no_update
  BEFORE UPDATE ON auth_role_retirement_log
  FOR EACH ROW EXECUTE FUNCTION enforce_retirement_log_append_only();
CREATE TRIGGER trg_retirement_log_no_delete
  BEFORE DELETE ON auth_role_retirement_log
  FOR EACH ROW EXECUTE FUNCTION enforce_retirement_log_append_only();
```

**`retire_role()` function** (created in stage 040, after decisions exist):

```sql
CREATE OR REPLACE FUNCTION retire_role(
  p_role_id                    uuid,
  p_authorization_decision_id  uuid
) RETURNS void
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected int;
  v_db_session text := session_user;
  v_decision_principal uuid;
  v_decision_action text;
  v_decision_target text;
BEGIN
  -- Authority validation: the referenced decision must be an allow
  -- for auth_role:manage targeting the exact role being retired.
  SELECT principal_id, action, target_resource_id
    INTO v_decision_principal, v_decision_action, v_decision_target
    FROM auth_authorization_decisions
    WHERE id = p_authorization_decision_id
      AND decision = 'allow'
      AND action = 'manage'
      AND target_resource_type = 'auth_role';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'retire_role: authorization_decision_id % is not a valid auth_role:manage allow decision',
      p_authorization_decision_id;
  END IF;

  IF v_decision_target IS NULL OR v_decision_target != p_role_id::text THEN
    RAISE EXCEPTION 'retire_role: decision does not target role %', p_role_id;
  END IF;

  UPDATE auth_roles
    SET status = 'retired',
        retired_at = now(),
        retired_by = v_decision_principal,
        updated_at = now()
    WHERE id = p_role_id AND status = 'active';

  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected = 1 THEN
    INSERT INTO auth_role_retirement_log (
      role_id, authorization_decision_id, db_session_user, retired_at
    ) VALUES (
      p_role_id, p_authorization_decision_id, v_db_session, now()
    );
  END IF;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION retire_role(uuid, uuid) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION retire_role(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION retire_role(uuid, uuid) TO gitwire_app;
```

The application can retire roles only by providing a valid
`auth_role:manage` authorization decision targeting the exact role.
The function validates the decision is an `allow` with the correct
action, resource type, and target. The `retired_by` field is derived
from the decision's principal — not caller-supplied. Retired roles are
excluded from evaluation because the evaluator joins `auth_roles` and
filters `status = 'active'`.

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
Additionally, the evaluator MUST join `auth_roles` and filter
`status = 'active'` — retired roles do not contribute permissions even
if the assignment is not revoked.
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

**Grant action validation trigger.** Validates that `(resource_type, action)`
is a declared pair in the action catalog, except for `action = '*'`
(wildcard, which is valid for any resource type):

```sql
CREATE OR REPLACE FUNCTION enforce_grant_action_valid()
RETURNS trigger AS $$
BEGIN
  IF NEW.action != '*' AND NOT EXISTS (
    SELECT 1 FROM auth_resource_actions
    WHERE registry_token = NEW.resource_type AND action = NEW.action
  ) THEN
    RAISE EXCEPTION 'Invalid action % for resource type % in auth_resource_grants',
      NEW.action, NEW.resource_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_grant_action_valid
  AFTER INSERT OR UPDATE ON auth_resource_grants
  FOR EACH ROW EXECUTE FUNCTION enforce_grant_action_valid();
```

(The transport-resource exclusion trigger from §2 also fires on this
table, rejecting `resource_type = 'queue_job'`.)

---

## 8. Worker ceiling tables

### `auth_worker_ceilings`

```sql
CREATE TABLE auth_worker_ceilings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id  uuid        NOT NULL REFERENCES auth_principals(id),
  role_name     text        NOT NULL,
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

### `auth_worker_ceiling_permissions`

Normalized junction table with composite FK to `auth_resource_actions`.
This replaces the unvalidated `text[]` array. Every permission pair is
catalog-validated. `queue_job:enqueue` is legal here (it is the
transport ceiling permission); it is rejected in grants by the §2
trigger.

```sql
CREATE TABLE auth_worker_ceiling_permissions (
  ceiling_id         uuid   NOT NULL REFERENCES auth_worker_ceilings(id) ON DELETE CASCADE,
  permission_resource text  NOT NULL,
  permission_action   text  NOT NULL,
  PRIMARY KEY (ceiling_id, permission_resource, permission_action),
  FOREIGN KEY (permission_resource, permission_action)
    REFERENCES auth_resource_actions (registry_token, action)
);

CREATE INDEX ix_ceiling_perms_lookup
  ON auth_worker_ceiling_permissions (permission_resource, permission_action);
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
  -- authorization_decision_id is nullable (FK ON DELETE SET NULL allows archival),
  -- but a BEFORE INSERT trigger enforces it is NOT NULL at creation time.
  authorization_decision_id   uuid,
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

**Creation-time decision linkage enforcement.** The
`authorization_decision_id` column is nullable (archival may set it
NULL via `ON DELETE SET NULL`), but every newly created delegation MUST
reference a valid authorization decision. A `BEFORE INSERT` trigger
enforces this:

```sql
CREATE OR REPLACE FUNCTION enforce_delegation_decision_at_creation()
RETURNS trigger AS $$
DECLARE
  v_decision           text;
  v_decision_principal uuid;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.authorization_decision_id IS NULL THEN
    RAISE EXCEPTION 'delegation authorization_decision_id is required at creation time';
  END IF;

  -- Enforce initial execution_status = 'pending' at INSERT
  IF TG_OP = 'INSERT' AND NEW.execution_status != 'pending' THEN
    RAISE EXCEPTION 'delegation execution_status must be pending at creation, got %',
      NEW.execution_status;
  END IF;

  -- Validate the decision is an applicable allow matching this delegation
  IF TG_OP = 'INSERT' THEN
    SELECT decision, principal_id
      INTO v_decision, v_decision_principal
      FROM auth_authorization_decisions
      WHERE id = NEW.authorization_decision_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'delegation authorization_decision_id % does not exist',
        NEW.authorization_decision_id;
    END IF;

    IF v_decision != 'allow' THEN
      RAISE EXCEPTION 'delegation authorization_decision_id % is not an allow decision',
        NEW.authorization_decision_id;
    END IF;

    -- The decision's principal must be the initiating principal
    IF v_decision_principal != NEW.initiating_principal_id THEN
      RAISE EXCEPTION 'delegation decision principal does not match initiating_principal_id';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_delegation_decision_notnull_insert
  BEFORE INSERT ON auth_delegations
  FOR EACH ROW EXECUTE FUNCTION enforce_delegation_decision_at_creation();
```

### Stored functions for execution-claim CAS

The application does NOT directly UPDATE lifecycle columns. Instead,
it calls stored functions that atomically check all preconditions.

**Function-owner role and locked schema.** All `SECURITY DEFINER`
functions are owned by `gitwire_auth_fn_owner` — a dedicated **non-login**
role. The functions use `SET search_path = gitwire_auth, pg_temp` where
`gitwire_auth` is a dedicated schema that contains only the authority
tables and functions. `REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC`
prevents `pg_temp` shadow-object attacks. The schema is created at the
start of stage 038 (before any authority table). All subsequent
unqualified `CREATE TABLE` statements resolve to `gitwire_auth.*`
under the stage's `SET search_path`.

```sql
-- (Schema creation, REVOKE CREATE, and gitwire_auth_fn_owner role
--  creation happen at the start of stage 038 — see §21 stage 038.)

-- All authority tables live in gitwire_auth schema (schema-qualified).
-- Example: gitwire_auth.auth_delegations, gitwire_auth.auth_principals, etc.
-- Functions reference schema-qualified names in SET search_path context.
-- The search_path is set to 'gitwire_auth, pg_temp' in every SECURITY DEFINER
-- function, so unqualified names resolve to the locked schema first.

-- Delegation lifecycle grants to function owner:
GRANT SELECT, UPDATE ON gitwire_auth.auth_delegations TO gitwire_auth_fn_owner;
-- reconciliation_log INSERT deferred until table creation later in this stage.
-- bootstrap grants (stage 042):
-- GRANT SELECT, DELETE ON gitwire_auth.auth_bootstrap_allow TO gitwire_auth_fn_owner;
-- GRANT UPDATE ON gitwire_auth.auth_bootstrap_state TO gitwire_auth_fn_owner;
-- authority-source grants (stage 047):
-- GRANT SELECT, UPDATE ON gitwire_auth.auth_authority_source_state TO gitwire_auth_fn_owner;
-- GRANT INSERT ON gitwire_auth.auth_authority_source_log TO gitwire_auth_fn_owner;
```

**Claim acquisition** — atomically checks status, version, revocation,
expiry, and worker identity:

```sql
CREATE OR REPLACE FUNCTION acquire_delegation_claim(
  p_delegation_id       uuid,
  p_worker_principal_id uuid,
  p_attempt_id          uuid,
  p_expected_version    bigint
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  UPDATE auth_delegations
    SET execution_status     = 'executing',
        execution_attempt_id = p_attempt_id,
        execution_version    = p_expected_version + 1,
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
ALTER FUNCTION acquire_delegation_claim(uuid, uuid, uuid, bigint) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION acquire_delegation_claim(uuid, uuid, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acquire_delegation_claim(uuid, uuid, uuid, bigint) TO gitwire_app;
```

**Claim finalization** — owner-checked, restricts target status:

```sql
CREATE OR REPLACE FUNCTION finalize_delegation_claim(
  p_delegation_id          uuid,
  p_attempt_id             uuid,
  p_final_status           delegation_status,
  p_worker_principal_id    uuid
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
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
    WHERE id                        = p_delegation_id
      AND execution_attempt_id      = p_attempt_id
      AND worker_service_principal_id = p_worker_principal_id
      AND execution_status     = 'executing';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION finalize_delegation_claim(uuid, uuid, delegation_status, uuid) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION finalize_delegation_claim(uuid, uuid, delegation_status, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_delegation_claim(uuid, uuid, delegation_status, uuid) TO gitwire_app;
```

**Operator reconciliation** — requires confirmed termination evidence,
inserts a durable audit record atomically with the state transition:

```sql
CREATE OR REPLACE FUNCTION operator_reconcile_execution(
  p_delegation_id         uuid,
  p_operator_principal_id uuid,
  p_termination_evidence  text,
  p_supervisor_session    text
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected     int;
  v_old_owner  uuid;
  v_old_ver    bigint;
BEGIN
  IF p_termination_evidence IS NULL OR p_termination_evidence = '' THEN
    RAISE EXCEPTION 'operator_reconcile_execution requires non-empty termination evidence';
  END IF;

  -- Capture prior owner/version for audit
  SELECT execution_attempt_id, execution_version
    INTO v_old_owner, v_old_ver
    FROM auth_delegations WHERE id = p_delegation_id;

  UPDATE auth_delegations
    SET execution_status = 'cancelled'
    WHERE id              = p_delegation_id
      AND execution_status = 'executing';

  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected = 1 THEN
    INSERT INTO auth_reconciliation_log (
      delegation_id, operator_principal_id, termination_evidence,
      supervisor_session, db_session_user,
      prior_attempt_id, prior_version,
      new_status, reconciled_at
    ) VALUES (
      p_delegation_id, p_operator_principal_id, p_termination_evidence,
      p_supervisor_session, session_user,
      v_old_owner, v_old_ver,
      'cancelled', now()
    );
  END IF;

  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION operator_reconcile_execution(uuid, uuid, text, text) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION operator_reconcile_execution(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_reconcile_execution(uuid, uuid, text, text) TO gitwire_operator;
```

**Reconciliation audit table:**

```sql
CREATE TABLE auth_reconciliation_log (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delegation_id         uuid        NOT NULL REFERENCES auth_delegations(id),
  -- Caller-supplied human metadata (supplemental, not proof of identity):
  operator_principal_id uuid        NOT NULL REFERENCES auth_principals(id),
  termination_evidence  text        NOT NULL,
  supervisor_session    text,
  -- Immutable DB-session identity (the authoritative proof of who ran this):
  db_session_user       text        NOT NULL,  -- session_user at execution time
  prior_attempt_id      uuid,
  prior_version         bigint,
  new_status            delegation_status NOT NULL,
  reconciled_at         timestamptz NOT NULL DEFAULT now()
);
-- Append-only: ONLY the function owner (gitwire_auth_fn_owner) can INSERT.
-- The application gets SELECT only (for audit inspection).
-- This prevents the application from forging reconciliation events.
GRANT INSERT ON auth_reconciliation_log TO gitwire_auth_fn_owner;

-- Append-only triggers (defense-in-depth):
CREATE OR REPLACE FUNCTION enforce_reconciliation_append_only()
RETURNS trigger AS $$
BEGIN
  IF current_user = 'gitwire_auth_fn_owner' THEN
    -- BEFORE UPDATE → return NEW (allow the change)
    -- BEFORE DELETE → return OLD (allow the deletion; NEW is NULL in DELETE)
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'auth_reconciliation_log is append-only (current_user=%)',
    current_user;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reconciliation_no_update
  BEFORE UPDATE ON auth_reconciliation_log
  FOR EACH ROW EXECUTE FUNCTION enforce_reconciliation_append_only();
CREATE TRIGGER trg_reconciliation_no_delete
  BEFORE DELETE ON auth_reconciliation_log
  FOR EACH ROW EXECUTE FUNCTION enforce_reconciliation_append_only();
```

**Denied-terminal enforcement:**

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

**Delegation denial function.** The `denied` status is set when an
admin explicitly rejects a delegation (e.g., the authorization decision
was overturned after creation). This function provides the defined
entry path:

```sql
CREATE OR REPLACE FUNCTION deny_delegation(
  p_delegation_id     uuid,
  p_authorization_decision_id uuid
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected int;
BEGIN
  -- Validate the denial decision
  IF NOT EXISTS (
    SELECT 1 FROM auth_authorization_decisions
    WHERE id = p_authorization_decision_id
      AND decision = 'allow'
      AND action = 'manage'
      AND target_resource_type = 'auth_delegation'
  ) THEN
    RAISE EXCEPTION 'deny_delegation: invalid authorization decision';
  END IF;

  UPDATE auth_delegations
    SET execution_status = 'denied'
    WHERE id = p_delegation_id
      AND execution_status = 'pending';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION deny_delegation(uuid, uuid) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION deny_delegation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deny_delegation(uuid, uuid) TO gitwire_app;
```

Only `pending` delegations can be denied. `executing` delegations
cannot be denied (they must be finalized or reconciled first). Once
`denied`, the terminal trigger prevents any further transition.

**Strict no-reset enforcement.** The trigger blocks direct
`executing → other` transitions by any role EXCEPT the function-owner
role (which the SECURITY DEFINER functions run as). Neither the
application nor operator session can bypass this:

```sql
CREATE OR REPLACE FUNCTION enforce_no_direct_executing_transition()
RETURNS trigger AS $$
BEGIN
  IF OLD.execution_status = 'executing' AND NEW.execution_status != OLD.execution_status
     AND current_user != 'gitwire_auth_fn_owner' THEN
    RAISE EXCEPTION 'executing delegation % can only be finalized via stored function (current_user=%)',
      NEW.id, current_user;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_no_direct_executing_transition
  AFTER UPDATE ON auth_delegations
  FOR EACH ROW EXECUTE FUNCTION enforce_no_direct_executing_transition();
```

The operator role has **no direct UPDATE on `auth_delegations`**. It
can only call `operator_reconcile_execution()`, which runs as
`gitwire_auth_fn_owner`. The trigger bypass condition checks
`current_user = 'gitwire_auth_fn_owner'`, which is a `NOLOGIN` role —
no human or application session can set their role to it.
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
  target_resource_type        text        REFERENCES auth_resource_registry(token),
  target_resource_id          text,
  target_selector             text        CHECK (target_selector IN
                                ('instance', 'list', 'create', 'route-root', 'inherited', 'scope-slice')),
  target_container_type       text,
  target_container_id         text,
  target_installation_id      bigint,
  target_repository_id        bigint,
  -- Action and route — action is a concrete evaluated action (not wildcard '*')
  action                      text        NOT NULL,
  route                       text,
  -- Derived tri-state scope snapshot (immutable, for reproduction)
  scope_snapshot              jsonb       NOT NULL,  -- {installation: "ALL"|"NONE"|{ids}, repository: same, fleet: bool, system: bool}
  -- Evaluated authority inputs (immutable full-value snapshots)
  role_permissions_snapshot   jsonb       NOT NULL,  -- array of {role_id, role_name, scope_type, scope_id, permissions: [{resource, action}]}
  credential_scopes_snapshot  jsonb,                 -- {scopes, installation_ids, repository_ids, environment, audience}
  matched_grants_snapshot     jsonb,                 -- array of full grant values: {id, resource_type, resource_id, scope_type, scope_id, action, effect}
  matched_denies_snapshot     jsonb,                 -- array of full deny grant values
  -- Policy version (immutable reference)
  -- Nullable for pre-policy failures (unauthenticated, invalid capability)
  -- where no operation policy was evaluated.
  operation_policy_version    text        REFERENCES auth_operation_policy_versions(version_hash),
  -- Denial info (catalog-constrained)
  reason_code                 text        CHECK (reason_code IS NULL OR reason_code IN (
    'no_authenticated_principal', 'no_installation_scope', 'resource_not_found',
    'no_active_role', 'role_permission_missing', 'explicit_deny',
    'credential_scope_denied', 'credential_resource_restricted',
    'wrong_environment', 'expired', 'resource_grant_missing',
    'operation_policy_denied', 'reauthorization_failed',
    'attestation_not_found', 'attestation_revoked_on_github', 'attestation_permission_changed',
    'capability_jti_consumed', 'capability_delegation_in_use',
    'capability_delegation_invalid', 'capability_invalid_signature',
    'capability_audience_mismatch', 'capability_expired',
    'capability_payload_mismatch', 'capability_queue_mismatch',
    'capability_delivery_mismatch', 'capability_key_not_found',
    'unmapped_legacy_key', 'disabled'
  )),
  denial_step                 text,                  -- where evaluated: 'evaluate_leaf', 'evaluate_attestation_leaf', 'Algorithm step N', 'Worker verification'
  -- Capability claim snapshot (complete, for worker decisions)
  capability_snapshot         jsonb,                 -- {version, decision_id, delegation_id, initiating_principal_id, worker_service_principal_id, operation, queue_name, job_name, installation_id, repository_id, payload_hash, issuer, audience, key_id, issued_at, expires_at, jti, delivery_id}
  -- Attestation recheck result (for F-07 decisions)
  attestation_recheck_result  text,                  -- 'verified', 'revoked_on_github', 'permission_changed', 'not_found', NULL (not attestation route)
  -- FKs to delegation/attestation (added in stage 041 via ALTER TABLE — tables do not exist at stage 040)
  capability_delegation_id    uuid,                  -- FK added in 041
  attestation_id              uuid,                  -- FK added in 041
  -- Break-glass (FK added after auth_break_glass_activations is created)
  is_break_glass              boolean     NOT NULL DEFAULT false,
  break_glass_activation_id   uuid,                  -- FK added in stage 040b
  -- Reauthorization (for sensitive operations)
  reauthorization_result      text        CHECK (reauthorization_result IS NULL OR reauthorization_result IN ('passed', 'failed')),
  -- Timestamp
  evaluated_at                timestamptz NOT NULL DEFAULT now(),

  -- Outcome consistency: allow requires NULL reason; deny requires non-NULL reason
  CONSTRAINT chk_decision_outcome_consistency
    CHECK ((decision = 'allow' AND reason_code IS NULL)
           OR (decision = 'deny' AND reason_code IS NOT NULL)),
  -- Break-glass consistency: if activation_id is present, is_break_glass must be true.
  -- (Archival may set activation_id to NULL via ON DELETE SET NULL, leaving is_break_glass
  --  true as a historical marker — the reverse implication is not enforced.)
  CONSTRAINT chk_break_glass_consistency
    CHECK (break_glass_activation_id IS NULL OR is_break_glass = true)
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
  -- Exempt the function-owner role so the archival function can DELETE
  -- old rows (SECURITY DEFINER runs as gitwire_auth_fn_owner).
  -- BEFORE UPDATE → return NEW; BEFORE DELETE → return OLD (NEW is NULL in DELETE).
  IF current_user = 'gitwire_auth_fn_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'auth_authorization_decisions is append-only (current_user=%)',
    current_user;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_decisions_no_update
  BEFORE UPDATE ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decisions_append_only();

CREATE TRIGGER trg_decisions_no_delete
  BEFORE DELETE ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decisions_append_only();
```

**FK-driven `ON DELETE SET NULL` and append-only triggers.** PostgreSQL
FK referential actions execute as ordinary `UPDATE` or `DELETE`
operations on the referencing table, and user-defined triggers **do
fire**. Therefore, when attestation or break-glass cleanup deletes a
row, the resulting `SET NULL` UPDATE on
`auth_authorization_decisions` fires `trg_decisions_no_update`.

To handle this correctly, all cleanup of tables with `ON DELETE SET
NULL` FKs to append-only tables must go through `SECURITY DEFINER`
functions owned by `gitwire_auth_fn_owner`. The FK-driven UPDATE runs
under the session user that initiated the DELETE — when that session
is inside a `SECURITY DEFINER` function owned by
`gitwire_auth_fn_owner`, the trigger's `current_user` check passes:

```sql
-- Archival for attestations (causes ON DELETE SET NULL on decisions)
CREATE OR REPLACE FUNCTION archive_old_attestations(p_retention_days integer DEFAULT 90)
RETURNS integer
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 90 THEN
    RAISE EXCEPTION 'archive_old_attestations: retention_days must be >= 90, got %',
      p_retention_days;
  END IF;

  DELETE FROM auth_external_attestations
    WHERE expires_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION archive_old_attestations(integer) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION archive_old_attestations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_old_attestations(integer) TO gitwire_operator;
GRANT DELETE ON auth_external_attestations TO gitwire_auth_fn_owner;

-- Archival for break-glass activations (causes ON DELETE SET NULL on decisions)
CREATE OR REPLACE FUNCTION archive_old_break_glass(p_retention_days integer DEFAULT 365)
RETURNS integer
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 365 THEN
    RAISE EXCEPTION 'archive_old_break_glass: retention_days must be >= 365, got %',
      p_retention_days;
  END IF;

  DELETE FROM auth_break_glass_activations
    WHERE activated_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION archive_old_break_glass(integer) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION archive_old_break_glass(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_old_break_glass(integer) TO gitwire_operator;
GRANT DELETE ON auth_break_glass_activations TO gitwire_auth_fn_owner;
```

When these functions DELETE from attestation/break-glass tables, the
FK `ON DELETE SET NULL` fires `trg_decisions_no_update` on
`auth_authorization_decisions`. Because the function runs as
`gitwire_auth_fn_owner` (`SECURITY DEFINER`), `current_user` is
`gitwire_auth_fn_owner`, and the trigger's owner exemption allows the
UPDATE. Direct operator or application DELETE on these tables would
fail the trigger because `current_user` would not match.

Session cleanup (`auth_sessions`) does not have this problem because
no `ON DELETE SET NULL` FK targets an append-only table — the
break-glass activation's `session_id` FK targets sessions (not
append-only), so session DELETE does not UPDATE any append-only table.
Session cleanup can therefore use a direct scheduled DELETE job.

**Decision action validation.** The `action` column must contain a
concrete action from the global action vocabulary (not `'*'`), and when
`target_resource_type` is non-NULL, the `(target_resource_type, action)`
pair must exist in the action catalog:

```sql
CREATE OR REPLACE FUNCTION enforce_decision_action_valid()
RETURNS trigger AS $$
BEGIN
  -- Global action vocabulary check (no wildcards in decisions)
  IF NEW.action NOT IN (
    'read', 'list', 'create', 'update', 'delete',
    'github:act', 'github:read', 'enqueue', 'approve', 'revoke',
    'manage', 'audit:read', 'audit:export'
  ) THEN
    RAISE EXCEPTION 'Decision action % is not in the action vocabulary', NEW.action;
  END IF;

  -- Composite catalog check when target resource type is known
  IF NEW.target_resource_type IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM auth_resource_actions
    WHERE registry_token = NEW.target_resource_type AND action = NEW.action
  ) THEN
    RAISE EXCEPTION 'Decision action %:% is not in the resource action catalog',
      NEW.target_resource_type, NEW.action;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_decision_action_valid
  AFTER INSERT OR UPDATE ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decision_action_valid();
```

**Break-glass decision creation-time enforcement.** At INSERT, a
break-glass decision (`is_break_glass = true`) MUST have a live
`break_glass_activation_id`. Only FK-driven archival (`ON DELETE SET
NULL`) may later clear the activation while keeping `is_break_glass =
true` as a historical marker. This trigger prevents arbitrary INSERTs
with `is_break_glass = true` but no activation:

```sql
CREATE OR REPLACE FUNCTION enforce_break_glass_decision_at_creation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_break_glass = true
     AND NEW.break_glass_activation_id IS NULL THEN
    RAISE EXCEPTION 'break-glass decision requires a live break_glass_activation_id at creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_break_glass_decision_insert
  BEFORE INSERT ON auth_authorization_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_break_glass_decision_at_creation();
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

The primary key is `(route_pattern, version_hash)` — the hash is of the
**canonical route+policy envelope** (`sha256(route_pattern || ':' ||
canonical_json(policy_json))`), so two routes with identical policy JSON
get distinct version hashes. This prevents key collisions.

```sql
CREATE TABLE auth_operation_policy_versions (
  route_pattern text        NOT NULL,
  version_hash  text        NOT NULL,     -- sha256(route_pattern || ':' || canonical_json(policy_json))
  policy_json   jsonb       NOT NULL,     -- canonical expression tree (all_of/any_of over leaves)
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- version_hash is independently UNIQUE so it can serve as an FK target
  -- from auth_authorization_decisions.operation_policy_version
  CONSTRAINT ux_opolicy_version_hash UNIQUE (version_hash),
  PRIMARY KEY (route_pattern, version_hash)
);
```

The `version_hash` column has its own `UNIQUE` constraint (in addition
to the composite PK), so the FK from
`auth_authorization_decisions.operation_policy_version` is valid.

The `operation_policy_version` column in `auth_authorization_decisions`
references `version_hash`. Because version_hash is unique per
route+policy envelope, the FK is satisfied.

**Immutability** (insert-only):

```sql
CREATE OR REPLACE FUNCTION enforce_policy_version_immutable()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'auth_operation_policy_versions is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_opolicy_no_update
  BEFORE UPDATE ON auth_operation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_version_immutable();
CREATE TRIGGER trg_opolicy_no_delete
  BEFORE DELETE ON auth_operation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_version_immutable();
```

**Policy leaf validation.** Each leaf in `policy_json` must reference a
valid `(resource, action)` pair from the action catalog. This is
validated by a recursive constraint trigger on INSERT. The canonical
policy format is a nested expression tree:

```json
{
  "type": "all_of" | "any_of",
  "children": [ <node>, ... ]
}
```

or a leaf:

```json
{
  "type": "leaf",
  "resource": "<registry_token>",
  "action": "<action>"
}
```

```sql
-- Recursive validator: walks the all_of/any_of tree and validates
-- every leaf against the action catalog.
CREATE OR REPLACE FUNCTION validate_policy_node(node jsonb) RETURNS void AS $$
DECLARE
  child jsonb;
  node_type text := node->>'type';
  leaf_resource text;
  leaf_action text;
BEGIN
  IF node_type IS NULL THEN
    RAISE EXCEPTION 'Policy node missing type';
  END IF;

  IF node_type = 'leaf' THEN
    leaf_resource := node->>'resource';
    leaf_action := node->>'action';
    IF leaf_resource IS NULL OR leaf_action IS NULL THEN
      RAISE EXCEPTION 'Policy leaf missing resource or action';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM auth_resource_actions
      WHERE registry_token = leaf_resource AND action = leaf_action
    ) THEN
      RAISE EXCEPTION 'Policy leaf %:% is not in the action catalog',
        leaf_resource, leaf_action;
    END IF;

  ELSIF node_type IN ('all_of', 'any_of') THEN
    IF jsonb_array_length(node->'children') = 0 THEN
      RAISE EXCEPTION 'Policy % node has empty children', node_type;
    END IF;
    FOR child IN SELECT jsonb_array_elements(node->'children') LOOP
      PERFORM validate_policy_node(child);
    END LOOP;

  ELSE
    RAISE EXCEPTION 'Unknown policy node type: %', node_type;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_policy_leaves_valid()
RETURNS trigger AS $$
BEGIN
  PERFORM validate_policy_node(NEW.policy_json);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_policy_leaves_valid
  AFTER INSERT ON auth_operation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_leaves_valid();
```

**Hash verification trigger.** Verifies that `version_hash` equals
`sha256(route_pattern || ':' || canonical_json(policy_json))`. Prevents
a caller from claiming an arbitrary hash:

```sql
CREATE OR REPLACE FUNCTION enforce_policy_hash_matches()
RETURNS trigger AS $$
DECLARE
  computed_hash text;
BEGIN
  computed_hash := 'sha256:' || encode(
    digest(NEW.route_pattern || ':' || NEW.policy_json::text, 'sha256'),
    'hex'
  );
  IF NEW.version_hash != computed_hash THEN
    RAISE EXCEPTION 'Policy version_hash mismatch: stored %, computed %',
      NEW.version_hash, computed_hash;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_policy_hash_matches
  AFTER INSERT ON auth_operation_policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_policy_hash_matches();
```

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

### `auth_break_glass_activations`

Concrete break-glass activation records (W0-B §11). Every break-glass
session links to an activation record with reason, activating operator,
short expiry, and alert acknowledgement.

```sql
CREATE TABLE auth_break_glass_activations (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  break_glass_principal_id uuid       NOT NULL REFERENCES auth_principals(id),
  activated_by            uuid        NOT NULL REFERENCES auth_principals(id),
  activation_reason       text        NOT NULL,
  activated_at            timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  session_id              uuid        REFERENCES auth_sessions(id) ON DELETE SET NULL,
  alert_sent              boolean     NOT NULL DEFAULT false,
  alert_acknowledged      boolean     NOT NULL DEFAULT false,
  alert_acknowledged_at   timestamptz,
  alert_acknowledged_by   uuid        REFERENCES auth_principals(id),
  revoked_at              timestamptz,
  revoked_by              uuid        REFERENCES auth_principals(id)
);

CREATE INDEX ix_break_glass_active
  ON auth_break_glass_activations (break_glass_principal_id)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_break_glass_unacknowledged
  ON auth_break_glass_activations (id)
  WHERE alert_acknowledged = false;
```

**Break-glass activation constraints** (enforced by constraint trigger —
the referenced principal must be `is_break_glass = true`, the
activating principal must be a human `user`, the session must belong to
the break-glass principal, and expiry must not exceed the principal's
break-glass expiry):

```sql
CREATE OR REPLACE FUNCTION enforce_break_glass_constraints()
RETURNS trigger AS $$
DECLARE
  v_principal_bg      boolean;
  v_principal_bg_exp  timestamptz;
  v_activator_type    principal_type;
  v_session_principal uuid;
BEGIN
  -- 1. Referenced principal must be break-glass
  SELECT is_break_glass, break_glass_expires_at
    INTO v_principal_bg, v_principal_bg_exp
    FROM auth_principals WHERE id = NEW.break_glass_principal_id;
  IF NOT v_principal_bg THEN
    RAISE EXCEPTION 'break_glass_activation references non-break-glass principal %',
      NEW.break_glass_principal_id;
  END IF;

  -- 2. Activating principal must be a human user
  SELECT principal_type INTO v_activator_type
    FROM auth_principals WHERE id = NEW.activated_by;
  IF v_activator_type != 'user' THEN
    RAISE EXCEPTION 'break_glass activation can only be performed by a human user';
  END IF;

  -- 3. Session (if provided) must belong to the break-glass principal
  IF NEW.session_id IS NOT NULL THEN
    SELECT principal_id INTO v_session_principal
      FROM auth_sessions WHERE id = NEW.session_id;
    IF v_session_principal != NEW.break_glass_principal_id THEN
      RAISE EXCEPTION 'break_glass activation session must belong to the break-glass principal';
    END IF;
  END IF;

  -- 4. Activation expiry must not exceed principal break-glass expiry
  IF NEW.expires_at > v_principal_bg_exp THEN
    RAISE EXCEPTION 'break_glass activation expiry exceeds principal break-glass expiry';
  END IF;

  -- 5. Activation expiry must be after activation time
  IF NEW.expires_at <= NEW.activated_at THEN
    RAISE EXCEPTION 'break_glass activation expires_at must be after activated_at';
  END IF;

  -- 6. Hard maximum activation duration (30 minutes)
  IF NEW.expires_at > NEW.activated_at + interval '30 minutes' THEN
    RAISE EXCEPTION 'break_glass activation exceeds maximum 30-minute duration';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_break_glass_constraints
  AFTER INSERT OR UPDATE ON auth_break_glass_activations
  FOR EACH ROW EXECUTE FUNCTION enforce_break_glass_constraints();
```

Every break-glass decision records `is_break_glass = true` and
`break_glass_activation_id` in `auth_authorization_decisions`, providing
direct linkage to the activation record — not just "through the session
chain." The application MUST send an alert to all active administrators
when a
break-glass activation is created.

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
SET search_path = gitwire_auth, pg_temp
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
ALTER FUNCTION transition_bootstrap_state(text) OWNER TO gitwire_auth_fn_owner;
-- Revoke from PUBLIC; grant only to application role
REVOKE ALL ON FUNCTION transition_bootstrap_state(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION transition_bootstrap_state(text) TO gitwire_app;
```

The bootstrap function is owned by `gitwire_auth_fn_owner` (the
non-login role), consistent with all other SECURITY DEFINER functions.
It needs DELETE on `auth_bootstrap_allow` and UPDATE on
`auth_bootstrap_state` — these are granted to the function owner:

```sql
GRANT SELECT, DELETE ON auth_bootstrap_allow TO gitwire_auth_fn_owner;
GRANT SELECT, UPDATE ON auth_bootstrap_state TO gitwire_auth_fn_owner;
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
| `repair_proposal` | `repair_proposals` | ADD COLUMN | ✅ | `UPDATE repair_proposals rp SET installation_id = r.installation_id FROM repositories r WHERE rp.repository_id = r.github_id` |
| `repair_proposal_event` | `repair_proposal_events` | via parent | via parent | none |
| `patch_artifact` | `patch_artifacts` | ADD COLUMN | via parent | `UPDATE patch_artifacts pa SET installation_id = rp.installation_id FROM repair_proposals rp WHERE pa.repair_proposal_id = rp.id` |
| `execution_receipt` | `execution_receipts` | ADD COLUMN | via parent | `UPDATE execution_receipts er SET installation_id = rp.installation_id FROM repair_proposals rp WHERE er.repair_proposal_id = rp.id` |
| `source_snapshot` | `source_snapshots` | ADD COLUMN | via parent | `UPDATE source_snapshots ss SET installation_id = rp.installation_id FROM repair_proposals rp WHERE ss.repair_proposal_id = rp.id` |
| `backend_isolation_evidence` | `backend_isolation_evidence` | ADD COLUMN | via parent | `UPDATE backend_isolation_evidence be SET installation_id = rp.installation_id FROM repair_proposals rp WHERE be.repair_proposal_id = rp.id` |
| `managed_action` | `managed_actions` | via repo | ✅ | none |
| `action_reconciliation_log` | `action_reconciliation_log` | ✅ | n/a | none |
| `decision_log` | `decision_log` | ADD COLUMN | ✅ (repo_id) | See detailed gate sequence below |
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
| `policy_definition` | `policy_definitions` | ✅ (exists) | n/a | Disk-verified: `008_phase1_enforcement.sql` already declares `installation_id BIGINT NOT NULL REFERENCES installations(github_id)`. No migration needed. |
| `policy_waiver` | `policy_waivers` | ADD COLUMN (derive from repo_id) | ✅ (repo_id) | `ALTER TABLE policy_waivers ADD COLUMN installation_id bigint; UPDATE policy_waivers pw SET installation_id = r.installation_id FROM repositories r WHERE pw.repo_id = r.github_id;` — rows with NULL repo_id → report to migration_report |
| `policy_repo_config` | `policy_repo_configs` | via repo | ✅ | none |
| `reconciliation_run` | `reconciliation_runs` | ✅ | n/a | none |
| `policy_rollout_plan` | `policy_rollout_plans` | ADD COLUMN (derive from repo_id) | ✅ (repo_id) | `ALTER TABLE policy_rollout_plans ADD COLUMN installation_id bigint; UPDATE policy_rollout_plans prp SET installation_id = r.installation_id FROM repositories r WHERE prp.repo_id = r.github_id;` |
| `quality_gate` | `quality_gates` | via repo | ✅ | none |
| `feedback_rule` | `feedback_rules` | ✅ (exists) | n/a | Disk-verified: `009_phase2_automation.sql` already declares `installation_id BIGINT NOT NULL REFERENCES installations(github_id)`. No migration needed. |
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
  migration_batch text        NOT NULL,
  source_table    text        NOT NULL,
  source_id       text        NOT NULL,
  status          text        NOT NULL,
  detail          text,
  resolved        boolean     NOT NULL DEFAULT false,
  resolved_at     timestamptz,
  resolved_by     uuid        REFERENCES auth_principals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Idempotency: same finding from same batch for same row+status is reported once
  CONSTRAINT ux_migration_report_finding UNIQUE (migration_batch, source_table, source_id, status),
  -- Resolution consistency: resolved requires timestamp and resolver
  CONSTRAINT chk_migration_report_resolved
    CHECK ((resolved = false) OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);

CREATE INDEX ix_migration_report_unresolved
  ON migration_report (migration_batch, resolved)
  WHERE resolved = false;
```

### Ownership column gate sequence (applies to every ADD COLUMN in stage 043)

For every table receiving `installation_id` in stage 043, the following
sequence ensures fail-closed behavior and deterministic enforcement:

```sql
-- Example: decision_log (same pattern for all 8 target tables)

-- 1. Add nullable column
ALTER TABLE decision_log ADD COLUMN installation_id bigint;

-- 2. Exact backfill JOIN (disk-verified source: repo_id → repositories.github_id)
UPDATE decision_log dl
  SET installation_id = r.installation_id
  FROM repositories r
  WHERE dl.repo_id = r.github_id;

-- 3. Report unmapped rows (ambiguous/system/cross-tenant → fail-closed)
INSERT INTO migration_report (migration_batch, source_table, source_id, status, detail)
  SELECT '043', 'decision_log', dl.id::text, 'unmapped_installation',
    'No matching repository for installation_id derivation'
  FROM decision_log dl
  WHERE dl.installation_id IS NULL;

-- 4. Add FK (initially NOT VALID so existing NULLs don't block)
ALTER TABLE decision_log
  ADD CONSTRAINT fk_decision_log_installation
  FOREIGN KEY (installation_id) REFERENCES public.installations(github_id)
  NOT VALID;

-- 5. Validate FK after backfill (fails if any non-NULL value is invalid)
ALTER TABLE decision_log
  VALIDATE CONSTRAINT fk_decision_log_installation;

-- 6. Create index for query gateway performance
CREATE INDEX ix_decision_log_installation
  ON decision_log (installation_id)
  WHERE installation_id IS NOT NULL;

-- 7. Optional NOT NULL cutover: only after zero unresolved rows
--    SELECT count(*) FROM decision_log WHERE installation_id IS NULL;
--    If count = 0: ALTER TABLE decision_log ALTER COLUMN installation_id SET NOT NULL;
--    If count > 0: rows remain NULL and fail-closed; resolve manually first.
```

Unresolved rows (NULL `installation_id`) are denied by default in the
new evaluator — the query gateway treats NULL as invisible. No
implicit installation assignment is ever performed.

---

## 16. Audit-event linkage

```sql
-- audit_trail_entries gains:
ALTER TABLE audit_trail_entries
  ADD COLUMN principal_id uuid REFERENCES auth_principals(id),
  ADD COLUMN delegation_id uuid REFERENCES auth_delegations(id),
  ADD COLUMN authorization_decision_id uuid REFERENCES auth_authorization_decisions(id) ON DELETE SET NULL;

-- decision_log gains:
ALTER TABLE decision_log
  ADD COLUMN principal_id uuid REFERENCES auth_principals(id),
  ADD COLUMN authorization_decision_id uuid REFERENCES auth_authorization_decisions(id) ON DELETE SET NULL;
```

These columns remain nullable permanently — the `authorization_decision_id`
FKs use `ON DELETE SET NULL` so 365-day archival can delete old decisions
without violating FK constraints. The `principal_id` and `delegation_id`
columns are nullable for the same reason (principals and delegations are
durable, but nullability prevents archival conflicts). Actor fields derived from
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
| `auth_roles` | ✅ | ✅ | ❌ (via function) | ❌ | Retirement via `retire_role()` function only; no direct UPDATE |
| `auth_role_permissions` | ✅ | ✅ | ❌ | ❌ | Permission management |
| `auth_principal_roles` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, revoked_by, revocation_reason |
| `auth_resource_grants` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, revoked_by, revocation_reason |
| `auth_worker_ceilings` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at, updated_at |
| `auth_delegations` | ✅ | ✅ | ❌ | ❌ | Lifecycle via stored functions only |
| `auth_external_attestations` | ✅ | ✅ | ❌ | ❌ | Insert-only |
| `auth_authorization_decisions` | ✅ | ✅ | ❌ | ❌ | Append-only (triggers enforce) |
| `auth_operation_policy_versions` | ✅ | ✅ | ❌ | ❌ | Versioned, insert-only |
| `auth_sessions` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for revoked_at |
| `auth_break_glass_activations` | ✅ | ✅ | ✅ (limited) | ❌ | UPDATE only for alert_sent, alert_acknowledged, alert_acknowledged_at, alert_acknowledged_by, revoked_at, revoked_by |
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
-- The stored functions (owned by gitwire_auth_fn_owner NOLOGIN) have full access.
```

### Operator role (`gitwire_operator`)

| Table | Privileges | Notes |
|---|---|---|
| `auth_bootstrap_allow` | INSERT, SELECT, DELETE | Marker management |
| `auth_delegations` | SELECT only | No direct UPDATE — reconciliation via `operator_reconcile_execution()` |
| `auth_reconciliation_log` | SELECT | Audit inspection |
| `auth_role_retirement_log` | SELECT | Audit inspection |
| All `auth_*` tables | SELECT | Read-only inspection |
| `operator_reconcile_execution()` | EXECUTE | Audited reconciliation only |
| `archive_old_decisions()` | EXECUTE | Daily archival with 365-day floor |
| `archive_old_reconciliation()` | EXECUTE | Daily archival with 365-day floor |
| `archive_old_attestations()` | EXECUTE | Attestation cleanup with 90-day floor |
| `archive_old_break_glass()` | EXECUTE | Break-glass cleanup with 365-day floor |
| `transition_authority_source()` | EXECUTE | Production cutover control |

### Migration role (`gitwire_migration`)

Runs DDL only. Seeds catalog tables. Cannot create principals or grants.

---

## 20. FK and deletion-behavior matrix

| Child table | Parent table | FK column | ON DELETE | Rationale |
|---|---|---|---|---|
| `auth_credentials` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_principal_roles` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_principal_roles` | `auth_roles` | `role_id` | NO ACTION | Roles retired, not deleted — preserves audit |
| `auth_principal_roles` | `auth_principals` | `granted_by` | NO ACTION | Audit linkage preserved |
| `auth_principal_roles` | `auth_principals` | `revoked_by` | NO ACTION | Audit linkage preserved |
| `auth_resource_grants` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_resource_grants` | `auth_principals` | `granted_by` | NO ACTION | Audit linkage preserved |
| `auth_resource_grants` | `auth_principals` | `revoked_by` | NO ACTION | Audit linkage preserved |
| `auth_resource_grants` | `auth_resource_registry` | `resource_type` | NO ACTION | Catalog never deleted |
| `auth_worker_ceilings` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_worker_ceilings` | `auth_principals` | `granted_by` | NO ACTION | Audit linkage preserved |
| `auth_worker_ceiling_permissions` | `auth_worker_ceilings` | `ceiling_id` | CASCADE | Ceiling deletion removes permissions (ceiling is not audit-relevant) |
| `auth_worker_ceiling_permissions` | `auth_resource_actions` | composite | NO ACTION | Catalog never deleted |
| `auth_role_permissions` | `auth_roles` | `role_id` | NO ACTION | Roles retired, not deleted — preserves audit |
| `auth_role_permissions` | `auth_resource_actions` | composite | NO ACTION | Catalog never deleted |
| `auth_delegations` | `auth_principals` | `initiating_principal_id` | NO ACTION | Principals never deleted |
| `auth_delegations` | `auth_principals` | `worker_service_principal_id` | NO ACTION | Principals never deleted |
| `auth_delegations` | `auth_principals` | `revoked_by` | NO ACTION | Audit linkage preserved |
| `auth_delegations` | `auth_authorization_decisions` | `authorization_decision_id` | SET NULL | Archival can delete old decisions; delegation retains NULL |
| `auth_delegations` | `auth_resource_registry` | `resource_type` | NO ACTION | Catalog never deleted |
| `auth_authorization_decisions` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_authorization_decisions` | `auth_credentials` | `credential_id` | NO ACTION | Credentials never deleted |
| `auth_authorization_decisions` | `auth_resource_registry` | `target_resource_type` | NO ACTION | Catalog never deleted |
| `auth_authorization_decisions` | `auth_delegations` | `capability_delegation_id` | SET NULL | Archival of delegation sets NULL | 
| `auth_authorization_decisions` | `auth_external_attestations` | `attestation_id` | SET NULL | Attestation cleanup sets NULL; decision retains JSONB snapshot |
| `auth_authorization_decisions` | `auth_break_glass_activations` | `break_glass_activation_id` | SET NULL | Break-glass archival sets NULL; decision retains is_break_glass flag |
| `auth_authorization_decisions` | `auth_operation_policy_versions` | `operation_policy_version` | NO ACTION (via version_hash) | Policy immutable |
| `auth_role_retirement_log` | `auth_roles` | `role_id` | NO ACTION | Roles never deleted |
| `auth_role_retirement_log` | `auth_authorization_decisions` | `authorization_decision_id` | SET NULL | Decision archival sets NULL; retirement record retains other fields |
| `auth_external_attestations` | `auth_delegations` | `delegation_id` | NO ACTION | Delegations durable |
| `auth_external_attestations` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_sessions` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `auth_break_glass_activations` | `auth_principals` | `break_glass_principal_id` | NO ACTION | Principals never deleted |
| `auth_break_glass_activations` | `auth_principals` | `activated_by` | NO ACTION | Audit linkage preserved |
| `auth_break_glass_activations` | `auth_sessions` | `session_id` | SET NULL | Session cleanup sets session_id=NULL; activation retains metadata |
| `auth_reconciliation_log` | `auth_delegations` | `delegation_id` | NO ACTION | Delegations durable |
| `auth_reconciliation_log` | `auth_principals` | `operator_principal_id` | NO ACTION | Audit linkage preserved |
| `auth_resource_registry` | `auth_resource_registry` | `parent_token` | NO ACTION | Self-ref, catalog stable |
| `auth_legacy_key_map` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `migration_report` | `auth_principals` | `resolved_by` | NO ACTION | Audit linkage preserved |
| `audit_trail_entries` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `audit_trail_entries` | `auth_delegations` | `delegation_id` | NO ACTION | Delegations durable |
| `audit_trail_entries` | `auth_authorization_decisions` | `authorization_decision_id` | SET NULL | Archival sets NULL; audit entry retains other fields |
| `auth_resource_actions` | `auth_resource_registry` | `registry_token` | NO ACTION | Catalog never deleted |
| `auth_credentials` | `auth_principals` | `revoked_by` | NO ACTION | Audit linkage preserved |
| `auth_break_glass_activations` | `auth_principals` | `alert_acknowledged_by` | NO ACTION | Audit linkage preserved |
| `auth_break_glass_activations` | `auth_principals` | `revoked_by` | NO ACTION | Audit linkage preserved |
| `decision_log` | `auth_principals` | `principal_id` | NO ACTION | Principals never deleted |
| `decision_log` | `auth_authorization_decisions` | `authorization_decision_id` | SET NULL | Archival sets NULL |

**Default:** `NO ACTION` everywhere. The only `ON DELETE CASCADE` is
`auth_worker_ceiling_permissions → auth_worker_ceilings` (ceiling
permission rows are operational, not audit-relevant). Roles are
**retired** (via `retire_role()`: sets `status = 'retired'`, `retired_at`, `retired_by`), not deleted —
deleting a role would destroy audit history for every principal who
held it. Soft revocation (`revoked_at`) is the lifecycle mechanism for
all durable records.

---

## 21. Migration plan — additive sequence

Each stage is a numbered migration file. Every stage is additive.
Rollback is specified per-stage with **dependency-aware ordering**:
later stages must be rolled back before earlier stages that create
objects they reference.

### Stage 038: Catalog and enums

**First:** creates the locked `gitwire_auth` schema and sets the
session `search_path` so all unqualified `CREATE TABLE` statements in
stages 038–047 resolve to `gitwire_auth.*`. All authority tables and
functions live in this schema.

Creates enums, `auth_resource_registry`, `auth_resource_actions`. Seeds
all 57 tokens and their action sets.

```sql
-- 038_auth_catalog_and_enums.sql

-- 1. Create the locked schema FIRST, before any authority table.
CREATE SCHEMA IF NOT EXISTS gitwire_auth;
REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_app, gitwire_operator;

-- 2. Set search_path so all subsequent unqualified CREATE TABLE
--    statements in stages 038–047 create objects in gitwire_auth.
SET search_path = gitwire_auth, public;

-- 3. Extensions (required before gen_random_uuid / uuid_generate_v5)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 4. CREATE TYPE statements (§3)
-- 5. CREATE TABLE auth_resource_registry (§2) → gitwire_auth.auth_resource_registry
-- 6. CREATE TABLE auth_resource_actions (§2) → gitwire_auth.auth_resource_actions
-- 7. INSERT 57 resource tokens + action sets

-- 8. Create all roles (production assumes these exist; smoke test creates them)
DO $$ BEGIN
  CREATE ROLE gitwire_auth_fn_owner NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE gitwire_app;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE gitwire_operator;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE ROLE gitwire_migration;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_auth_fn_owner;
GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_app, gitwire_operator;
```

All subsequent `CREATE TABLE auth_*` statements in stages 039–047
execute under `SET search_path = gitwire_auth, public` and therefore
create tables in the `gitwire_auth` schema. All `SECURITY DEFINER`
functions use `SET search_path = gitwire_auth, pg_temp` (already
updated in the function definitions above).

**Note:** existing application tables (`repositories`, `decision_log`,
etc.) remain in the `public` schema. Cross-schema FKs from `gitwire_auth`
to `public` are fully qualified: e.g., `REFERENCES public.repositories(github_id)`.

**Rollback:** `DROP TABLE gitwire_auth.auth_resource_actions; DROP TABLE
gitwire_auth.auth_resource_registry;` then `DROP TYPE` for each enum
(principal_type, principal_status, scope_type, grant_effect,
delegation_status, bootstrap_state_enum, credential_environment,
credential_audience, authority_source_state). Drop roles:
`DROP ROLE gitwire_auth_fn_owner; DROP ROLE gitwire_migration;`
(gitwire_app/gitwire_operator may be shared — do not drop in rollback).
Drop schema: `DROP SCHEMA IF EXISTS gitwire_auth;`.
**Dependency check:** must be rolled back AFTER all stages that
reference the catalog and enums (039–047).

### Stage 039: Identity tables

Creates `auth_principals`, `auth_credentials`, `auth_roles`,
`auth_role_permissions`, `auth_principal_roles` + constraint triggers.
Seeds built-in roles and permission sets.

```sql
-- 039_auth_identity_tables.sql
SET search_path = gitwire_auth, public;
-- CREATE TABLE auth_principals (§4) + constraint triggers
-- CREATE TABLE auth_credentials (§5)
-- CREATE TABLE auth_roles (§6) + retirement CHECKs
-- CREATE TABLE auth_role_permissions (§6)
-- CREATE TABLE auth_principal_roles (§6) + constraint triggers
-- Seeds built-in roles and permission sets
```

**Rollback:**
1. Drop constraint triggers: `DROP TRIGGER trg_principal_bindings ON auth_principals;`
   `DROP TRIGGER trg_no_service_tenant_roles ON auth_principal_roles;`
2. Drop trigger functions: `DROP FUNCTION enforce_principal_type_bindings;`
   `DROP FUNCTION enforce_no_tenant_roles_for_service;`
3. `DROP TABLE auth_principal_roles;`
4. `DROP TABLE auth_role_permissions;`
5. `DROP TABLE auth_roles;`
6. `DROP TABLE auth_credentials;`
7. `DROP TABLE auth_principals;`
**Dependency check:** must be rolled back AFTER stages 040–047 that
reference these tables. (The `trg_no_subtype_retype` trigger is created
in stage 041, so it is dropped in stage 041's rollback, not here.)

### Stage 040: Authorization tables

Creates all authorization tables in dependency-safe order. Objects
that reference tables created in this or later stages have their FKs
deferred via `ALTER TABLE`.

**Object creation order within stage 040:**

```sql
-- 040_auth_authorization_tables.sql
SET search_path = gitwire_auth, public;
-- 1. auth_operation_policy_versions (no FKs to other 040 tables)
-- 2. auth_resource_grants (+ transport-exclusion + action-valid triggers)
-- 3. auth_worker_ceilings (+ service-only trigger)
-- 4. auth_worker_ceiling_permissions (+ composite FK to auth_resource_actions)
-- 5. auth_authorization_decisions (FKs to policy via version_hash;
--    FKs to delegations/attestations/break-glass deferred to stages 041/040b)
--    + append-only triggers + action-valid trigger
-- 6. auth_sessions
-- 7. auth_break_glass_activations (+ constraint trigger)
-- Stage 040b: deferred FKs from decisions to break-glass activations
ALTER TABLE auth_authorization_decisions
  ADD CONSTRAINT fk_decision_break_glass
  FOREIGN KEY (break_glass_activation_id) REFERENCES auth_break_glass_activations(id) ON DELETE SET NULL;
```

**Tables created:** `auth_operation_policy_versions`,
`auth_resource_grants`, `auth_worker_ceilings`,
`auth_worker_ceiling_permissions`, `auth_authorization_decisions`,
`auth_sessions`, `auth_break_glass_activations`.

**Deferred FKs (added later):**
- Decisions → delegations: stage 041
- Decisions → attestations: stage 041
- Decisions → break-glass activations: stage 040b (within this stage, after the activation table is created)

**Rollback:** drop triggers, then drop FKs and tables in reverse
dependency order:
1. Drop deferred FKs: `ALTER TABLE auth_authorization_decisions DROP CONSTRAINT fk_decision_break_glass;`
2. Drop break-glass activation triggers, then `DROP TABLE auth_break_glass_activations`
3. `DROP TABLE auth_sessions`
4. Drop decision triggers, then `DROP TABLE auth_authorization_decisions`
5. `DROP TABLE auth_worker_ceiling_permissions`
6. Drop ceiling triggers, then `DROP TABLE auth_worker_ceilings`
7. Drop grant triggers, then `DROP TABLE auth_resource_grants`
8. Drop policy triggers, then `DROP TABLE auth_operation_policy_versions` **Dependency check:** must be rolled
back AFTER 041 (delegations FK to decisions).

### Stage 041: Delegation and attestation tables

Creates `auth_delegations`, `auth_external_attestations`. Adds all
circular FKs between decisions ↔ delegations and decisions ↔
attestations. Creates stored functions and constraint triggers.

```sql
-- 041_auth_delegation_tables.sql
SET search_path = gitwire_auth, public;
-- 1. CREATE TABLE auth_delegations (§9)
-- 2. CREATE TABLE auth_external_attestations (§10)
-- 3. Add circular FKs that could not exist in stage 040:
ALTER TABLE auth_delegations
  ADD CONSTRAINT fk_delegation_decision
  FOREIGN KEY (authorization_decision_id) REFERENCES auth_authorization_decisions(id) ON DELETE SET NULL;

ALTER TABLE auth_authorization_decisions
  ADD CONSTRAINT fk_decision_delegation
  FOREIGN KEY (capability_delegation_id) REFERENCES auth_delegations(id) ON DELETE SET NULL;

ALTER TABLE auth_authorization_decisions
  ADD CONSTRAINT fk_decision_attestation
  FOREIGN KEY (attestation_id) REFERENCES auth_external_attestations(id) ON DELETE SET NULL;

-- 4. CREATE TABLE auth_reconciliation_log (§9) + append-only triggers
-- 5. CREATE FUNCTION acquire_delegation_claim(uuid, uuid, uuid, bigint)
-- 6. CREATE FUNCTION finalize_delegation_claim(uuid, uuid, delegation_status, uuid)
-- 7. CREATE FUNCTION operator_reconcile_execution(uuid, uuid, text, text)
-- 7a. CREATE FUNCTION deny_delegation(uuid, uuid)
-- 8. CREATE CONSTRAINT TRIGGER trg_denied_terminal
-- 9. CREATE CONSTRAINT TRIGGER trg_no_direct_executing_transition
-- 10. CREATE CONSTRAINT TRIGGER trg_delegation_worker_service
-- 11. CREATE TRIGGER trg_delegation_decision_notnull_insert
-- 12. GRANT DELETE ON auth_authorization_decisions, auth_reconciliation_log TO gitwire_auth_fn_owner
-- 13. GRANT INSERT ON auth_reconciliation_log TO gitwire_auth_fn_owner
```

**Rollback:** reverse dependency order:
1. Drop constraint triggers and functions (`trg_denied_terminal`,
   `trg_no_direct_executing_transition`, `trg_delegation_worker_service`,
   `acquire_delegation_claim`, `finalize_delegation_claim`,
   `operator_reconcile_execution`).
2. Drop the reverse FKs added to `auth_authorization_decisions`:
   ```sql
   ALTER TABLE auth_authorization_decisions DROP CONSTRAINT IF EXISTS fk_decision_delegation;
   ALTER TABLE auth_authorization_decisions DROP CONSTRAINT IF EXISTS fk_decision_attestation;
   ```
3. Drop the FK from `auth_delegations` to decisions:
   ```sql
   ALTER TABLE auth_delegations DROP CONSTRAINT IF EXISTS fk_delegation_decision;
   ```
4. `DROP TABLE auth_reconciliation_log;` (if created in this stage).
5. `DROP TABLE auth_external_attestations;`
6. `DROP TABLE auth_delegations;`

### Stage 042: Bootstrap

Creates `auth_bootstrap_allow`, `auth_bootstrap_state`,
`transition_bootstrap_state`. Sets privileges.

```sql
-- 042_auth_bootstrap.sql
SET search_path = gitwire_auth, public;
```

**Rollback:** `DROP FUNCTION transition_bootstrap_state(text); DROP TABLE
auth_bootstrap_allow; DROP TABLE auth_bootstrap_state`.

### Stage 043: Ownership backfill

Adds `installation_id` to the 8 tables identified in §15 that lack it.
(`policy_definitions` and `feedback_rules` already have the column per
disk-verified migrations 008 and 009 — excluded from this stage.)
Backfills from known parent. Creates `migration_report`.

```sql
-- 043_ownership_backfill.sql
SET search_path = gitwire_auth, public;
-- CREATE TABLE migration_report
-- 8 tables requiring ADD COLUMN (policy_definitions and feedback_rules
-- already have installation_id per disk-verified migrations 008/009):
-- ALTER TABLE repair_proposals ADD COLUMN installation_id bigint; + backfill + report
-- ALTER TABLE patch_artifacts ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE execution_receipts ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE source_snapshots ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE backend_isolation_evidence ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE decision_log ADD COLUMN installation_id bigint; + backfill
-- ALTER TABLE policy_waivers ADD COLUMN installation_id bigint; + backfill from repo_id
-- ALTER TABLE policy_rollout_plans ADD COLUMN installation_id bigint; + backfill from repo_id
-- (policy_definitions and feedback_rules EXCLUDED — column already exists)
```

**Rollback:** `ALTER TABLE ... DROP COLUMN installation_id` for each
table. `DROP TABLE migration_report`. **Data loss:** yes (backfilled
values). **Safe after enforcement:** **no** — must retire enforcement first.

### Stage 044: Audit linkage

Adds `principal_id`, `delegation_id`, `authorization_decision_id` to
`audit_trail_entries` and `decision_log`.

```sql
-- 044_audit_linkage.sql
SET search_path = gitwire_auth, public;
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
SET search_path = gitwire_auth, public;
-- CREATE TABLE auth_legacy_key_map
-- CREATE TABLE auth_capability_keys
-- For each existing key fingerprint:
--   INSERT INTO auth_principals (principal_type='legacy-key', ...)
--   INSERT INTO auth_principal_roles (scope_type='installation', scope_id=<mapped>)
--   INSERT INTO auth_legacy_key_map (...)
-- Unmapped: INSERT INTO migration_report (status='unmapped_legacy_key')
```

**Rollback:** delete only rows created by this migration batch, using
deterministic batch provenance. Legacy-key principals are seeded with
`uuid_generate_v5(gitwire_seed_namespace, 'legacy-key:' || key_fingerprint)`,
so rollback targets exact IDs:

```sql
-- Use a transaction-local temporary table so all statements can reference it.
BEGIN;
  -- 1. Collect seeded principal IDs into a temp table
  CREATE TEMP TABLE tmp_rollback_045 AS
    SELECT principal_id FROM auth_legacy_key_map WHERE migration_batch = '045';

  -- 2. Delete role assignments for these principals (dependency-safe order)
  DELETE FROM auth_principal_roles
    WHERE principal_id IN (SELECT principal_id FROM tmp_rollback_045);

  -- 3. Delete legacy key map rows
  DELETE FROM auth_legacy_key_map WHERE migration_batch = '045';

  -- 4. Delete seeded principals
  DELETE FROM auth_principals
    WHERE id IN (SELECT principal_id FROM tmp_rollback_045);

  DROP TABLE tmp_rollback_045;
COMMIT;
```

This uses deterministic IDs from `auth_legacy_key_map` — not
timestamps. **Safe after enforcement:** **no**.

### Stage 046: Worker identity seeding

Creates service principals and worker ceilings for all 14 workers +
reconciler + executor + bot. Uses deterministic UUIDs generated from
role names for rollback identification.

```sql
-- 046_worker_identity_seed.sql
SET search_path = gitwire_auth, public;
-- Each worker principal gets a deterministic UUID (uuid_generate_v5(namespace, role_name))
-- so rollback can target exact rows.
```

**Rollback:** `DELETE FROM auth_worker_ceilings WHERE principal_id IN
(<deterministic UUIDs>); DELETE FROM auth_principals WHERE id IN
(<deterministic UUIDs>)`.

### Stage 047: Authority-source state machine

Creates the authority-source state table with a CAS transition function.
Initializes to `legacy-only`. The application cannot directly UPDATE
the state — transitions go through a `SECURITY DEFINER` function that
enforces the legal transition graph.

```sql
-- 047_authority_source_state.sql
SET search_path = gitwire_auth, public;
CREATE TABLE auth_authority_source_state (
  id          integer PRIMARY KEY DEFAULT 1,
  state       authority_source_state NOT NULL DEFAULT 'legacy-only',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  CONSTRAINT chk_single_row CHECK (id = 1)
);
INSERT INTO auth_authority_source_state (id, state) VALUES (1, 'legacy-only')
  ON CONFLICT (id) DO NOTHING;

-- CAS transition function: enforces legal state ordering.
-- Production-cutover authority (promoting to enforce/legacy-retired)
-- is operator-controlled, NOT application-controlled. The application
-- cannot execute this function.

-- Authority-source transition audit table (MUST be created BEFORE the
-- function that inserts into it):
CREATE TABLE auth_authority_source_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_state      authority_source_state NOT NULL,
  to_state        authority_source_state NOT NULL,
  transitioned_by text        NOT NULL,  -- session_user (DB-authenticated)
  transitioned_at timestamptz NOT NULL DEFAULT now()
);

-- Append-only enforcement:
CREATE OR REPLACE FUNCTION enforce_authority_source_log_append_only()
RETURNS trigger AS $$
BEGIN
  IF current_user = 'gitwire_auth_fn_owner' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'auth_authority_source_log is append-only (current_user=%)',
    current_user;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_authority_source_log_no_update
  BEFORE UPDATE ON auth_authority_source_log
  FOR EACH ROW EXECUTE FUNCTION enforce_authority_source_log_append_only();
CREATE TRIGGER trg_authority_source_log_no_delete
  BEFORE DELETE ON auth_authority_source_log
  FOR EACH ROW EXECUTE FUNCTION enforce_authority_source_log_append_only();

-- Privileges: only function owner can INSERT; application/operator get SELECT.
GRANT INSERT ON auth_authority_source_log TO gitwire_auth_fn_owner;
GRANT SELECT, UPDATE ON auth_authority_source_state TO gitwire_auth_fn_owner;

CREATE OR REPLACE FUNCTION transition_authority_source(
  p_expected_state authority_source_state,
  p_new_state      authority_source_state
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  affected int;
  v_session_user text := session_user;
BEGIN
  -- Legal transitions only:
  IF NOT (
    (p_expected_state = 'legacy-only'       AND p_new_state = 'shadow-evaluation') OR
    (p_expected_state = 'shadow-evaluation'  AND p_new_state IN ('dual-write', 'legacy-only')) OR
    (p_expected_state = 'dual-write'         AND p_new_state IN ('enforce', 'shadow-evaluation')) OR
    (p_expected_state = 'enforce'            AND p_new_state IN ('dual-write', 'legacy-retired')) OR
    -- legacy-retired is terminal: no transitions out, no self-transition
  ) THEN
    RAISE EXCEPTION 'Illegal authority-source transition: % → %',
      p_expected_state, p_new_state;
  END IF;

  UPDATE auth_authority_source_state
    SET state = p_new_state, updated_at = now(), updated_by = v_session_user
    WHERE id = 1 AND state = p_expected_state;

  GET DIAGNOSTICS affected = ROW_COUNT;

  -- Immutable transition audit record
  IF affected = 1 THEN
    INSERT INTO auth_authority_source_log (
      from_state, to_state, transitioned_by, transitioned_at
    ) VALUES (
      p_expected_state, p_new_state, v_session_user, now()
    );
  END IF;

  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION transition_authority_source(authority_source_state, authority_source_state)
  OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION transition_authority_source(authority_source_state, authority_source_state) FROM PUBLIC;
-- Operator-only: the application CANNOT promote to enforce/legacy-retired.
GRANT EXECUTE ON FUNCTION transition_authority_source(authority_source_state, authority_source_state) TO gitwire_operator;
```

**Identity binding.** The `transitioned_by` column records `session_user`
(the authenticated database session identity), not a caller-supplied
parameter. This prevents forged audit attribution. The same principle
applies to `operator_reconcile_execution`: the `p_operator_principal_id`
and `p_supervisor_session` parameters record the human operator's
intent, but the DB session identity (`session_user`) is captured
separately in the reconciliation log for forensic verification.

**Rollback:**
1. `DROP FUNCTION transition_authority_source(authority_source_state, authority_source_state);`
2. `DROP TRIGGER trg_authority_source_log_no_update ON auth_authority_source_log;`
3. `DROP TRIGGER trg_authority_source_log_no_delete ON auth_authority_source_log;`
4. `DROP FUNCTION enforce_authority_source_log_append_only;`
5. `DROP TABLE auth_authority_source_log;`
6. `DROP TABLE auth_authority_source_state;`

### Dependency-aware rollback graph

```
Roll back in this order (latest first):
  047 → 046 → 045 → 044 → 043 → 042 → 041 → 040 → 039 → 038
```

**Stage 047 also creates:** `archive_old_decisions()`,
`archive_old_reconciliation()`, `archive_old_attestations()`, and
`archive_old_break_glass()` functions (all tables exist by this
stage). Rollback of 047 drops these functions first (with exact
signatures: `archive_old_decisions(integer)`,
`archive_old_reconciliation(integer)`, `archive_old_attestations(integer)`,
`archive_old_break_glass(integer)`), then the authority-source log
triggers/functions, then the authority-source function, then tables.

Stages 043 and 045 are **irreversible after enforcement is active**
(they modify data that existing code depends on). After the
authority-source state reaches `enforce` or `legacy-retired`, rollback
of 043/045 requires forward-fix, not backward rollback.

---

## 22. Authority-source state machine

The migration proceeds through an explicit state machine that controls
which authority source is active at each phase. The state is stored in
`auth_authority_source_state` and transitions are via CAS
(`transition_authority_source()`).

| State | Authoritative read source | Authoritative write path | New evaluator | Legacy path | Unmapped/ambiguous keys |
|---|---|---|---|---|---|
| `legacy-only` | Legacy shared-key path | Legacy | Not running | Active (read/write) | Allowed by legacy path |
| `shadow-evaluation` | Legacy path | Legacy | Running (logging only, never affects response) | Active (read/write) | Two outcomes: (1) If the **legacy path** allows the request (including unmapped keys), the request proceeds — the legacy path is authoritative. (2) The **new evaluator** independently evaluates and logs its decision to `auth_authorization_decisions`, but its result is never returned to the caller. If the new evaluator would deny, it is logged but does not affect the response. Unmapped/ambiguous rows are reported to `migration_report` for resolution but do NOT cause a deny in the response. |
| `dual-write` | Legacy path | Both paths write | Running (logging only) | Active (read/write) | **Deny** in new evaluator; legacy may still allow if it has its own mapping |
| `enforce` | New evaluator | New evaluator | Authoritative (denies enforced) | Disabled for authorization (may still write audit for residual traffic) | **Deny** — unmapped keys deny in both paths; no fallback |
| `legacy-retired` | New evaluator | New evaluator | Authoritative | Removed | **Deny** — legacy code path removed |

**Exact read/write behavior at each state:**

- **`legacy-only`**: existing `API_KEY` middleware is authoritative.
  New `auth_*` tables are empty and unused. All reads and writes go
  through the legacy path.
- **`shadow-evaluation`**: the new evaluator runs alongside the legacy
  path. It evaluates every request and logs a decision to
  `auth_authorization_decisions`, but its result is **never returned to
  the caller**. The legacy path remains authoritative. If the new
  evaluator produces a deny, it is logged but does not affect the
  response. Unmapped legacy keys that the legacy path allows are
  flagged in `migration_report` for resolution — they are NOT denied
  in shadow mode.
- **`dual-write`**: same as shadow-evaluation for reads, but both
  paths now write audit/principal data. Legacy path still returns the
  authorization decision to the caller.
- **`enforce`**: the new evaluator is authoritative. Its decision is
  returned to the caller. If the new evaluator allows, the request
  proceeds. If it denies, the request is denied with the new reason
  code. The legacy path is disabled for authorization decisions.
  Unmapped keys that were allowed by legacy but cannot be resolved by
  the new evaluator are **denied** — there is no read-only fallback.
- **`legacy-retired`**: legacy code paths are removed. The new
  evaluator is the sole authority. Legacy-key table is archived.

**Transition rules:**
- `legacy-only → shadow-evaluation`: after stages 038–047 are applied and catalog seeded.
- `shadow-evaluation → dual-write`: after shadow logs show no unmapped critical principals/keys.
- `dual-write → enforce`: after dual-write comparison shows zero discrepancies for a monitoring period.
- `enforce → legacy-retired`: after all legacy keys are migrated or expired and zero legacy-path access for a monitoring period.

**Rollback points:** `shadow-evaluation` and `dual-write` can revert
to the prior state. `enforce` can revert to `dual-write` only if no
irreversible schema changes (stages 043/045) depend on enforcement.
`legacy-retired` is terminal.

---

## 23. Proof obligations and fixtures

**Honest classification.** W0-C defines schema structure and
constraints. The fixtures below are **specifications for W0-D
executable test cases**, not currently executable SQL files. They are
classified as:

- **(STORE)** — the schema can represent this valid state. W0-D will
  implement this as a transaction-wrapped INSERT that commits.
- **(REJECT)** — the schema rejects this invalid state via a constraint
  trigger or FK. W0-D will implement this as a transaction-wrapped
  INSERT that raises an exception with a specific SQLSTATE/message.
- **(EVAL)** — the runtime evaluator (implemented in Waves 1–4) must
  produce this decision from the stored inputs. W0-D will implement
  this as a unit test against the evaluator. The schema stores the
  inputs; the evaluator computes the outcome.

W0-C provides a **complete schema proof matrix** proving every W0-B
constraint and decision case has a representation in the schema, plus
rejection proofs for forbidden states.

### Schema proof matrix

This matrix maps every W0-B invariant to the schema mechanism that
enforces it. "Mechanism" identifies the specific FK, trigger, CHECK,
or function.

| W0-B invariant | Schema mechanism | Type |
|---|---|---|
| Only declared resource/action pairs in role permissions | Composite FK to `auth_resource_actions` on `auth_role_permissions` | STORE/REJECT |
| Only declared resource/action pairs in grants | `enforce_grant_action_valid()` trigger; allows `action='*'` wildcard | REJECT |
| Only declared resource/action pairs in ceilings | Composite FK on `auth_worker_ceiling_permissions` | REJECT |
| `queue_job` excluded from `auth_resource_grants` | `enforce_no_transport_in_grants()` trigger | REJECT |
| `queue_job` legal in `auth_worker_ceiling_permissions` | Not excluded from ceiling permissions (composite FK allows it) | STORE |
| Service principals cannot receive tenant roles | `enforce_no_tenant_roles_for_service()` trigger | REJECT |
| Non-service principals cannot receive ceilings | `enforce_ceiling_service_only()` trigger | REJECT |
| Non-service principals cannot be delegation workers | `enforce_delegation_worker_service()` trigger | REJECT |
| Bootstrap user may lack `github_user_id` | `enforce_principal_type_bindings()` allows `user` without `github_user_id` | STORE |
| `user` principals cannot have `installation_id` | `enforce_principal_type_bindings()` rejects | REJECT |
| `installation` principals must have `installation_id` | `enforce_principal_type_bindings()` requires | REJECT |
| Service principal cannot be retyped if ceilings/delegations exist | `enforce_no_subtype_retype_with_deps()` trigger | REJECT |
| Denied delegations are terminal | `enforce_denied_terminal()` trigger | REJECT |
| `executing` can only exit via stored functions | `enforce_no_direct_executing_transition()` + non-login function-owner role | REJECT |
| Claim CAS checks status+version+worker+revocation+expiry | `acquire_delegation_claim()` function | STORE/EVAL |
| Finalize is owner-checked and status-restricted | `finalize_delegation_claim()` function | STORE/EVAL |
| Operator reconciliation writes audit record | `operator_reconcile_execution()` inserts `auth_reconciliation_log` | STORE |
| Decisions are append-only | BEFORE UPDATE/DELETE triggers + INSERT/SELECT-only privileges | REJECT |
| Policy versions are append-only | BEFORE UPDATE/DELETE triggers | REJECT |
| Policy leaves validated against catalog | recursive `validate_policy_node()` in `enforce_policy_leaves_valid()` | REJECT |
| Policy hash verified | `enforce_policy_hash_matches()` trigger | REJECT |
| Decision action is concrete and catalog-valid | `enforce_decision_action_valid()` trigger | REJECT |
| Decision outcome/reason consistency | `chk_decision_outcome_consistency` CHECK | REJECT |
| Decision break-glass flag consistency | `chk_break_glass_consistency` CHECK | REJECT |
| Delegation has persisted normalized boundary | `boundary_*` columns in `auth_delegations` | STORE |
| Decision has immutable evaluated-input snapshot | JSONB snapshot columns in `auth_authorization_decisions` | STORE |
| Break-glass activation constraints | `enforce_break_glass_constraints()` trigger | REJECT |
| Authority-source transitions are CAS + legal-only | `transition_authority_source()` operator-only function | STORE/REJECT |
| Authority-source log is append-only | BEFORE UPDATE/DELETE triggers + INSERT-only privilege | REJECT |
| Role retirement consistency | `chk_role_retirement_active`/`chk_role_retirement_retired` CHECKs | REJECT |
| Reconciliation log captures DB session identity | `db_session_user` column set from `session_user` | STORE |

### Scope-product truth-table coverage (T1–T18)

Each case specifies the role and credential inputs and the expected
evaluator-derived scope. The schema stores these inputs; the evaluator
computes the scope. These are **(EVAL)** specifications for W0-D.

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

### Fixture F-READ-LIST: read without list denial (STORE + EVAL)

**(STORE)** — the schema stores a role with `repository:read` but not
`repository:list`. **(EVAL)** — the evaluator denies `repository:list`
with `role_permission_missing`.

```sql
-- W0-D fixture (specification, not currently executable file):
-- Setup: seed the resource catalog with ('repository', 'read') and
-- ('repository', 'list') in auth_resource_actions.
BEGIN;
  INSERT INTO auth_principals (id, principal_type, display_name)
    VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01', 'user', 'Read Only');
  INSERT INTO auth_roles (id, name) VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'read-only');
  INSERT INTO auth_role_permissions (role_id, permission_resource, permission_action)
    VALUES ('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'repository', 'read');
  -- STORE: this commits. The role has repository:read only.
  -- EVAL: evaluate_leaf for action='repository:list' checks:
  --   ('repository', 'list') IN (SELECT permission_resource, permission_action
  --                               FROM auth_role_permissions WHERE role_id = ...)
  --   → false → DENY(role_permission_missing)
  -- Note: 'repository:list' is NOT in the role's permissions.
  -- The composite FK on auth_role_permissions would accept ('repository','list')
  -- if it were inserted — the rejection here is by OMISSION, not by constraint.
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
  INSERT INTO auth_worker_ceilings (id, principal_id, role_name, granted_by)
    VALUES ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10',
            'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
            'service:heal-worker',
            'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a01');
  -- Normalized junction table (not text[] array):
  INSERT INTO auth_worker_ceiling_permissions (ceiling_id, permission_resource, permission_action)
    VALUES ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'repository', 'github:act'),
           ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'ci_run', 'update'),
           ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'heal_pr', 'update'),
           ('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a10', 'managed_action', 'update');
  -- EVAL: ceiling includes ('repository', 'github:act'). Delegation authorizes repo X.
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

## 24. Schema-smoke validation plan

**Wave 0 boundary.** Issue #77 limits Wave 0 to documentation, schema
design, and validation planning. This section defines the test
manifest, expected outcomes, and later-wave gates for the schema-smoke
procedure. **W0-D does not create executable migration files.** Those
belong to the authorized implementation wave after Wave 0 acceptance.

**What W0-D produces (validation artifacts only):**

1. **Test manifest** — a checklist mapping every fixture in §23 to its
   expected SQLSTATE, error message, or commit confirmation.
2. **Expected SQLSTATE catalog** — for each (REJECT) fixture, the exact
   PostgreSQL error code (e.g., `23514` for CHECK violation, `23503`
   for FK violation, `P0001` for RAISE EXCEPTION in trigger).
3. **Store/reject fixture specifications** — complete DML blocks with
   all required parent rows, valid UUIDs, and expected outcomes. These
   are specifications for the implementation wave to implement as test
   files, not executable SQL today.
4. **Later-wave gate definition** — the gate criteria that must be met
   before `shadow-evaluation` can begin: all (STORE) fixtures commit,
   all (REJECT) fixtures raise expected exceptions, rollback produces a
   clean database, and all constraint triggers fire correctly.

**What the implementation wave (post-W0-E) produces:**

- Executable migration files (`038_*.sql` through `047_*.sql`) derived
  from the DDL in this document.
- A schema-smoke test script that applies those migrations, runs the
  fixtures, and verifies outcomes against the W0-D manifest.
- The test runs against a throwaway PostgreSQL 16 database with
  `pgcrypto` and `uuid-ossp` extensions installed.

---

## 25. Retention and archival constraints

**Design choice: non-partitioned initial schema.** All authority tables
are created as ordinary (non-partitioned) tables with single-column UUID
primary keys. This avoids the PostgreSQL constraint that partitioned
tables must include the partition key in every unique index, which would
conflict with the single-column `id` primary keys and FKs used
throughout this design.

High-volume tables use **bounded row-level archival** (scheduled DELETE
jobs) instead of partition drops. If volume eventually requires
partitioning, a later implementation wave can convert these tables to
partitioned with a composite PK including the time column — but that is
out of scope for Wave 0.

**Retention dependency resolution.** Several long-lived records have FKs
to shorter-lived records. The decision snapshot (§11) already preserves
immutable JSONB copies of grants, credential scopes, and policy inputs
— so deleting the source records does not lose the evaluated context.
The following dependency rules apply:

| Long-lived record (365 days) | Short-lived dependency | Resolution |
|---|---|---|
| `auth_authorization_decisions` | `auth_external_attestations` (90 days) | Decision's `capability_snapshot` and JSONB snapshots contain the attestation inputs. FK is nullable (set to NULL when attestation is deleted); the snapshot retains the data. |
| `auth_authorization_decisions` | `auth_sessions` (30 days) | No direct FK to sessions. Break-glass activation has nullable session FK. Decision's snapshot retains session context. |
| `auth_break_glass_activations` (365 days) | `auth_sessions` (30 days) | `session_id` FK is nullable. When session is deleted, set `session_id = NULL` (via `ON DELETE SET NULL` on the FK); the activation record retains all other metadata. |

**All FKs to short-lived tables use `ON DELETE SET NULL`** (not
`NO ACTION`), so cleanup operations can delete expired records without
FK violations. The immutable JSONB snapshots in long-lived records
preserve the audit trail. The delegation→decision FK also uses
`ON DELETE SET NULL` so decision archival does not block on
durable delegation references.

**Archival mechanism.** Append-only tables (`auth_authorization_decisions`,
`auth_reconciliation_log`, `auth_authority_source_log`) have `BEFORE
DELETE` triggers that reject deletion by the application or operator.
These triggers exempt `gitwire_auth_fn_owner` (checked via
`current_user`). An archival function owned by this role performs the
age-based cleanup:

```sql
CREATE OR REPLACE FUNCTION archive_old_decisions(p_retention_days integer DEFAULT 365)
RETURNS integer
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  -- Retention floor: reject attempts to delete records younger than 365 days
  IF p_retention_days IS NULL OR p_retention_days < 365 THEN
    RAISE EXCEPTION 'archive_old_decisions: retention_days must be >= 365, got %',
      p_retention_days;
  END IF;

  DELETE FROM auth_authorization_decisions
    WHERE evaluated_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION archive_old_decisions(integer) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION archive_old_decisions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_old_decisions(integer) TO gitwire_operator;

-- DELETE grant: the function owner needs DELETE to remove old rows
-- (the append-only trigger exempts gitwire_auth_fn_owner).
GRANT DELETE ON auth_authorization_decisions TO gitwire_auth_fn_owner;

-- Reconciliation log archival (concrete, same pattern):
CREATE OR REPLACE FUNCTION archive_old_reconciliation(p_retention_days integer DEFAULT 365)
RETURNS integer
SECURITY DEFINER
SET search_path = gitwire_auth, pg_temp
AS $$
DECLARE
  deleted_count integer;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 365 THEN
    RAISE EXCEPTION 'archive_old_reconciliation: retention_days must be >= 365, got %',
      p_retention_days;
  END IF;

  DELETE FROM auth_reconciliation_log
    WHERE reconciled_at < now() - (p_retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION archive_old_reconciliation(integer) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION archive_old_reconciliation(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_old_reconciliation(integer) TO gitwire_operator;
GRANT DELETE ON auth_reconciliation_log TO gitwire_auth_fn_owner;
```

A scheduled job (cron, systemd timer) calls these functions daily. The
operator role executes them — the application cannot trigger archival.
Session cleanup uses a direct scheduled DELETE job (sessions are not
append-only and their deletion does not trigger FK updates on
append-only tables). Break-glass and attestation archival use
`SECURITY DEFINER` functions (see above) because their deletion
causes FK-driven `SET NULL` on the append-only decisions table.

**Retention table (non-partitioned, row-level archival):**

| Record type | Table | Min retention | Deletion mechanism |
|---|---|---|---|
| Authorization decisions | `auth_authorization_decisions` | 365 days | `archive_old_decisions(365)` — SECURITY DEFINER, operator-executable, bypasses append-only trigger |
| Reconciliation log | `auth_reconciliation_log` | 365 days | `archive_old_reconciliation(365)` — same pattern |
| Break-glass activations | `auth_break_glass_activations` | 365 days | `archive_old_break_glass(365)` — SECURITY DEFINER (FK SET NULL on append-only decisions fires under fn_owner) |
| Authority-source log | `auth_authority_source_log` | Indefinite | Never deleted (low volume) |
| External attestations | `auth_external_attestations` | 90 days | `archive_old_attestations(90)` — SECURITY DEFINER (FK SET NULL on append-only decisions fires under fn_owner) |
| Sessions | `auth_sessions` | 30 days after expiry/revocation | Scheduled job: `DELETE WHERE expires_at < now() - interval '30 days'` |
| Capability keys | `auth_capability_keys` | Until zero dependents | Set `retired_at`; manual DELETE after verified zero dependents |
| Legacy key mappings | `auth_legacy_key_map` | Until `legacy-retired` | Archive after state change; never DELETE until then |
| Policy versions | `auth_operation_policy_versions` | Indefinite (immutable) | Never |
| Bootstrap markers | `auth_bootstrap_allow` | Until consumed | `transition_bootstrap_state('disabled')` deletes them |
| Migration reports | `migration_report` | Until resolved + 90 days | Scheduled job: `DELETE WHERE resolved = true AND resolved_at < now() - interval '90 days'` |
| Principals/roles/grants | all `auth_*` identity tables | Indefinite (durable) | Never delete; soft-revoke only |

**Principle:** durable identity records (principals, credentials, roles,
grants, delegations) are never hard-deleted. Revocation
(`revoked_at`) is the lifecycle mechanism. Append-only tables
(decisions, reconciliation log) use the `SECURITY DEFINER` archival
functions described above (exempting `gitwire_auth_fn_owner` from the
append-only triggers). Policy versions are never deleted.

---

## 26. Unresolved schema risks

1. **Resource-type validation performance:** the composite FK to
   `auth_resource_actions` adds a JOIN per INSERT into role/grant/ceiling
   tables. At GitWire's scale this is negligible. Revisit if INSERT
   volume becomes significant.

2. **Decision table volume:** non-partitioned tables with row-level
   archival via `SECURITY DEFINER` functions are sufficient for
   GitWire's current scale. If volume grows significantly, a later
   implementation wave may convert high-volume tables to partitioned
   with composite PKs — but this is out of scope for Wave 0 and not a
   prerequisite for enforcement.

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
