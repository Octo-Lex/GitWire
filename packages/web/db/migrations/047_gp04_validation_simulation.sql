-- Migration 047: GP-04 validation and simulation evidence
-- Governed Policy Authority (issue #100, GP-04).
--
-- Implements finalize_policy_evaluation: a single atomic SECURITY DEFINER function
-- that validates pre-computed evidence, persists it, and transitions the change
-- request from submitted to either awaiting_approval (success) or rejected (failure).
--
-- All computation (validation, simulation, risk classification) happens in Node.js
-- while the request remains submitted. This function receives only the pre-computed
-- result jsonb objects and engine version strings. It itself computes the
-- authoritative evidence hashes, inserts evidence rows, transitions state, and
-- emits exactly one transition event.
--
-- Binding design decisions (architecture review 5173510563):
--   1. Direct finalization: submitted → awaiting_approval (success) or rejected (failure)
--   2. Server-derived risk: embedded in simulation result envelope (hashed)
--   3. Node.js computes; SQL persists and transitions
--   4. Single atomic function — no separable evidence creation
--   5. Mandatory function provenance (GP-03 pattern)
--   6. Evidence hash binds to: schema_version, version_id, content_hash, engine_version, result
--
-- Forward migration is FAIL-CLOSED: plain CREATE TABLE / CREATE FUNCTION (no IF NOT EXISTS).

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Schema additions
-- ════════════════════════════════════════════════════════════════════════════

-- Function provenance metadata (mandatory, same pattern as GP-03)
CREATE TABLE gp04_function_provenance (
  proname           text        NOT NULL,
  identity_args     text        NOT NULL,
  prosrc_hash       text        NOT NULL,
  ret_type          text        NOT NULL,
  lang_name         text        NOT NULL,
  owner_name        text        NOT NULL,
  prosecdef         boolean     NOT NULL,
  proconfig         text        NOT NULL,
  acl_canonical     text        NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (proname, identity_args)
);

REVOKE ALL ON gp04_function_provenance FROM PUBLIC;
REVOKE ALL ON gp04_function_provenance FROM gitwire_app;
REVOKE ALL ON gp04_function_provenance FROM gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- Grants: GP-04 owns only the incremental INSERT on evidence tables.
-- GP-03 (migration 046) already grants SELECT on both to fn_owner.
-- ════════════════════════════════════════════════════════════════════════════

GRANT INSERT ON policy_validation_evidence TO gitwire_policy_fn_owner;
GRANT INSERT ON policy_simulation_evidence TO gitwire_policy_fn_owner;

-- ACL normalization: revoke direct writes from gitwire_app (table + column level)
REVOKE INSERT, UPDATE, DELETE ON policy_validation_evidence FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_simulation_evidence FROM gitwire_app;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname, c.relname, a.attname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'gitwire_policy'
      AND c.relname IN ('policy_validation_evidence','policy_simulation_evidence')
      AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I) ON %I.%I FROM gitwire_app', r.attname, r.attname, r.nspname, r.relname);
  END LOOP;
END $$;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function: finalize_policy_evaluation
-- Single atomic finalizer. Computes evidence hashes, inserts evidence,
-- transitions state, emits exactly one transition event.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

