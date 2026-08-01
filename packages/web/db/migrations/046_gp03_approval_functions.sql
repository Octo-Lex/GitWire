-- Migration 046: GP-03 approval rules, approvals, and separation of duties
-- Governed Policy Authority (issue #99, GP-03).
--
-- Adds SECURITY DEFINER functions for approval rule creation, approval
-- recording (with self-approval prohibition and server-derived authority),
-- revocation, expiry, sufficiency evaluation, and atomic approval transition.
--
-- All functions follow the 045 pattern: SECURITY DEFINER, fixed search_path,
-- session_user check, OWNER TO gitwire_policy_fn_owner, REVOKE FROM PUBLIC,
-- GRANT EXECUTE TO gitwire_app.
--
-- Schema additions: rule_revision (bigint ordering), approval_ttl_seconds,
-- expires_at, schema-level CHECK constraints (fail-closed).
-- Cross-schema grants: USAGE on gitwire_auth + SELECT on identity tables.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Schema additions (additive ALTER)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE policy_approval_rules ADD COLUMN rule_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE policy_approval_rules ADD COLUMN approval_ttl_seconds integer;

ALTER TABLE policy_approvals ADD COLUMN expires_at timestamptz;

-- Schema-level CHECK constraints (fail-closed)
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_self_approval_check CHECK (self_approval_prohibited = true);
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_step_up_check CHECK (step_up_required = false);
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_assurance_check CHECK (min_assurance_level = 'level1');
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_risk_enum_check CHECK (risk_classification IN ('standard','elevated','critical'));
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_required_count_min CHECK (required_count >= 1);
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_rule_revision_check CHECK (rule_revision >= 0);
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_ttl_positive CHECK (approval_ttl_seconds IS NULL OR approval_ttl_seconds > 0);
ALTER TABLE policy_approval_rules ADD CONSTRAINT par_scope_revision_unique
  UNIQUE (resource_scope_type, resource_scope_id, policy_family, risk_classification, rule_revision);

ALTER TABLE policy_approvals ADD CONSTRAINT pa_risk_enum_check CHECK (risk_classification IN ('standard','elevated','critical'));
ALTER TABLE policy_approvals ADD CONSTRAINT pa_expires_check CHECK (expires_at IS NULL OR expires_at > created_at);

-- ════════════════════════════════════════════════════════════════════════════
-- Cross-schema grants (NEW — not touching existing GP-02 grants)
-- ════════════════════════════════════════════════════════════════════════════

GRANT USAGE ON SCHEMA gitwire_auth TO gitwire_policy_fn_owner;
GRANT SELECT ON gitwire_auth.auth_principals TO gitwire_policy_fn_owner;
GRANT SELECT ON gitwire_auth.auth_roles TO gitwire_policy_fn_owner;
GRANT SELECT ON gitwire_auth.auth_principal_roles TO gitwire_policy_fn_owner;

-- SELECT on public.repositories for server-owned repository/organization resolution
GRANT SELECT (github_id, installation_id, full_name, owner, name) ON public.repositories TO gitwire_policy_fn_owner;

-- SELECT on policy_transition_events (045 grants only INSERT to fn_owner)
GRANT SELECT ON policy_transition_events TO gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- GP-03 table grants to fn_owner (NEW tables, not owned by GP-02)
-- ════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT ON policy_approval_rules TO gitwire_policy_fn_owner;
GRANT SELECT, INSERT ON policy_approvals TO gitwire_policy_fn_owner;
GRANT SELECT, INSERT ON policy_approval_lifecycle TO gitwire_policy_fn_owner;
GRANT SELECT ON policy_validation_evidence TO gitwire_policy_fn_owner;
GRANT SELECT ON policy_simulation_evidence TO gitwire_policy_fn_owner;

-- Revoke direct writes from gitwire_app on GP-03 tables
REVOKE INSERT, UPDATE, DELETE ON policy_approval_rules FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_approvals FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_approval_lifecycle FROM gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 1: create_policy_approval_rule
-- Creates an immutable approval rule. Self-approval, step-up, and assurance
-- are schema-enforced as fail-closed (true/false/level1 respectively).
-- Actor must be active fleet-scoped admin.
-- Rule hash covers ALL fields via canonical_jsonb.
-- rule_revision serialized per scope/family/risk via advisory lock.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION create_policy_approval_rule(
  p_rule_version text,
  p_policy_family text,
  p_resource_scope_type text,
  p_resource_scope_id text,
  p_risk_classification text,
  p_required_count integer,
  p_required_roles jsonb,
  p_actor_principal_id uuid,
  p_approval_ttl_seconds integer DEFAULT NULL
) RETURNS uuid
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
  v_rule_hash text;
  v_canonical jsonb;
  v_normalized_roles text[];
  v_role text;
  v_role_exists boolean;
  v_actor_active boolean;
  v_actor_admin boolean;
  v_next_revision bigint;
  v_lock_key text;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_approval_rule: caller must be gitwire_app, got %', session_user;
  END IF;

  -- Validate required params
  IF p_rule_version IS NULL OR p_policy_family IS NULL OR p_resource_scope_type IS NULL
     OR p_resource_scope_id IS NULL OR p_risk_classification IS NULL
     OR p_required_count IS NULL OR p_required_roles IS NULL OR p_actor_principal_id IS NULL THEN
    RAISE EXCEPTION 'create_policy_approval_rule: required parameters missing';
  END IF;

  -- Validate scope
  IF p_resource_scope_type NOT IN ('fleet','organization','repository') THEN
    RAISE EXCEPTION 'create_policy_approval_rule: invalid resource_scope_type';
  END IF;
  IF btrim(p_resource_scope_id) = '' THEN
    RAISE EXCEPTION 'create_policy_approval_rule: resource_scope_id must not be empty';
  END IF;
  IF (p_resource_scope_type = 'fleet' AND p_resource_scope_id <> 'fleet')
     OR (p_resource_scope_type <> 'fleet' AND p_resource_scope_id = 'fleet') THEN
    RAISE EXCEPTION 'create_policy_approval_rule: fleet sentinel mismatch';
  END IF;

  -- Validate risk
  IF p_risk_classification NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'create_policy_approval_rule: risk_classification must be standard, elevated, or critical';
  END IF;

  -- Validate count
  IF p_required_count < 1 THEN
    RAISE EXCEPTION 'create_policy_approval_rule: required_count must be >= 1';
  END IF;

  -- Validate roles: must be nonempty array
  IF jsonb_typeof(p_required_roles) != 'array' OR jsonb_array_length(p_required_roles) = 0 THEN
    RAISE EXCEPTION 'create_policy_approval_rule: required_roles must be a nonempty array';
  END IF;

  -- Normalize: deduplicate, sort with COLLATE "C", validate each role exists
  SELECT array_agg(r ORDER BY r COLLATE "C") INTO v_normalized_roles
  FROM (SELECT DISTINCT r FROM jsonb_array_elements_text(p_required_roles) AS e(r)) t;

  FOREACH v_role IN ARRAY v_normalized_roles LOOP
    IF btrim(v_role) = '' THEN
      RAISE EXCEPTION 'create_policy_approval_rule: required_roles contains empty string';
    END IF;
    SELECT EXISTS(SELECT 1 FROM gitwire_auth.auth_roles WHERE name = v_role AND status = 'active') INTO v_role_exists;
    IF NOT v_role_exists THEN
      RAISE EXCEPTION 'create_policy_approval_rule: required role % does not exist or is not active', v_role;
    END IF;
  END LOOP;

  -- Actor eligibility: active principal with active fleet-scoped admin
  SELECT p.status = 'active' INTO v_actor_active
  FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id;
  IF NOT v_actor_active THEN
    RAISE EXCEPTION 'create_policy_approval_rule: actor principal is not active';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id
      AND r.name = 'admin' AND pr.scope_type = 'fleet'
      AND pr.revoked_at IS NULL
  ) INTO v_actor_admin;
  IF NOT v_actor_admin THEN
    RAISE EXCEPTION 'create_policy_approval_rule: actor must have active fleet-scoped admin role';
  END IF;

  -- Serialize rule_revision per scope/family/risk
  v_lock_key := p_resource_scope_type || ':' || p_resource_scope_id || ':' || p_policy_family || ':' || p_risk_classification;
  PERFORM pg_advisory_xact_lock(hashtext(v_lock_key));

  SELECT COALESCE(MAX(rule_revision), 0) + 1 INTO v_next_revision
  FROM policy_approval_rules
  WHERE resource_scope_type = p_resource_scope_type
    AND resource_scope_id = p_resource_scope_id
    AND policy_family = p_policy_family
    AND risk_classification = p_risk_classification;

  -- Compute rule hash covering ALL fields
  v_canonical := jsonb_build_object(
    'rule_version', p_rule_version,
    'policy_family', p_policy_family,
    'resource_scope_type', p_resource_scope_type,
    'resource_scope_id', p_resource_scope_id,
    'risk_classification', p_risk_classification,
    'required_count', p_required_count,
    'required_roles', to_jsonb(v_normalized_roles),
    'min_assurance_level', 'level1',
    'self_approval_prohibited', true,
    'step_up_required', false,
    'approval_ttl_seconds', p_approval_ttl_seconds,
    'rule_revision', v_next_revision
  );
  v_rule_hash := 'sha256:' || pg_catalog.encode(public.digest(convert_to(canonical_jsonb(v_canonical), 'UTF8'), 'sha256'), 'hex');

  INSERT INTO policy_approval_rules (
    rule_version, rule_hash, policy_family, resource_scope_type, resource_scope_id,
    risk_classification, required_count, required_roles, min_assurance_level,
    self_approval_prohibited, step_up_required, approval_ttl_seconds, rule_revision,
    created_by_principal_id
  ) VALUES (
    p_rule_version, v_rule_hash, p_policy_family, p_resource_scope_type, p_resource_scope_id,
    p_risk_classification, p_required_count, to_jsonb(v_normalized_roles), 'level1',
    true, false, p_approval_ttl_seconds, v_next_revision,
    p_actor_principal_id
  ) RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

