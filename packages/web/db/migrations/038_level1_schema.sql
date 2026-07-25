-- 038_level1_schema.sql
-- Level 1 authority core — schema, tables, indexes, SECURITY INVOKER triggers.
--
-- Boundary (per Wave 1 / issue #81):
--   * extensions, gitwire_auth schema, tables, indexes,
--   * SECURITY INVOKER trigger functions and triggers.
--   * Roles, grants, and all SECURITY DEFINER functions live in 039.
--   * Canonical built-in roles/permissions and initial bootstrap state live in 040.
--
-- Fail-closed policy: Level 1 schema objects use plain CREATE (no IF NOT EXISTS
-- for tables/indexes/triggers/functions) so an unexpected collision aborts the
-- migration rather than silently adopting a foreign object. Only the shared
-- extension and the schema itself use IF NOT EXISTS, as permitted for shared
-- bootstrap (Wave 1 "Binding architecture": shared extensions may use
-- CREATE EXTENSION IF NOT EXISTS).
--
-- Atomicity: scripts/migrate.js wraps each file in BEGIN/COMMIT, so a
-- fail-closed abort rolls back the whole file cleanly.

-- Shared extension bootstrap (permitted). pgcrypto provides digest()/hmac()
-- used by the recovery-marker hash validation SECURITY DEFINER function in 039.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Dedicated schema. IF NOT EXISTS is permitted here (shared bootstrap); CREATE
-- is revoked from PUBLIC below so only the migration owner can add objects.
CREATE SCHEMA IF NOT EXISTS gitwire_auth;
REVOKE CREATE ON SCHEMA gitwire_auth FROM PUBLIC;

-- All Level 1 DDL is fully qualified to gitwire_auth so the effective
-- search_path cannot redirect object creation.
SET search_path = gitwire_auth, pg_catalog;

-- ── auth_principals ────────────────────────────────────────────────────────
-- Server-owned human/service identities. The principal is derived from the
-- authenticated credential, never from a client-supplied header.
CREATE TABLE gitwire_auth.auth_principals (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type  text        NOT NULL CHECK (principal_type IN
                                ('user', 'service', 'installation', 'system', 'legacy-key')),
  display_name    text        NOT NULL,
  status          text        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'disabled')),
  github_user_id  bigint      UNIQUE,
  installation_id bigint,
  auth_epoch      bigint      NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Subtype constraints (level-1-core.md §3):
  CONSTRAINT chk_user_no_installation
    CHECK (principal_type != 'user' OR installation_id IS NULL),
  CONSTRAINT chk_service_no_external
    CHECK (principal_type != 'service'
           OR (github_user_id IS NULL AND installation_id IS NULL)),
  CONSTRAINT chk_installation_binding
    CHECK (principal_type != 'installation'
           OR (installation_id IS NOT NULL AND github_user_id IS NULL)),
  CONSTRAINT chk_system_no_external
    CHECK (principal_type != 'system'
           OR (github_user_id IS NULL AND installation_id IS NULL)),
  CONSTRAINT chk_legacy_no_external
    CHECK (principal_type != 'legacy-key'
           OR (github_user_id IS NULL AND installation_id IS NULL))
);

CREATE UNIQUE INDEX ux_auth_principals_github_user_id
  ON gitwire_auth.auth_principals (github_user_id)
  WHERE github_user_id IS NOT NULL;
CREATE UNIQUE INDEX ux_auth_principals_installation_id
  ON gitwire_auth.auth_principals (installation_id)
  WHERE installation_id IS NOT NULL;