CREATE FUNCTION finalize_policy_evaluation(
  p_change_request_id uuid,
  p_expected_state_revision bigint,
  p_validation_result jsonb,
  p_validator_version text,
  p_simulation_result jsonb,
  p_evaluator_version text,
  p_actor_principal_id uuid
) RETURNS TABLE (
  change_request_id uuid,
  state text,
  state_revision bigint,
  validation_evidence_hash text,
  simulation_evidence_hash text
)
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_cr RECORD;
  v_version RECORD;
  v_validation_valid boolean;
  v_simulation_passed boolean;
  v_val_envelope jsonb;
  v_sim_envelope jsonb;
  v_val_hash text;
  v_sim_hash text;
  v_risk_classification text;
  v_new_state text;
  v_new_revision bigint;
  v_now timestamptz;
  v_is_author boolean;
  v_is_admin boolean;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: caller must be gitwire_app, got %', session_user;
  END IF;

  -- Validate required params
  IF p_change_request_id IS NULL OR p_expected_state_revision IS NULL
     OR p_validation_result IS NULL OR p_validator_version IS NULL
     OR p_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: required parameters missing';
  END IF;

  -- Lock the change request FOR UPDATE (single serialization domain)
  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: change request % not found', p_change_request_id;
  END IF;

  -- CAS: must be in submitted state with expected revision
  IF v_cr.state != 'submitted' THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: change request is in state %, only submitted can be finalized', v_cr.state;
  END IF;
  IF v_cr.state_revision != p_expected_state_revision THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: CAS failed — expected revision %, current %',
      p_expected_state_revision, v_cr.state_revision;
  END IF;

  -- Require a selected version
  IF v_cr.selected_version_id IS NULL THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: no selected version';
  END IF;

  -- Sample clock_timestamp() AFTER acquiring the lock
  v_now := clock_timestamp();

  -- Load the immutable version and its content hash
  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: selected version not found';
  END IF;

  -- Actor eligibility (checked after locking, using clock_timestamp):
  -- must be active principal AND (the request author OR an active fleet admin)
  SELECT EXISTS(SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active')
    INTO v_is_author;
  IF NOT v_is_author THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: actor principal is not active';
  END IF;

  v_is_author := (v_cr.author_principal_id = p_actor_principal_id);
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_principals p ON p.id = pr.principal_id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND r.status = 'active'
      AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND p.status = 'active'
  ) INTO v_is_admin;

  IF NOT v_is_author AND NOT v_is_admin THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: actor must be the request author or an active fleet admin';
  END IF;

  -- Extract validation result's 'valid' boolean (must be JSON boolean, not string)
  IF jsonb_typeof(p_validation_result->'valid') IS NULL THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: validation_result.valid is missing';
  END IF;
  IF jsonb_typeof(p_validation_result->'valid') != 'boolean' THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: validation_result.valid must be a JSON boolean, got %',
      jsonb_typeof(p_validation_result->'valid');
  END IF;
  v_validation_valid := (p_validation_result->>'valid')::boolean;

  -- Build validation evidence envelope and compute hash
  v_val_envelope := jsonb_build_object(
    'schema_version', 'gp04.validation.v1',
    'version_id', v_version.id,
    'content_hash', v_version.content_hash,
    'validator_version', p_validator_version,
    'result', p_validation_result
  );
  v_val_hash := 'sha256:' || pg_catalog.encode(public.digest(convert_to(canonical_jsonb(v_val_envelope), 'UTF8'), 'sha256'), 'hex');

  -- Insert validation evidence
  INSERT INTO policy_validation_evidence (version_id, evidence_hash, result, validator_version)
  VALUES (v_version.id, v_val_hash, v_val_envelope, p_validator_version);

  -- If validation failed, transition to rejected (skip simulation)
  IF NOT v_validation_valid THEN
    v_new_state := 'rejected';
    v_sim_hash := NULL;
    v_risk_classification := NULL;

    -- CAS transition: submitted → rejected
    UPDATE policy_change_requests
    SET state = 'rejected', state_revision = state_revision + 1, updated_at = now()
    WHERE id = p_change_request_id AND state = 'submitted' AND state_revision = p_expected_state_revision
    RETURNING state_revision INTO v_new_revision;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'finalize_policy_evaluation: CAS failed during rejection transition';
    END IF;

    -- Emit rejection event (never uses to_state='awaiting_approval')
    INSERT INTO policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
    VALUES (p_change_request_id, 'validation_rejected', 'submitted', 'rejected', p_actor_principal_id,
      jsonb_build_object(
        'validation_evidence_hash', v_val_hash,
        'version_id', v_version.id,
        'state_revision', v_new_revision
      ));

    RETURN QUERY SELECT p_change_request_id, 'rejected'::text, v_new_revision, v_val_hash, NULL::text;
    RETURN;
  END IF;

  -- Validation passed — require simulation result
  IF p_simulation_result IS NULL OR p_evaluator_version IS NULL THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: simulation_result and evaluator_version are required when validation passes';
  END IF;

  -- Extract simulation result's 'passed' boolean (must be JSON boolean)
  IF jsonb_typeof(p_simulation_result->'passed') IS NULL THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: simulation_result.passed is missing';
  END IF;
  IF jsonb_typeof(p_simulation_result->'passed') != 'boolean' THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: simulation_result.passed must be a JSON boolean, got %',
      jsonb_typeof(p_simulation_result->'passed');
  END IF;
  v_simulation_passed := (p_simulation_result->>'passed')::boolean;

  -- Extract risk_classification from the simulation result envelope (server-derived)
  v_risk_classification := p_simulation_result->>'risk_classification';
  IF v_risk_classification IS NULL OR v_risk_classification NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: simulation_result.risk_classification must be standard, elevated, or critical';
  END IF;

  -- Build simulation evidence envelope and compute hash
  v_sim_envelope := jsonb_build_object(
    'schema_version', 'gp04.simulation.v1',
    'version_id', v_version.id,
    'content_hash', v_version.content_hash,
    'evaluator_version', p_evaluator_version,
    'resource_scope', jsonb_build_object('type', v_cr.resource_type, 'id', v_cr.resource_id),
    'simulation_profile', p_simulation_result->'simulation_profile',
    'dataset_snapshot', p_simulation_result->'dataset_snapshot',
    'risk', jsonb_build_object(
      'classification', v_risk_classification,
      'classifier_version', p_simulation_result->>'classifier_version'
    ),
    'result', p_simulation_result
  );
  v_sim_hash := 'sha256:' || pg_catalog.encode(public.digest(convert_to(canonical_jsonb(v_sim_envelope), 'UTF8'), 'sha256'), 'hex');

  -- Insert simulation evidence
  INSERT INTO policy_simulation_evidence (version_id, evidence_hash, result, evaluator_version)
  VALUES (v_version.id, v_sim_hash, v_sim_envelope, p_evaluator_version);

  -- Determine outcome
  IF v_simulation_passed THEN
    v_new_state := 'awaiting_approval';
  ELSE
    v_new_state := 'rejected';
  END IF;

  -- CAS transition
  UPDATE policy_change_requests
  SET state = v_new_state, state_revision = state_revision + 1, updated_at = now()
  WHERE id = p_change_request_id AND state = 'submitted' AND state_revision = p_expected_state_revision
  RETURNING state_revision INTO v_new_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'finalize_policy_evaluation: CAS failed during transition to %', v_new_state;
  END IF;

  -- Emit transition event
  IF v_new_state = 'awaiting_approval' THEN
    -- Success: exactly the frozen 5-key detail
    -- state_revision is a bigint literal so PG serializes it as a JSON number
    INSERT INTO policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
    VALUES (p_change_request_id, 'evaluation_complete', 'submitted', 'awaiting_approval', p_actor_principal_id,
      jsonb_build_object(
        'validation_evidence_hash', v_val_hash,
        'simulation_evidence_hash', v_sim_hash,
        'risk_classification', v_risk_classification,
        'state_revision', v_new_revision,
        'version_id', v_version.id::text
      ));
  ELSE
    -- Simulation failed: rejection event
    INSERT INTO policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
    VALUES (p_change_request_id, 'simulation_rejected', 'submitted', 'rejected', p_actor_principal_id,
      jsonb_build_object(
        'validation_evidence_hash', v_val_hash,
        'simulation_evidence_hash', v_sim_hash,
        'version_id', v_version.id,
        'state_revision', v_new_revision
      ));
  END IF;

  RETURN QUERY SELECT p_change_request_id, v_new_state, v_new_revision, v_val_hash, v_sim_hash;