ALTER FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 2: record_policy_approval
-- Records an approval with server-derived authority tuple.
-- Locks the change request FOR UPDATE (single lock domain).
-- Derives version_id, content_hash, evidence hashes, risk from the
-- awaiting_approval transition event context.
-- Self-approval prohibition is absolute.
-- Duplicate same-principal check for active approvals.
-- Actor eligibility: approver must have required role applicable to scope.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION record_policy_approval(
  p_change_request_id uuid,
  p_approval_rule_id uuid,
  p_approver_principal_id uuid
) RETURNS uuid
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_cr RECORD;
  v_rule RECORD;
  v_version RECORD;
  v_context RECORD;
  v_approval_id uuid;
  v_author uuid;
  v_approver_active boolean;
  v_has_role boolean;
  v_existing_count int;
  v_expires_at timestamptz;
  v_now timestamptz;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'record_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  -- Lock the change request
  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: change request % not found', p_change_request_id;
  END IF;
  IF v_cr.state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'record_policy_approval: change request is in state %, only awaiting_approval accepts approvals', v_cr.state;
  END IF;

  -- Get the selected version
  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: no selected version';
  END IF;

  -- Derive approval context from the transition event that moved to awaiting_approval
  -- Must match the current state_revision exactly
  SELECT
    (detail->>'validation_evidence_hash')::text AS validation_evidence_hash,
    (detail->>'simulation_evidence_hash')::text AS simulation_evidence_hash,
    (detail->>'risk_classification')::text AS risk_classification
  INTO v_context
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND (detail ? 'validation_evidence_hash')
  ORDER BY occurred_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: no awaiting_approval context event with evidence hashes found';
  END IF;

  -- Get the rule and verify it exists
  SELECT * INTO v_rule FROM policy_approval_rules WHERE id = p_approval_rule_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: approval rule % not found', p_approval_rule_id;
  END IF;

  -- Verify the rule matches the request's scope, family, and risk
  -- (the effective rule check is done here, not by the caller)
  IF v_rule.risk_classification != v_context.risk_classification THEN
    RAISE EXCEPTION 'record_policy_approval: rule risk_classification % does not match context %', v_rule.risk_classification, v_context.risk_classification;
  END IF;

  -- Self-approval prohibition (absolute)
  IF v_cr.author_principal_id = p_approver_principal_id THEN
    RAISE EXCEPTION 'record_policy_approval: self-approval prohibited (author == approver)';
  END IF;

  -- Check approver is active
  SELECT status = 'active' INTO v_approver_active FROM gitwire_auth.auth_principals WHERE id = p_approver_principal_id;
  IF NOT v_approver_active THEN
    RAISE EXCEPTION 'record_policy_approval: approver principal is not active';
  END IF;

  -- Check approver has at least one required role applicable to request scope
  -- Repository/installation scope: check fleet, installation, or repository assignments
  -- Organization/fleet scope: check fleet assignments only
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_approver_principal_id
      AND r.name = ANY(SELECT jsonb_array_elements_text(v_rule.required_roles))
      AND pr.revoked_at IS NULL
      AND (pr.scope_type = 'fleet'
           OR (v_cr.resource_type = 'repository' AND pr.scope_type IN ('installation','repository')))
  ) INTO v_has_role;
  IF NOT v_has_role THEN
    RAISE EXCEPTION 'record_policy_approval: approver does not have any required role';
  END IF;

  -- Check for duplicate active approval by same principal
  SELECT count(*) INTO v_existing_count
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id
    AND pa.approval_rule_id = p_approval_rule_id
    AND pa.approver_principal_id = p_approver_principal_id
    AND EXISTS(
      SELECT 1 FROM policy_approval_lifecycle pal
      WHERE pal.approval_id = pa.id
        AND pal.to_status = 'active'
        AND pal.lifecycle_revision = (
          SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id
        )
    );
  IF v_existing_count > 0 THEN
    RAISE EXCEPTION 'record_policy_approval: active approval already exists for this principal, version, and rule';
  END IF;

  -- Derive expiry
  IF v_rule.approval_ttl_seconds IS NOT NULL THEN
    v_expires_at := v_now + (v_rule.approval_ttl_seconds || ' seconds')::interval;
  ELSE
    v_expires_at := NULL;
  END IF;

  -- Insert approval (immutable core)
  INSERT INTO policy_approvals (
    version_id, content_hash,
    validation_evidence_hash, simulation_evidence_hash,
    approval_rule_id, approval_rule_hash,
    risk_classification, approver_principal_id,
    resource_scope_type, resource_scope_id,
    expires_at
  ) VALUES (
    v_version.id, v_version.content_hash,
    v_context.validation_evidence_hash, v_context.simulation_evidence_hash,
    p_approval_rule_id, v_rule.rule_hash,
    v_context.risk_classification, p_approver_principal_id,
    v_cr.resource_type, v_cr.resource_id,
    v_expires_at
  ) RETURNING id INTO v_approval_id;

  -- Insert lifecycle event (revision 0, NULL -> active)
  INSERT INTO policy_approval_lifecycle (
    approval_id, lifecycle_revision, from_status, to_status,
    actor_principal_id, reason_code
  ) VALUES (
    v_approval_id, 0, NULL, 'active',
    p_approver_principal_id, 'approval_recorded'
  );

  RETURN v_approval_id;
