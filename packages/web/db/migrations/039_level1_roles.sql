-- 039_level1_roles.sql
-- Level 1 authority core — roles, grants, SECURITY DEFINER functions,
-- ownership, and execution restrictions.
--
-- Boundary (per Wave 1 / issue #81):
--   * five database roles,
--   * column-level grants,
--   * all SECURITY DEFINER functions, their ownership, REVOKE FROM PUBLIC,
--     GRANT EXECUTE only to the intended boundary role.
--
-- Fail-closed policy: each Level 1 role is created with plain CREATE ROLE and
-- a DO block that raises duplicate_object explicitly rather than swallowing it.
-- A pre-existing role with the same name aborts the migration. No memberships
-- exist among the five roles.
--
-- All login roles are explicitly:
--   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
--   and LOGIN NOINHERIT for the four login roles; gitwire_auth_fn_owner is NOLOGIN.

SET search_path = gitwire_auth, pg_catalog;

-- ── 1. Roles ───────────────────────────────────────────────────────────────
-- Create each role. We catch duplicate_object only to re-raise it with a
-- clear message identifying the collision; we do NOT swallow it. The
-- surrounding transaction (scripts/migrate.js wraps each file in BEGIN/COMMIT)
-- rolls back the whole file on collision.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_auth_fn_owner') THEN
    CREATE ROLE gitwire_auth_fn_owner NOLOGIN;
  ELSE
    RAISE EXCEPTION 'colliding role already exists: gitwire_auth_fn_owner (Level 1 refuses to adopt a pre-existing role)';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_app') THEN
    CREATE ROLE gitwire_app
      LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'colliding role already exists: gitwire_app (Level 1 refuses to adopt a pre-existing role)';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_admission') THEN
    CREATE ROLE gitwire_admission
      LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'colliding role already exists: gitwire_admission (Level 1 refuses to adopt a pre-existing role)';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_executor') THEN
    CREATE ROLE gitwire_executor
      LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'colliding role already exists: gitwire_executor (Level 1 refuses to adopt a pre-existing role)';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gitwire_operator') THEN
    CREATE ROLE gitwire_operator
      LOGIN NOINHERIT
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    RAISE EXCEPTION 'colliding role already exists: gitwire_operator (Level 1 refuses to adopt a pre-existing role)';
  END IF;
END $$;

-- No memberships among the five roles. (No GRANT <role> TO <other role>.)
-- No passwords in migrations. Login roles receive credentials out-of-band.

-- ── 2. Schema usage grants ─────────────────────────────────────────────────
GRANT USAGE ON SCHEMA gitwire_auth
  TO gitwire_auth_fn_owner, gitwire_app, gitwire_admission, gitwire_executor, gitwire_operator;

-- ── 3. Table privileges (column-level separation) ──────────────────────────

-- gitwire_auth_fn_owner: only the lifecycle/admission columns it updates via
-- the CAS/admit functions, plus SELECT to find the row. It also updates the
-- bootstrap singleton and enforcement singleton through their functions.
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_auth_fn_owner;
GRANT UPDATE (lifecycle_state, lifecycle_version, transitioned_at,
              admitted, admitting_service)
  ON gitwire_auth.mutation_commands TO gitwire_auth_fn_owner;
GRANT SELECT ON gitwire_auth.auth_enforcement_state TO gitwire_auth_fn_owner;
GRANT UPDATE (state, updated_at, updated_by, evidence)
  ON gitwire_auth.auth_enforcement_state TO gitwire_auth_fn_owner;
GRANT SELECT ON gitwire_auth.auth_bootstrap_state TO gitwire_auth_fn_owner;
GRANT UPDATE (state, bootstrap_count, last_transition_at, last_transition_by)
  ON gitwire_auth.auth_bootstrap_state TO gitwire_auth_fn_owner;
GRANT SELECT, DELETE ON gitwire_auth.auth_bootstrap_recovery_markers TO gitwire_auth_fn_owner;
GRANT UPDATE (consumed_at, consumed_by_bootstrap)
  ON gitwire_auth.auth_bootstrap_recovery_markers TO gitwire_auth_fn_owner;
-- complete_bootstrap atomically creates the admin principal + credential +
-- fleet assignment, so the function owner needs INSERT on those tables.
-- It also resolves the canonical 'admin' role by name, so it needs SELECT on
-- auth_roles (read-only lookup; it does not mutate roles).
GRANT SELECT ON gitwire_auth.auth_roles TO gitwire_auth_fn_owner;
GRANT SELECT, INSERT, UPDATE (status, auth_epoch, updated_at)
  ON gitwire_auth.auth_principals TO gitwire_auth_fn_owner;
GRANT SELECT, INSERT, UPDATE (revoked_at, revoked_by, updated_at)
  ON gitwire_auth.auth_credentials TO gitwire_auth_fn_owner;
GRANT SELECT, INSERT ON gitwire_auth.auth_principal_roles TO gitwire_auth_fn_owner;

-- gitwire_app: everyday workers/routes. NO command INSERT (admission only),
-- NO role mutation, NO event/receipt INSERT.
GRANT SELECT, INSERT ON gitwire_auth.auth_principals TO gitwire_app;
GRANT UPDATE (status, auth_epoch, updated_at) ON gitwire_auth.auth_principals TO gitwire_app;
GRANT SELECT, INSERT ON gitwire_auth.auth_credentials TO gitwire_app;
GRANT UPDATE (revoked_at, revoked_by, updated_at) ON gitwire_auth.auth_credentials TO gitwire_app;
GRANT SELECT, INSERT ON gitwire_auth.auth_sessions TO gitwire_app;
GRANT UPDATE (revoked_at) ON gitwire_auth.auth_sessions TO gitwire_app;
GRANT DELETE ON gitwire_auth.auth_sessions TO gitwire_app;
GRANT SELECT ON gitwire_auth.auth_roles TO gitwire_app;
GRANT SELECT ON gitwire_auth.auth_role_permissions TO gitwire_app;
GRANT SELECT ON gitwire_auth.auth_principal_roles TO gitwire_app;
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_app;
GRANT SELECT ON gitwire_auth.mutation_events TO gitwire_app;
GRANT SELECT ON gitwire_auth.execution_receipts TO gitwire_app;
GRANT SELECT ON gitwire_auth.auth_enforcement_state TO gitwire_app;
GRANT SELECT ON gitwire_auth.auth_bootstrap_state TO gitwire_app;

-- gitwire_admission: trusted command-admission boundary. Creates+admits
-- commands, manages role assignments, emits admission events.
--
-- Command INSERT is COLUMN-LEVEL: admission may supply only the
-- caller-attributable provenance fields. The server-controlled admission and
-- lifecycle fields are excluded so a malicious/erroneous INSERT cannot forge
-- them (the BEFORE UPDATE immutability/lifecycle triggers do not constrain
-- initial INSERT, so column privileges are the enforcement boundary here):
--   id                -> excluded (DEFAULT gen_random_uuid)
--   admitted          -> excluded (column DEFAULT false; only admit_command sets true)
--   admitting_service -> excluded (NULL until admit_command)
--   lifecycle_version -> excluded (DEFAULT 0)
--   lifecycle_state   -> excluded (DEFAULT 'pending')
--   transitioned_at   -> excluded (NULL until a transition function runs)
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_admission;
GRANT INSERT (
  initiating_principal, requesting_service, authentication_method,
  target_installation_id, target_repository_id, target_organization,
  target_repository, target_resource_type, target_resource_id,
  operation, payload_hash, payload_canonical,
  auth_result_snapshot, auth_policy_version, assurance_profile,
  idempotency_key, extension, created_at
) ON gitwire_auth.mutation_commands TO gitwire_admission;
GRANT SELECT, INSERT ON gitwire_auth.auth_role_permissions TO gitwire_admission;
GRANT SELECT, INSERT ON gitwire_auth.auth_principal_roles TO gitwire_admission;
GRANT UPDATE (revoked_at) ON gitwire_auth.auth_principal_roles TO gitwire_admission;
GRANT SELECT, INSERT ON gitwire_auth.mutation_events TO gitwire_admission;

-- gitwire_executor: commands (read), execution events, receipts.
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_executor;
GRANT SELECT, INSERT ON gitwire_auth.mutation_events TO gitwire_executor;
GRANT SELECT, INSERT ON gitwire_auth.execution_receipts TO gitwire_executor;

-- gitwire_operator: inspect everything, transition enforcement state.
GRANT SELECT ON gitwire_auth.auth_principals TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_credentials TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_roles TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_role_permissions TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_principal_roles TO gitwire_operator;
GRANT SELECT ON gitwire_auth.mutation_commands TO gitwire_operator;
GRANT SELECT ON gitwire_auth.mutation_events TO gitwire_operator;
GRANT SELECT ON gitwire_auth.execution_receipts TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_sessions TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_enforcement_state TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_bootstrap_state TO gitwire_operator;
GRANT SELECT ON gitwire_auth.auth_bootstrap_recovery_markers TO gitwire_operator;
-- Operator may INSERT recovery markers (operator DB role); it CANNOT
-- authenticate to the application API and cannot complete bootstrap. The
-- INSERT is column-level on ONLY (consumer_secret_hash, pepper_version) —
-- created_by_db_session is NOT insertable by the operator; the column DEFAULT
-- current_user derives attribution from the database session, so an operator
-- cannot forge created_by_db_session.
GRANT INSERT (consumer_secret_hash, pepper_version)
  ON gitwire_auth.auth_bootstrap_recovery_markers TO gitwire_operator;

-- ── 4. SECURITY DEFINER functions ──────────────────────────────────────────
-- Each function: SECURITY DEFINER, a FIXED safe search_path, OWNER set to
-- gitwire_auth_fn_owner, REVOKE FROM PUBLIC, GRANT EXECUTE only to the
-- intended boundary role. Admission/execution caller checks use session_user
-- (the login role the caller actually authenticated as), not a parameter.

-- admit_command: the ONLY way admitted becomes true. Called by the trusted
-- admission path after authorization evaluation.
CREATE FUNCTION gitwire_auth.admit_command(
  p_command_id        uuid,
  p_admitting_service uuid
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  affected int;
BEGIN
  IF session_user != 'gitwire_admission' THEN
    RAISE EXCEPTION 'admit_command: only gitwire_admission may call this function';
  END IF;

  UPDATE mutation_commands
    SET admitted = true,
        admitting_service = p_admitting_service
    WHERE id = p_command_id
      AND admitted = false;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.admit_command(uuid, uuid) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.admit_command(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.admit_command(uuid, uuid) TO gitwire_admission;

-- transition_admission: pending→submitted, pending→cancelled, submitted→cancelled.
CREATE FUNCTION gitwire_auth.transition_admission(
  p_command_id     uuid,
  p_expected_state text,
  p_new_state      text,
  p_expected_ver   bigint
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  affected int;
BEGIN
  IF session_user != 'gitwire_admission' THEN
    RAISE EXCEPTION 'transition_admission: only gitwire_admission may call this function';
  END IF;

  IF NOT (
    (p_expected_state = 'pending' AND p_new_state IN ('submitted', 'cancelled')) OR
    (p_expected_state = 'submitted' AND p_new_state = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'transition_admission: illegal transition % → %',
      p_expected_state, p_new_state;
  END IF;

  UPDATE mutation_commands
    SET lifecycle_state = p_new_state,
        lifecycle_version = p_expected_ver + 1,
        transitioned_at = now()
    WHERE id = p_command_id
      AND lifecycle_state = p_expected_state
      AND lifecycle_version = p_expected_ver;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.transition_admission(uuid, text, text, bigint) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.transition_admission(uuid, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.transition_admission(uuid, text, text, bigint) TO gitwire_admission;

-- transition_execution: submitted→executing, executing→completed/failed.
CREATE FUNCTION gitwire_auth.transition_execution(
  p_command_id     uuid,
  p_expected_state text,
  p_new_state      text,
  p_expected_ver   bigint
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  affected int;
BEGIN
  IF session_user != 'gitwire_executor' THEN
    RAISE EXCEPTION 'transition_execution: only gitwire_executor may call this function';
  END IF;

  IF NOT (
    (p_expected_state = 'submitted' AND p_new_state = 'executing') OR
    (p_expected_state = 'executing' AND p_new_state IN ('completed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'transition_execution: illegal transition % → %',
      p_expected_state, p_new_state;
  END IF;

  -- The executor may only act on an ADMITTED command. An unadmitted command
  -- (admitted=false, e.g. a worker INSERT that bypassed the trusted admission
  -- path) must never reach execution. This closes the confused-deputy gap
  -- where a forged command could otherwise move submitted→executing.
  UPDATE mutation_commands
    SET lifecycle_state = p_new_state,
        lifecycle_version = p_expected_ver + 1,
        transitioned_at = now()
    WHERE id = p_command_id
      AND admitted = true
      AND lifecycle_state = p_expected_state
      AND lifecycle_version = p_expected_ver;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.transition_execution(uuid, text, text, bigint) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.transition_execution(uuid, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.transition_execution(uuid, text, text, bigint) TO gitwire_executor;

-- transition_enforcement_state: operator-driven cutover. updated_by is taken
-- from session_user, NOT a parameter, so a caller cannot forge attribution.
CREATE FUNCTION gitwire_auth.transition_enforcement_state(
  p_expected_state text,
  p_new_state       text,
  p_evidence        text
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  affected int;
BEGIN
  IF session_user != 'gitwire_operator' THEN
    RAISE EXCEPTION 'transition_enforcement_state: only gitwire_operator may call this function';
  END IF;

  IF p_evidence IS NULL OR p_evidence = '' THEN
    RAISE EXCEPTION 'transition_enforcement_state: evidence is required';
  END IF;

  IF NOT (
    (p_expected_state = 'observed'       AND p_new_state = 'enforce') OR
    (p_expected_state = 'enforce'        AND p_new_state IN ('executor_only', 'observed')) OR
    (p_expected_state = 'executor_only'  AND p_new_state IN ('legacy_removed', 'enforce')) OR
    (p_expected_state = 'legacy_removed' AND p_new_state = 'executor_only')
  ) THEN
    RAISE EXCEPTION 'Illegal enforcement-state transition: % → %',
      p_expected_state, p_new_state;
  END IF;

  UPDATE auth_enforcement_state
    SET state = p_new_state,
        updated_at = now(),
        updated_by = session_user,
        evidence = p_evidence
    WHERE id = 1 AND state = p_expected_state;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.transition_enforcement_state(text, text, text) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.transition_enforcement_state(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.transition_enforcement_state(text, text, text) TO gitwire_operator;

-- ── 5. Bootstrap SECURITY DEFINER functions (zero-administrator model) ──────
-- Owned by gitwire_auth_fn_owner (NOT gitwire_operator), per Wave 1 binding
-- architecture. Fresh state is 'enabled'; successful bootstrap atomically
-- creates the admin principal + credential + fleet assignment and disables
-- bootstrap. Re-enable requires an operator-inserted recovery marker; the
-- marker is validated by DERIVED-hash equality and consumed exactly once.
--
-- SECURITY CONTRACT (frozen, issue #81):
--   * Raw bootstrap/admin secrets NEVER enter PostgreSQL. The operator and
--     the bootstrap endpoint compute the derived consumer_secret_hash
--     OUTSIDE the database (HMAC-SHA256, salted by pepper_version) and pass
--     only the derived hash to these functions. The functions perform plain
--     equality comparison against the stored derived hash — no hmac() call,
--     no raw secret parameter.
--   * Recovery (re-bootstrap) is permitted ONLY when NO active
--     administrator exists (all are disabled/revoked). This is the "all
--     administrators locked out" recovery condition.
--   * created_by_db_session is database-derived (DEFAULT current_user); the
--     operator cannot set it, so attribution cannot be forged.

-- active_admin_exists: helper — true iff any principal holds a non-revoked
-- fleet-scoped admin assignment. Used to gate recovery on the "all admins
-- locked out" condition.
CREATE FUNCTION gitwire_auth.active_admin_exists()
RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n
    FROM auth_principal_roles apr
    JOIN auth_roles ar ON ar.id = apr.role_id
    JOIN auth_principals p ON p.id = apr.principal_id
    WHERE ar.name = 'admin'
      AND apr.scope_type = 'fleet'
      AND apr.revoked_at IS NULL
      AND p.status = 'active';
  RETURN v_n > 0;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.active_admin_exists() OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.active_admin_exists() FROM PUBLIC;
-- Internal helper used only by the bootstrap functions (same owner). No
-- EXECUTE grant to any login role.

-- enable_bootstrap_from_marker: operator has inserted a recovery marker
-- (with its DERIVED consumer_secret_hash). The caller supplies the SAME
-- derived hash; the function matches it by equality and flips state to
-- 'enabled' WITHOUT consuming the marker (consumption happens at
-- complete_bootstrap so re-enable + bootstrap are atomic per marker).
-- Recovery is permitted ONLY when no active administrator exists.
CREATE FUNCTION gitwire_auth.enable_bootstrap_from_marker(
  p_consumer_secret_hash text,
  p_pepper_version       integer
) RETURNS boolean
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  v_count int;
BEGIN
  IF session_user != 'gitwire_operator' THEN
    RAISE EXCEPTION 'enable_bootstrap_from_marker: only gitwire_operator may call this function';
  END IF;

  -- Recovery condition: permitted only when ALL administrators are locked out.
  IF gitwire_auth.active_admin_exists() THEN
    RAISE EXCEPTION 'enable_bootstrap_from_marker: recovery is blocked while an active administrator exists';
  END IF;

  -- Match the caller-supplied DERIVED hash against a stored unconsumed marker.
  -- No raw secret is accepted here; the operator must supply the derived hash.
  SELECT count(*) INTO v_count
    FROM auth_bootstrap_recovery_markers
    WHERE consumer_secret_hash = p_consumer_secret_hash
      AND pepper_version = p_pepper_version
      AND consumed_at IS NULL;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'enable_bootstrap_from_marker: no matching unconsumed recovery marker';
  END IF;

  UPDATE auth_bootstrap_state
    SET state = 'enabled',
        last_transition_at = now(),
        last_transition_by = session_user
    WHERE id = 1 AND state = 'disabled';

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.enable_bootstrap_from_marker(text, integer) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.enable_bootstrap_from_marker(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.enable_bootstrap_from_marker(text, integer) TO gitwire_operator;

-- complete_bootstrap: the bootstrap endpoint (running as gitwire_app) calls
-- this after collecting the new administrator's details. It atomically:
--   1. requires state = 'enabled';
--   2. requires the FIRST bootstrap (bootstrap_count = 0) OR a valid
--      unconsumed recovery marker (matched by DERIVED hash) AND no active
--      administrator (the lockout condition);
--   3. creates the admin principal, credential, and fleet role assignment;
--   4. consumes exactly one marker (if this was a recovery bootstrap);
--   5. flips state to 'disabled', increments bootstrap_count.
-- p_admin_secret_hash is the DERIVED hash of the new admin's secret (computed
-- by the bootstrap endpoint outside PostgreSQL). p_consumer_secret_hash is
-- the DERIVED recovery-secret hash (recovery path only). No raw secret is
-- accepted by this function.
CREATE FUNCTION gitwire_auth.complete_bootstrap(
  p_admin_display_name      text,
  p_credential_lookup_id    text,
  p_admin_secret_hash       text,
  p_admin_pepper_version    integer,
  p_admin_audience          text,
  p_admin_display_prefix    text,
  p_consumer_secret_hash    text,
  p_recovery_pepper_version integer
) RETURNS uuid
SECURITY DEFINER
SET search_path = gitwire_auth, pg_catalog
AS $$
DECLARE
  v_state          text;
  v_count          bigint;
  v_principal_id   uuid;
  v_role_id        uuid;
  v_marker_id      uuid;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'complete_bootstrap: only gitwire_app (the bootstrap endpoint) may call this function';
  END IF;

  SELECT state INTO v_state FROM auth_bootstrap_state WHERE id = 1 FOR UPDATE;
  IF v_state IS NULL OR v_state != 'enabled' THEN
    RAISE EXCEPTION 'complete_bootstrap: bootstrap is not enabled';
  END IF;

  SELECT bootstrap_count INTO v_count FROM auth_bootstrap_state WHERE id = 1;

  IF v_count = 0 THEN
    -- First bootstrap: no recovery marker required (fresh deploy, no admins).
    v_marker_id := NULL;
  ELSE
    -- Re-bootstrap (recovery): require (a) no active administrator (lockout)
    -- AND (b) a matching unconsumed recovery marker, matched by DERIVED hash.
    IF gitwire_auth.active_admin_exists() THEN
      RAISE EXCEPTION 'complete_bootstrap: recovery is blocked while an active administrator exists';
    END IF;
    SELECT id INTO v_marker_id
      FROM auth_bootstrap_recovery_markers
      WHERE consumer_secret_hash = p_consumer_secret_hash
        AND pepper_version = p_recovery_pepper_version
        AND consumed_at IS NULL
      FOR UPDATE;
    IF v_marker_id IS NULL THEN
      RAISE EXCEPTION 'complete_bootstrap: no matching unconsumed recovery marker for re-bootstrap';
    END IF;
  END IF;

  -- Resolve the canonical admin role (seeded by 040).
  SELECT id INTO v_role_id FROM auth_roles WHERE name = 'admin' AND is_builtin;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'complete_bootstrap: canonical admin role not found';
  END IF;

  -- Create the administrator principal.
  INSERT INTO auth_principals (principal_type, display_name)
    VALUES ('user', p_admin_display_name)
    RETURNING id INTO v_principal_id;

  -- Create the administrator credential (derived hash only).
  INSERT INTO auth_credentials (principal_id, lookup_id, secret_hash,
        pepper_version, audience, display_prefix)
    VALUES (v_principal_id, p_credential_lookup_id, p_admin_secret_hash,
        p_admin_pepper_version, p_admin_audience, p_admin_display_prefix);

  -- Fleet-scoped admin assignment. granted_by = the new admin itself (the
  -- bootstrap has no prior admin to attribute to).
  INSERT INTO auth_principal_roles (principal_id, role_id, scope_type, granted_by)
    VALUES (v_principal_id, v_role_id, 'fleet', v_principal_id);

  -- Consume exactly one marker (recovery path only).
  IF v_marker_id IS NOT NULL THEN
    UPDATE auth_bootstrap_recovery_markers
      SET consumed_at = now(),
          consumed_by_bootstrap = v_count + 1
      WHERE id = v_marker_id AND consumed_at IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'complete_bootstrap: recovery marker was consumed concurrently';
    END IF;
  END IF;

  -- Disable bootstrap + record the transition.
  UPDATE auth_bootstrap_state
    SET state = 'disabled',
        bootstrap_count = bootstrap_count + 1,
        last_transition_at = now(),
        last_transition_by = session_user
    WHERE id = 1;

  RETURN v_principal_id;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION gitwire_auth.complete_bootstrap(
  text, text, text, integer, text, text, text, integer
) OWNER TO gitwire_auth_fn_owner;
REVOKE ALL ON FUNCTION gitwire_auth.complete_bootstrap(
  text, text, text, integer, text, text, text, integer
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gitwire_auth.complete_bootstrap(
  text, text, text, integer, text, text, text, integer
) TO gitwire_app;

RESET search_path;