-- ── auth_credentials ───────────────────────────────────────────────────────
-- Lookup-by-id + HMAC-verify-the-secret model. Only the derived secret hash
-- is stored; raw secrets never enter SQL or the repository.
CREATE TABLE gitwire_auth.auth_credentials (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  lookup_id       text        NOT NULL UNIQUE,
  secret_hash     text        NOT NULL,
  pepper_version  integer     NOT NULL,
  audience        text        NOT NULL,
  environment     text        NOT NULL DEFAULT 'production',
  display_prefix  text        NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  revoked_by      uuid        REFERENCES gitwire_auth.auth_principals(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_auth_credentials_principal
  ON gitwire_auth.auth_credentials (principal_id)
  WHERE revoked_at IS NULL;

-- ── auth_roles ─────────────────────────────────────────────────────────────
-- Named permission sets. is_builtin marks the canonical roles seeded in 040.
CREATE TABLE gitwire_auth.auth_roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL UNIQUE,
  description text,
  is_builtin  boolean     NOT NULL DEFAULT false,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  retired_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── auth_role_permissions ──────────────────────────────────────────────────
-- '<resource_type>:<action>' tokens attached to a role.
CREATE TABLE gitwire_auth.auth_role_permissions (
  role_id     uuid        NOT NULL REFERENCES gitwire_auth.auth_roles(id),
  permission  text        NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- ── auth_principal_roles ───────────────────────────────────────────────────
-- Assigns roles to principals with a scope. fleet/system scopes require
-- NULL scope_id; installation/repository require a non-null scope_id.
CREATE TABLE gitwire_auth.auth_principal_roles (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  role_id         uuid        NOT NULL REFERENCES gitwire_auth.auth_roles(id),
  scope_type      text        NOT NULL CHECK (scope_type IN
                                ('installation', 'repository', 'fleet', 'system')),
  scope_id        bigint,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  granted_by      uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  expires_at      timestamptz,
  revoked_at      timestamptz,
  CONSTRAINT chk_scope_id_required
    CHECK ((scope_type IN ('installation', 'repository')) = (scope_id IS NOT NULL)),
  CONSTRAINT chk_scope_id_null_fleet_system
    CHECK (scope_type NOT IN ('fleet', 'system') OR scope_id IS NULL)
);

CREATE INDEX ix_auth_principal_roles_active
  ON gitwire_auth.auth_principal_roles (principal_id)
  WHERE revoked_at IS NULL;

-- ── mutation_commands ──────────────────────────────────────────────────────
-- Immutable mutation command with durable provenance. Only lifecycle_state,
-- lifecycle_version, and transitioned_at may change, and only via the CAS
-- SECURITY DEFINER functions in 039. admitted may flip false→true exactly
-- once via admit_command (039).
CREATE TABLE gitwire_auth.mutation_commands (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  initiating_principal   uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  requesting_service     uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  authentication_method  text        NOT NULL CHECK (authentication_method IN
                                     ('api_key', 'session', 'github_oauth', 'webhook_hmac')),
  target_installation_id bigint      NOT NULL,
  target_repository_id   bigint      NOT NULL,
  target_organization    text        NOT NULL,
  target_repository      text        NOT NULL,
  target_resource_type   text        NOT NULL,
  target_resource_id     text,
  operation              text        NOT NULL,
  payload_hash           text        NOT NULL,
  payload_canonical      jsonb       NOT NULL,
  auth_result_snapshot   jsonb       NOT NULL,
  auth_policy_version    text        NOT NULL,
  assurance_profile      text        NOT NULL DEFAULT 'level1',
  admitted               boolean     NOT NULL DEFAULT false,
  admitting_service      uuid        REFERENCES gitwire_auth.auth_principals(id),
  idempotency_key        text        NOT NULL,
  lifecycle_version      bigint      NOT NULL DEFAULT 0,
  lifecycle_state        text        NOT NULL DEFAULT 'pending'
                                     CHECK (lifecycle_state IN
                                     ('pending', 'submitted', 'executing', 'completed', 'failed', 'cancelled')),
  extension              jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  transitioned_at        timestamptz,
  CONSTRAINT ux_mutation_commands_idempotency
    UNIQUE (target_installation_id, target_repository_id, operation, idempotency_key)
);

-- ── mutation_events ────────────────────────────────────────────────────────
-- Append-only event trail. INSERT authority is partitioned by event_source and
-- the caller's current_user (enforced by the trigger below).
CREATE TABLE gitwire_auth.mutation_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid        NOT NULL REFERENCES gitwire_auth.mutation_commands(id),
  event_type      text        NOT NULL CHECK (event_type IN
                     ('admitted', 'submitted', 'started', 'succeeded', 'failed', 'cancelled', 'reconciled')),
  actor_principal uuid        REFERENCES gitwire_auth.auth_principals(id),
  event_source    text        NOT NULL CHECK (event_source IN ('admission', 'executor', 'reconciler')),
  event_data      jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_mutation_events_command
  ON gitwire_auth.mutation_events (command_id, occurred_at DESC);

-- ── execution_receipts ─────────────────────────────────────────────────────
-- GitHub response evidence. Only the executor may INSERT (039 grants); the
-- application has SELECT only. Append-only via trigger below.
-- (Distinct from the public.execution_receipts table added by migration 034,
-- which is content-addressed sandbox evidence; this table is authority evidence.)
CREATE TABLE gitwire_auth.execution_receipts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid        NOT NULL REFERENCES gitwire_auth.mutation_commands(id),
  github_endpoint text        NOT NULL,
  github_status   integer,
  github_response jsonb,
  github_oid      text,
  executed_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_execution_receipts_command
  ON gitwire_auth.execution_receipts (command_id, executed_at DESC);

-- ── auth_sessions ──────────────────────────────────────────────────────────
-- Session tokens with epoch pinning for immediate revocation.
CREATE TABLE gitwire_auth.auth_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  session_hash    text        NOT NULL UNIQUE,
  pepper_version  integer     NOT NULL,
  auth_epoch      bigint      NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  ip_address      inet,
  user_agent      text
);

CREATE INDEX ix_auth_sessions_principal
  ON gitwire_auth.auth_sessions (principal_id)
  WHERE revoked_at IS NULL;

-- ── auth_enforcement_state ─────────────────────────────────────────────────
-- Singleton cutover state machine (observed → enforce → executor_only →
-- legacy_removed). Seeded in 038 (default 'observed') because the singleton row
-- is structural — the 040 seed only carries canonical roles/permissions and
-- bootstrap state. Transitions occur only via transition_enforcement_state (039).
CREATE TABLE gitwire_auth.auth_enforcement_state (
  id          integer PRIMARY KEY DEFAULT 1,
  state       text NOT NULL DEFAULT 'observed'
              CHECK (state IN ('observed', 'enforce', 'executor_only', 'legacy_removed')),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  evidence    text,
  CONSTRAINT chk_single_row CHECK (id = 1)
);

INSERT INTO gitwire_auth.auth_enforcement_state (id, state) VALUES (1, 'observed')
  ON CONFLICT (id) DO NOTHING;

-- ── auth_bootstrap_state (singleton) ───────────────────────────────────────
-- Zero-administrator bootstrap model (Wave 1 binding architecture). Fresh
-- state is 'enabled'. Successful bootstrap atomically creates the admin
-- principal + credential + fleet assignment and flips state to 'disabled'.
-- Re-enable requires a recovery marker (auth_bootstrap_recovery_markers)
-- whose derived consumer-secret hash is validated by the bootstrap function.
-- Transitions occur only via the bootstrap SECURITY DEFINER functions in 039,
-- which are owned by gitwire_auth_fn_owner (NOT gitwire_operator).
CREATE TABLE gitwire_auth.auth_bootstrap_state (
  id              integer PRIMARY KEY DEFAULT 1,
  state           text NOT NULL DEFAULT 'enabled'
                  CHECK (state IN ('enabled', 'disabled')),
  bootstrap_count bigint NOT NULL DEFAULT 0,
  last_transition_at timestamptz,
  last_transition_by text,
  CONSTRAINT chk_bootstrap_single_row CHECK (id = 1)
);

INSERT INTO gitwire_auth.auth_bootstrap_state (id, state) VALUES (1, 'enabled')
  ON CONFLICT (id) DO NOTHING;

-- ── auth_bootstrap_recovery_markers ────────────────────────────────────────
-- Operator-inserted recovery markers for re-enabling bootstrap after lockout.
-- Only the DERIVED consumer_secret_hash is stored; the raw consumer secret
-- never enters SQL, the repository, logs, or proof evidence. A marker is
-- consumed exactly once by complete_bootstrap (039), which validates the
-- caller-supplied secret against this hash before re-enabling.
CREATE TABLE gitwire_auth.auth_bootstrap_recovery_markers (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_secret_hash text        NOT NULL UNIQUE,
  pepper_version       integer     NOT NULL,
  created_by_db_session text       NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  consumed_at          timestamptz,
  consumed_by_bootstrap bigint
);

-- ── SECURITY INVOKER trigger functions ─────────────────────────────────────
-- These run with the privileges of the calling role (the table owner by
-- default for the trigger firing role). They enforce data invariants only;
-- they do not elevate privilege. The SECURITY DEFINER admission/CAS/transition
-- functions live in 039.

-- Legal lifecycle transition + version-increment enforcement.
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_legal_lifecycle_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    (OLD.lifecycle_state = 'pending'   AND NEW.lifecycle_state IN ('submitted', 'cancelled')) OR
    (OLD.lifecycle_state = 'submitted'  AND NEW.lifecycle_state IN ('executing', 'cancelled')) OR
    (OLD.lifecycle_state = 'executing'  AND NEW.lifecycle_state IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'Illegal lifecycle transition: % → %',
      OLD.lifecycle_state, NEW.lifecycle_state;
  END IF;

  IF NEW.lifecycle_version != OLD.lifecycle_version + 1 THEN
    RAISE EXCEPTION 'lifecycle_version must increment exactly once: expected %, got %',
      OLD.lifecycle_version + 1, NEW.lifecycle_version;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_legal_lifecycle_transition
  BEFORE UPDATE OF lifecycle_state, lifecycle_version ON gitwire_auth.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_legal_lifecycle_transition();

-- Provenance immutability. Admission fields allow exactly one false→true flip
-- (set by admit_command in 039); once true, neither admitted nor
-- admitting_service may change.
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_command_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.initiating_principal != OLD.initiating_principal
     OR NEW.requesting_service != OLD.requesting_service
     OR NEW.authentication_method != OLD.authentication_method
     OR NEW.target_installation_id != OLD.target_installation_id
     OR NEW.target_repository_id != OLD.target_repository_id
     OR NEW.target_organization != OLD.target_organization
     OR NEW.target_repository != OLD.target_repository
     OR NEW.target_resource_type != OLD.target_resource_type
     OR NEW.target_resource_id IS DISTINCT FROM OLD.target_resource_id
     OR NEW.operation != OLD.operation
     OR NEW.payload_hash != OLD.payload_hash
     OR NEW.payload_canonical != OLD.payload_canonical
     OR NEW.auth_result_snapshot != OLD.auth_result_snapshot
     OR NEW.auth_policy_version != OLD.auth_policy_version
     OR NEW.idempotency_key != OLD.idempotency_key
     OR NEW.extension IS DISTINCT FROM OLD.extension
     OR NEW.created_at != OLD.created_at THEN
    RAISE EXCEPTION 'mutation_commands provenance fields are immutable';
  END IF;

  IF OLD.admitted = true THEN
    IF NEW.admitted != OLD.admitted
       OR NEW.admitting_service IS DISTINCT FROM OLD.admitting_service THEN
      RAISE EXCEPTION 'admitted commands cannot have admission fields changed';
    END IF;
  ELSIF NEW.admitted = false AND OLD.admitted = false THEN
    IF NEW.admitting_service IS DISTINCT FROM OLD.admitting_service THEN
      RAISE EXCEPTION 'admitting_service cannot be set except via admit_command';
    END IF;
  END IF;
  -- false→true with admitting_service set: allowed (the admission transition).

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_command_immutability
  BEFORE UPDATE ON gitwire_auth.mutation_commands
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_command_immutability();

-- Event-source partitioning: bind event_type to event_source AND to the
-- current_user of the inserter. Admission events require source='admission'
-- and current_user='gitwire_admission'; execution events require source=
-- 'executor' and current_user='gitwire_executor'. This prevents a compromised
-- worker from forging events even if it obtained INSERT privilege.
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_event_source_partition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.event_type IN ('admitted', 'submitted', 'cancelled') THEN
    IF NEW.event_source != 'admission' THEN
      RAISE EXCEPTION '% events must have source admission, got %', NEW.event_type, NEW.event_source;
    END IF;
    IF current_user != 'gitwire_admission' THEN
      RAISE EXCEPTION '% events can only be inserted by gitwire_admission', NEW.event_type;
    END IF;
  ELSIF NEW.event_type IN ('started', 'succeeded', 'failed', 'reconciled') THEN
    IF NEW.event_source != 'executor' THEN
      RAISE EXCEPTION '% events must have source executor, got %', NEW.event_type, NEW.event_source;
    END IF;
    IF current_user != 'gitwire_executor' THEN
      RAISE EXCEPTION '% events can only be inserted by gitwire_executor', NEW.event_type;
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown event type: %', NEW.event_type;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_event_source_partition
  BEFORE INSERT ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_event_source_partition();

-- Append-only enforcement for events and receipts. No owner exemption,
-- no cleanup path — Level 1 retains these indefinitely.
CREATE OR REPLACE FUNCTION gitwire_auth.enforce_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'mutation_events is append-only';
END;
$$;

CREATE TRIGGER trg_events_no_update
  BEFORE UPDATE ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_events_append_only();
CREATE TRIGGER trg_events_no_delete
  BEFORE DELETE ON gitwire_auth.mutation_events
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_events_append_only();

CREATE OR REPLACE FUNCTION gitwire_auth.enforce_receipts_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'execution_receipts is append-only';
END;
$$;

CREATE TRIGGER trg_receipts_no_update
  BEFORE UPDATE ON gitwire_auth.execution_receipts
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_receipts_append_only();
CREATE TRIGGER trg_receipts_no_delete
  BEFORE DELETE ON gitwire_auth.execution_receipts
  FOR EACH ROW EXECUTE FUNCTION gitwire_auth.enforce_receipts_append_only();

RESET search_path;