END;
$$;

ALTER FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Record function provenance for rollback verification
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fn record;
  v_acl text;
BEGIN
  SELECT p.proname, p.oid, p.prosrc, p.proacl,
         pg_get_function_identity_arguments(p.oid) AS identity_args,
         pg_get_function_result(p.oid) AS ret_type,
         l.lanname, pg_get_userbyid(p.proowner) AS owner_name,
         p.prosecdef, COALESCE(array_to_string(p.proconfig,','),'') AS config
    INTO v_fn
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname = 'gitwire_policy'
      AND p.proname = 'finalize_policy_evaluation';

  SELECT COALESCE(string_agg(
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g1.rolname END
           || '=' || a.privilege_type || '/' ||
           CASE WHEN a.grantor = 0 THEN 'PUBLIC' ELSE g2.rolname END
           || '(' || CASE WHEN a.is_grantable THEN 't' ELSE 'f' END || ')',
           ',' ORDER BY
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g1.rolname END,
           a.privilege_type,
           CASE WHEN a.grantor = 0 THEN 'PUBLIC' ELSE g2.rolname END), 'NULL')
    INTO v_acl
    FROM aclexplode(coalesce(v_fn.proacl, '{}'::aclitem[])) AS a
    LEFT JOIN pg_roles g1 ON g1.oid = a.grantee
    LEFT JOIN pg_roles g2 ON g2.oid = a.grantor;

  INSERT INTO gp04_function_provenance
    (proname, identity_args, prosrc_hash, ret_type, lang_name, owner_name, prosecdef, proconfig, acl_canonical)
  VALUES (v_fn.proname, v_fn.identity_args,
          encode(public.digest(v_fn.prosrc, 'sha256'), 'hex'),
          v_fn.ret_type, v_fn.lanname, v_fn.owner_name,
          v_fn.prosecdef, v_fn.config, v_acl);
END $$;

RESET search_path;
