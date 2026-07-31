-- Migration 045: GP-02 SECURITY DEFINER functions
-- Governed Policy Authority (issue #98, GP-02).
--
-- Implements the function-boundary model: gitwire_app retains SELECT only
-- on governed-policy tables and gains EXECUTE on four narrowly scoped
-- SECURITY DEFINER functions that own all writes. No direct INSERT or
-- UPDATE is granted to gitwire_app.
--
-- Functions:
--   create_policy_change_request() — INSERT request + initial event
--   create_policy_version()         — INSERT version (locks parent FOR UPDATE)
--   select_policy_version()         — CAS update selected_version_id + event
--   submit_policy_change_request()  — CAS transition draft→submitted + event
--
-- Each function:
--   * SECURITY DEFINER, SET search_path = gitwire_policy, pg_catalog
--   * OWNER TO gitwire_policy_fn_owner
--   * REVOKE ALL ON FUNCTION FROM PUBLIC
--   * GRANT EXECUTE TO gitwire_app
--   * session_user = 'gitwire_app' check
--   * CAS enforcement via expected state + revision
--   * Transactional: state change + event in one invocation
--
-- Follows the 039 transition_admission pattern exactly.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Grant table privileges to gitwire_policy_fn_owner (the function owner)
-- ════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT ON policy_change_requests TO gitwire_policy_fn_owner;
GRANT UPDATE (state, state_revision, selected_version_id, submitted_at, updated_at)
  ON policy_change_requests TO gitwire_policy_fn_owner;

GRANT SELECT, INSERT ON policy_versions TO gitwire_policy_fn_owner;

GRANT INSERT ON policy_transition_events TO gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- Ensure gitwire_app has NO direct write privileges on these tables
-- (revoking any that might have been granted by a previous attempt)
-- ════════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE ON policy_change_requests FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_versions FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_transition_events FROM gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Recursive canonical JSON helper for deterministic hashing
-- Produces a canonical text representation with sorted keys at all levels.
-- Uses proper JSON escaping via to_jsonb() to prevent collision attacks.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION canonical_jsonb(val jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result text;
  arr_item jsonb;
  arr_parts text[];
BEGIN
  IF val IS NULL THEN
    RETURN 'null';
  ELSIF jsonb_typeof(val) = 'object' THEN
    SELECT string_agg(
      to_jsonb(k)::text || ':' || canonical_jsonb(v),
      ','
      ORDER BY k
    ) INTO result
    FROM jsonb_each(val) AS e(k, v);

    IF result IS NULL THEN
      result := '';
    END IF;
    RETURN '{' || result || '}';
  ELSIF jsonb_typeof(val) = 'array' THEN
    arr_parts := ARRAY[]::text[];
    FOR arr_item IN SELECT jsonb_array_elements(val) LOOP
      arr_parts := array_append(arr_parts, canonical_jsonb(arr_item));
    END LOOP;
    IF array_length(arr_parts, 1) IS NULL THEN
      RETURN '[]';
    END IF;
    RETURN '[' || array_to_string(arr_parts, ',') || ']';
  ELSIF jsonb_typeof(val) = 'string' THEN
    -- Use to_jsonb for proper escaping of quotes, backslashes, Unicode
    RETURN val::text;
  ELSIF jsonb_typeof(val) = 'number' THEN
    RETURN (val #>> '{}');
  ELSIF jsonb_typeof(val) = 'boolean' THEN
    RETURN (val #>> '{}');
  ELSIF jsonb_typeof(val) = 'null' THEN
    RETURN 'null';
  ELSE
    RETURN val::text;
  END IF;
END;
$$;

ALTER FUNCTION canonical_jsonb(jsonb) OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION canonical_jsonb(jsonb) FROM PUBLIC;

-- ════════════════════════════════════════════════════════════════════════════
-- create_policy_change_request(
--   p_resource_type, p_resource_id, p_policy_family, p_actor_principal_id
-- )
-- Creates a new change request in 'draft' state + initial transition event.
-- Validates resource scope normalization.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION create_policy_change_request(
  p_resource_type text,
  p_resource_id text,
  p_policy_family text,
  p_actor_principal_id uuid
) RETURNS uuid
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;
  IF p_resource_type IS NULL OR p_resource_id IS NULL OR p_policy_family IS NULL OR p_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'create_policy_change_request: all parameters required';
  END IF;
  IF p_resource_type NOT IN ('fleet', 'organization', 'repository') THEN
    RAISE EXCEPTION 'create_policy_change_request: resource_type must be fleet, organization, or repository';
  END IF;
  IF btrim(p_resource_id) = '' THEN
    RAISE EXCEPTION 'create_policy_change_request: resource_id must not be empty';
  END IF;
  IF (p_resource_type = 'fleet' AND p_resource_id <> 'fleet')
     OR (p_resource_type <> 'fleet' AND p_resource_id = 'fleet') THEN
    RAISE EXCEPTION 'create_policy_change_request: fleet resource must use resource_id=''fleet''';
  END IF;

  INSERT INTO policy_change_requests
    (resource_type, resource_id, policy_family, author_principal_id)
  VALUES
    (p_resource_type, p_resource_id, p_policy_family, p_actor_principal_id)
  RETURNING id INTO v_id;

  INSERT INTO policy_transition_events
    (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
  VALUES
    (v_id, 'create', NULL, 'draft', p_actor_principal_id, '{}'::jsonb);

  RETURN v_id;
END;
$$;

ALTER FUNCTION create_policy_change_request(text, text, text, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION create_policy_change_request(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_policy_change_request(text, text, text, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- create_policy_version(
--   p_change_request_id, p_payload, p_actor_principal_id
-- )
-- Creates an immutable version with content hash computed inside the DB.
-- Locks the parent request FOR UPDATE to serialize against submission.
-- Rejects if request is not in 'draft' state.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION create_policy_version(
  p_change_request_id uuid,
  p_payload jsonb,
  p_actor_principal_id uuid
) RETURNS uuid
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_state text;
  v_content_hash text;
  v_canonical text;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_version: caller must be gitwire_app, got %', session_user;
  END IF;
  IF p_change_request_id IS NULL OR p_payload IS NULL OR p_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'create_policy_version: all parameters required';
  END IF;
  IF jsonb_typeof(p_payload) != 'object' THEN
    RAISE EXCEPTION 'create_policy_version: payload must be a JSON object';
  END IF;

  -- Lock the parent request to serialize against submission
  SELECT state INTO v_state
  FROM policy_change_requests
  WHERE id = p_change_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_version: change request % not found', p_change_request_id;
  END IF;

  IF v_state != 'draft' THEN
    RAISE EXCEPTION 'create_policy_version: change request is in state %, only draft accepts new versions', v_state;
  END IF;

  -- Compute canonical hash inside the DB (recursive)
  v_canonical := canonical_jsonb(p_payload);
  v_content_hash := 'sha256:' || pg_catalog.encode(public.digest(convert_to(v_canonical, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO policy_versions
    (change_request_id, payload, content_hash, author_principal_id)
  VALUES
    (p_change_request_id, p_payload, v_content_hash, p_actor_principal_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION create_policy_version(uuid, jsonb, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION create_policy_version(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_policy_version(uuid, jsonb, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- select_policy_version(
--   p_change_request_id, p_version_id, p_expected_revision, p_actor_principal_id
-- )
-- CAS update of selected_version_id. Requires draft state.
-- Verifies version belongs to this change request.
-- Appends transition event in the same transaction.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION select_policy_version(
  p_change_request_id uuid,
  p_version_id uuid,
  p_expected_revision bigint,
  p_actor_principal_id uuid
) RETURNS policy_change_requests
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_result policy_change_requests;
  v_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'select_policy_version: caller must be gitwire_app, got %', session_user;
  END IF;

  -- Verify version belongs to this change request
  SELECT count(*) INTO v_count
  FROM policy_versions
  WHERE id = p_version_id AND change_request_id = p_change_request_id;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'select_policy_version: version % does not belong to change request %', p_version_id, p_change_request_id;
  END IF;

  -- CAS update
  UPDATE policy_change_requests
  SET selected_version_id = p_version_id,
      state_revision = state_revision + 1,
      updated_at = now()
  WHERE id = p_change_request_id
    AND state = 'draft'
    AND state_revision = p_expected_revision
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'select_policy_version: CAS failed — change request % not in draft or revision mismatch (expected %)', p_change_request_id, p_expected_revision;
  END IF;

  -- Append event
  INSERT INTO policy_transition_events
    (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
  VALUES
    (p_change_request_id, 'select_version', 'draft', 'draft', p_actor_principal_id,
     jsonb_build_object('versionId', p_version_id));

  RETURN v_result;
END;
$$;

ALTER FUNCTION select_policy_version(uuid, uuid, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION select_policy_version(uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION select_policy_version(uuid, uuid, bigint, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- submit_policy_change_request(
--   p_change_request_id, p_expected_revision, p_actor_principal_id
-- )
-- CAS transition draft → submitted. Requires selected_version_id.
-- Appends transition event in the same transaction.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION submit_policy_change_request(
  p_change_request_id uuid,
  p_expected_revision bigint,
  p_actor_principal_id uuid
) RETURNS policy_change_requests
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_result policy_change_requests;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'submit_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;

  -- CAS transition draft → submitted
  UPDATE policy_change_requests
  SET state = 'submitted',
      state_revision = state_revision + 1,
      submitted_at = now(),
      updated_at = now()
  WHERE id = p_change_request_id
    AND state = 'draft'
    AND state_revision = p_expected_revision
    AND selected_version_id IS NOT NULL
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    -- Distinguish failure modes
    PERFORM 1 FROM policy_change_requests
    WHERE id = p_change_request_id
      AND state = 'draft'
      AND state_revision = p_expected_revision
      AND selected_version_id IS NULL;
    IF FOUND THEN
      RAISE EXCEPTION 'submit_policy_change_request: no version selected';
    END IF;

    RAISE EXCEPTION 'submit_policy_change_request: CAS failed — not in draft, revision mismatch (expected %), or not found', p_expected_revision;
  END IF;

  -- Append event
  INSERT INTO policy_transition_events
    (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
  VALUES
    (p_change_request_id, 'submit', 'draft', 'submitted', p_actor_principal_id, '{}'::jsonb);

  RETURN v_result;
END;
$$;

ALTER FUNCTION submit_policy_change_request(uuid, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION submit_policy_change_request(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_policy_change_request(uuid, bigint, uuid) TO gitwire_app;

RESET search_path;