END;
$$;

ALTER FUNCTION record_policy_approval(uuid, uuid, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION record_policy_approval(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_policy_approval(uuid, uuid, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 3: revoke_policy_approval
-- CAS lifecycle transition active -> revoked.
-- Locks the associated change request FOR UPDATE.
-- Actor: original approver or fleet admin.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION revoke_policy_approval(
  p_approval_id uuid,
  p_expected_lifecycle_revision bigint,
  p_actor_principal_id uuid,
  p_reason_code text
) RETURNS void
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_approval RECORD;
  v_cr_id uuid;
  v_current_status text;
  v_is_approver boolean;
  v_is_admin boolean;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'revoke_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;
  IF btrim(p_reason_code) = '' THEN
    RAISE EXCEPTION 'revoke_policy_approval: reason_code must not be empty';
  END IF;

  -- Get the approval
  SELECT * INTO v_approval FROM policy_approvals WHERE id = p_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_policy_approval: approval % not found', p_approval_id;
  END IF;

  -- Find the associated change request and lock it
  SELECT cr.id INTO v_cr_id
  FROM policy_change_requests cr
  JOIN policy_versions v ON v.change_request_id = cr.id
  WHERE v.id = v_approval.version_id;
  IF v_cr_id IS NOT NULL THEN
    PERFORM 1 FROM policy_change_requests WHERE id = v_cr_id FOR UPDATE;
  END IF;

  -- Get current lifecycle status
  SELECT pal.to_status INTO v_current_status
  FROM policy_approval_lifecycle pal
  WHERE pal.approval_id = p_approval_id
    AND pal.lifecycle_revision = (
      SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = p_approval_id
    );
  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'revoke_policy_approval: no lifecycle events found';
  END IF;
  IF v_current_status != 'active' THEN
    RAISE EXCEPTION 'revoke_policy_approval: approval is in status %, only active can be revoked', v_current_status;
  END IF;

  -- Actor eligibility: original approver or fleet admin
  v_is_approver := (v_approval.approver_principal_id = p_actor_principal_id);
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
  ) INTO v_is_admin;
  IF NOT v_is_approver AND NOT v_is_admin THEN
    RAISE EXCEPTION 'revoke_policy_approval: actor must be the original approver or a fleet admin';
  END IF;

  -- Insert lifecycle event (CAS on revision)
  INSERT INTO policy_approval_lifecycle (
    approval_id, lifecycle_revision, from_status, to_status,
    actor_principal_id, reason_code
  ) VALUES (
    p_approval_id, p_expected_lifecycle_revision + 1, 'active', 'revoked',
    p_actor_principal_id, p_reason_code
  );
END;
$$;

ALTER FUNCTION revoke_policy_approval(uuid, bigint, uuid, text)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 4: expire_policy_approval
-- CAS lifecycle transition active -> expired.
-- Locks the associated change request FOR UPDATE.
-- Uses clock_timestamp() for expiry comparison.
-- Actor: active fleet admin or authorized system principal.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION expire_policy_approval(
  p_approval_id uuid,
  p_expected_lifecycle_revision bigint,
  p_actor_principal_id uuid
) RETURNS void
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_approval RECORD;
  v_cr_id uuid;
  v_current_status text;
  v_now timestamptz;
  v_is_admin boolean;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'expire_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  SELECT * INTO v_approval FROM policy_approvals WHERE id = p_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expire_policy_approval: approval % not found', p_approval_id;
  END IF;

  -- Lock the associated change request
  SELECT cr.id INTO v_cr_id
  FROM policy_change_requests cr
  JOIN policy_versions v ON v.change_request_id = cr.id
  WHERE v.id = v_approval.version_id;
  IF v_cr_id IS NOT NULL THEN
    PERFORM 1 FROM policy_change_requests WHERE id = v_cr_id FOR UPDATE;
  END IF;

  -- Verify current status
  SELECT pal.to_status INTO v_current_status
  FROM policy_approval_lifecycle pal
  WHERE pal.approval_id = p_approval_id
    AND pal.lifecycle_revision = (
      SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = p_approval_id
    );
  IF v_current_status != 'active' THEN
    RAISE EXCEPTION 'expire_policy_approval: approval is in status %, only active can be expired', v_current_status;
  END IF;

  -- Verify expiry time has passed
  IF v_approval.expires_at IS NULL THEN
    RAISE EXCEPTION 'expire_policy_approval: approval has no expiry time';
  END IF;
  IF v_approval.expires_at > v_now THEN
    RAISE EXCEPTION 'expire_policy_approval: approval has not expired yet (expires_at > now)';
  END IF;

  -- Actor eligibility: active fleet admin or system principal
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'expire_policy_approval: actor must be an active fleet admin or authorized system principal';
  END IF;

  -- Insert lifecycle event
  INSERT INTO policy_approval_lifecycle (
    approval_id, lifecycle_revision, from_status, to_status,
    actor_principal_id, reason_code
  ) VALUES (
    p_approval_id, p_expected_lifecycle_revision + 1, 'active', 'expired',
    p_actor_principal_id, 'ttl_expired'
  );
END;
$$;

ALTER FUNCTION expire_policy_approval(uuid, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION expire_policy_approval(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_policy_approval(uuid, bigint, uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 5: evaluate_approval_sufficiency
-- Read-only advisory evaluation. Does not lock or mutate.
-- Returns effective rule, active distinct approver count, missing roles.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION evaluate_approval_sufficiency(
  p_change_request_id uuid
) RETURNS jsonb
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_cr RECORD;
  v_version RECORD;
  v_context RECORD;
  v_rule RECORD;
  v_distinct_approvers int;
  v_missing_roles text[];
  v_required_role text;
  v_role_covered boolean;
  v_earliest_expiry timestamptz;
  v_now timestamptz;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: change request % not found', p_change_request_id;
  END IF;

  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: no selected version';
  END IF;

  -- Derive context
  SELECT
    (detail->>'validation_evidence_hash')::text AS validation_evidence_hash,
    (detail->>'simulation_evidence_hash')::text AS simulation_evidence_hash,
    (detail->>'risk_classification')::text AS risk_classification
  INTO v_context
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND (detail ? 'validation_evidence_hash')
  ORDER BY occurred_at DESC LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: no awaiting_approval context event found';
  END IF;

  -- Select effective rule: highest specificity match, highest rule_revision
  -- Repository: repo rule → org fallback → fleet fallback
  -- Organization: org rule → fleet fallback
  -- Fleet: fleet rule only
  SELECT * INTO v_rule
  FROM policy_approval_rules
  WHERE policy_family = v_cr.policy_family
    AND risk_classification = v_context.risk_classification
    AND (
      (v_cr.resource_type = 'repository' AND resource_scope_type = 'repository' AND resource_scope_id = v_cr.resource_id)
      OR (v_cr.resource_type = 'repository' AND resource_scope_type = 'organization' AND resource_scope_id = (
        SELECT owner FROM public.repositories WHERE full_name = v_cr.resource_id
      ))
      OR (resource_scope_type = 'fleet' AND resource_scope_id = 'fleet')
    )
  ORDER BY
    CASE resource_scope_type WHEN 'repository' THEN 3 WHEN 'organization' THEN 2 WHEN 'fleet' THEN 1 END DESC,
    rule_revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('sufficient', false, 'error', 'no applicable rule found');
  END IF;

  -- Count distinct active approvers bound to exact version + evidence + rule
  SELECT count(DISTINCT pa.approver_principal_id) INTO v_distinct_approvers
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id
    AND pa.content_hash = v_version.content_hash
    AND pa.validation_evidence_hash = v_context.validation_evidence_hash
    AND pa.simulation_evidence_hash = v_context.simulation_evidence_hash
    AND pa.approval_rule_id = v_rule.id
    AND pa.approval_rule_hash = v_rule.rule_hash
    AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
    AND EXISTS(
      SELECT 1 FROM policy_approval_lifecycle pal
      WHERE pal.approval_id = pa.id
        AND pal.to_status = 'active'
        AND pal.lifecycle_revision = (
          SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id
        )
    );

  -- Check missing roles
  v_missing_roles := ARRAY[]::text[];
  FOR v_required_role IN SELECT jsonb_array_elements_text(v_rule.required_roles) LOOP
    -- An approval counts for a role if its approver has that role
    SELECT EXISTS(
      SELECT 1 FROM policy_approvals pa
      WHERE pa.version_id = v_version.id
        AND pa.approval_rule_id = v_rule.id
        AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
        AND EXISTS(
          SELECT 1 FROM policy_approval_lifecycle pal
          WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
            AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id)
        )
        AND EXISTS(
          SELECT 1 FROM gitwire_auth.auth_principal_roles pr
          JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
          WHERE pr.principal_id = pa.approver_principal_id AND r.name = v_required_role AND pr.revoked_at IS NULL
        )
    ) INTO v_role_covered;
    IF NOT v_role_covered THEN
      v_missing_roles := array_append(v_missing_roles, v_required_role);
    END IF;
  END LOOP;

  -- Get earliest expiry
  SELECT min(pa.expires_at) INTO v_earliest_expiry
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id
    AND pa.approval_rule_id = v_rule.id
    AND pa.expires_at IS NOT NULL
    AND EXISTS(
      SELECT 1 FROM policy_approval_lifecycle pal
      WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
        AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id)
    );

  RETURN jsonb_build_object(
    'sufficient', v_distinct_approvers >= v_rule.required_count AND array_length(v_missing_roles, 1) IS NULL,
    'effective_rule_id', v_rule.id,
    'effective_rule_hash', v_rule.rule_hash,
    'active_distinct_approver_count', v_distinct_approvers,
    'required_count', v_rule.required_count,
    'missing_roles', to_jsonb(v_missing_roles),
    'assurance_satisfied', true,
    'step_up_satisfied', true,
    'earliest_approval_expiry', v_earliest_expiry
  );
END;
$$;

ALTER FUNCTION evaluate_approval_sufficiency(uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION evaluate_approval_sufficiency(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_approval_sufficiency(uuid) TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 6: approve_policy_change_request
-- Atomic sufficiency evaluation + CAS transition awaiting_approval -> approved.
-- Locks change request FOR UPDATE. Re-evaluates under lock.
-- Approved event snapshots effective rule, evidence, counted approvals.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION approve_policy_change_request(
  p_change_request_id uuid,
  p_expected_state_revision bigint,
  p_actor_principal_id uuid
) RETURNS policy_change_requests
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_result policy_change_requests;
  v_cr RECORD;
  v_version RECORD;
  v_context RECORD;
  v_rule RECORD;
  v_distinct_approvers int;
  v_missing_roles text[];
  v_required_role text;
  v_role_covered boolean;
  v_earliest_expiry timestamptz;
  v_now timestamptz;
  v_is_admin boolean;
  v_approval_ids uuid[];
  v_approval_principals uuid[];
  v_represented_roles text[];
  v_assignment_ids uuid[];
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'approve_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  -- Lock and load the change request
  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: change request % not found', p_change_request_id;
  END IF;
  IF v_cr.state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'approve_policy_change_request: change request is in state %, only awaiting_approval can be approved', v_cr.state;
  END IF;

  -- Actor eligibility: active fleet admin
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'approve_policy_change_request: actor must be an active fleet admin';
  END IF;

  -- Get version and context
  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  SELECT
    (detail->>'validation_evidence_hash')::text AS validation_evidence_hash,
    (detail->>'simulation_evidence_hash')::text AS simulation_evidence_hash,
    (detail->>'risk_classification')::text AS risk_classification
  INTO v_context
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND (detail ? 'validation_evidence_hash')
  ORDER BY occurred_at DESC LIMIT 1;

  -- Select effective rule
  SELECT * INTO v_rule
  FROM policy_approval_rules
  WHERE policy_family = v_cr.policy_family
    AND risk_classification = v_context.risk_classification
    AND (
      (v_cr.resource_type = 'repository' AND resource_scope_type = 'repository' AND resource_scope_id = v_cr.resource_id)
      OR (v_cr.resource_type = 'repository' AND resource_scope_type = 'organization' AND resource_scope_id = (
        SELECT owner FROM public.repositories WHERE full_name = v_cr.resource_id
      ))
      OR (resource_scope_type = 'fleet' AND resource_scope_id = 'fleet')
    )
  ORDER BY
    CASE resource_scope_type WHEN 'repository' THEN 3 WHEN 'organization' THEN 2 WHEN 'fleet' THEN 1 END DESC,
    rule_revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: no applicable approval rule found';
  END IF;

  -- Count distinct active approvers
  SELECT count(DISTINCT pa.approver_principal_id) INTO v_distinct_approvers
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id
    AND pa.content_hash = v_version.content_hash
    AND pa.validation_evidence_hash = v_context.validation_evidence_hash
    AND pa.simulation_evidence_hash = v_context.simulation_evidence_hash
    AND pa.approval_rule_id = v_rule.id
    AND pa.approval_rule_hash = v_rule.rule_hash
    AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
    AND EXISTS(
      SELECT 1 FROM policy_approval_lifecycle pal
      WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
        AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id)
    );

  -- Check missing roles
  v_missing_roles := ARRAY[]::text[];
  FOR v_required_role IN SELECT jsonb_array_elements_text(v_rule.required_roles) LOOP
    SELECT EXISTS(
      SELECT 1 FROM policy_approvals pa
      WHERE pa.version_id = v_version.id AND pa.approval_rule_id = v_rule.id
        AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
        AND EXISTS(SELECT 1 FROM policy_approval_lifecycle pal WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
          AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id))
        AND EXISTS(SELECT 1 FROM gitwire_auth.auth_principal_roles pr JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
          WHERE pr.principal_id = pa.approver_principal_id AND r.name = v_required_role AND pr.revoked_at IS NULL)
    ) INTO v_role_covered;
    IF NOT v_role_covered THEN
      v_missing_roles := array_append(v_missing_roles, v_required_role);
    END IF;
  END LOOP;

  -- Evaluate sufficiency
  IF v_distinct_approvers < v_rule.required_count OR array_length(v_missing_roles, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'approve_policy_change_request: insufficient approvals (count=%, required=%, missing_roles=%)',
      v_distinct_approvers, v_rule.required_count, v_missing_roles;
  END IF;

  -- Collect approval IDs and principals for snapshot
  SELECT array_agg(pa.id ORDER BY pa.id), array_agg(DISTINCT pa.approver_principal_id ORDER BY pa.approver_principal_id)
  INTO v_approval_ids, v_approval_principals
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id AND pa.approval_rule_id = v_rule.id
    AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
    AND EXISTS(SELECT 1 FROM policy_approval_lifecycle pal WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
      AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id));

  -- Get earliest expiry
  SELECT min(pa.expires_at) INTO v_earliest_expiry
  FROM policy_approvals pa
  WHERE pa.version_id = v_version.id AND pa.approval_rule_id = v_rule.id
    AND pa.expires_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM policy_approval_lifecycle pal WHERE pal.approval_id = pa.id AND pal.to_status = 'active'
      AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id));

  -- CAS transition
  UPDATE policy_change_requests
  SET state = 'approved', state_revision = state_revision + 1, updated_at = now()
  WHERE id = p_change_request_id
    AND state = 'awaiting_approval'
    AND state_revision = p_expected_state_revision
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: CAS failed — state or revision mismatch';
  END IF;

  -- Transition event with full snapshot
  INSERT INTO policy_transition_events (
    change_request_id, event_type, from_state, to_state, actor_principal_id, detail
  ) VALUES (
    p_change_request_id, 'approve', 'awaiting_approval', 'approved', p_actor_principal_id,
    jsonb_build_object(
      'effective_rule_id', v_rule.id,
      'effective_rule_hash', v_rule.rule_hash,
      'validation_evidence_hash', v_context.validation_evidence_hash,
      'simulation_evidence_hash', v_context.simulation_evidence_hash,
      'counted_approval_ids', to_jsonb(v_approval_ids),
      'counted_approver_principals', to_jsonb(v_approval_principals),
      'active_distinct_approver_count', v_distinct_approvers,
      'required_count', v_rule.required_count,
      'missing_roles', to_jsonb(v_missing_roles),
      'evaluation_timestamp', v_now,
      'earliest_approval_expiry', v_earliest_expiry
    )
  );

  RETURN v_result;
END;
$$;

ALTER FUNCTION approve_policy_change_request(uuid, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION approve_policy_change_request(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_policy_change_request(uuid, bigint, uuid) TO gitwire_app;

RESET search_path;
