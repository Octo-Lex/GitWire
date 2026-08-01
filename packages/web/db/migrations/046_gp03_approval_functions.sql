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
-- CORRECTION (review 4834855247 / decision 5152100228): the original 046 had
-- seven blocking findings. This migration is rewritten in place (046 is
-- unmerged/undeployed) to fix all of them:
--   1. Approval context bound to current state_revision + selected version_id;
--      exactly-one matching event required (fail-closed on ambiguity). The
--      awaiting_approval event detail is JSON-validated in the functions
--      because policy_transition_events has no schema-level state_revision
--      column or uniqueness constraint.
--   2. Scoped authorization: a principal's role applies to a request only via
--      fleet, exact installation id, or exact repository github id (resolved
--      through public.repositories + public.installations). Organization/fleet
--      requests accept fleet assignments only. System scope is allowed ONLY
--      for the expiry automation path with an active system principal +
--      system-scoped admin.
--   3. Lifecycle CAS compares expected==current_max under the change-request
--      lock BEFORE inserting; the existing UNIQUE(approval_id,
--      lifecycle_revision) constraint is the race backstop. clock_timestamp()
--      sampled after lock. No FOR UPDATE on lifecycle rows (fn_owner has only
--      SELECT, INSERT on that table).
--   4. record_policy_approval recomputes the effective rule and rejects stale /
--      superseded / wrong-scope / wrong-family / wrong-risk rule ids.
--   5. Count, role coverage, approval ids, principals, represented roles,
--      assignment ids, and earliest expiry derive from ONE canonical
--      eligible-approval predicate (single CTE -> single aggregate).
--
-- Forward migration is FAIL-CLOSED: plain ADD COLUMN / ADD CONSTRAINT /
-- CREATE FUNCTION (no IF NOT EXISTS, no OR REPLACE). An unexpected existing
-- object aborts the migration. Rollback is via rollback_gp03_approval.sql.
--
-- Schema additions: rule_revision (bigint ordering), approval_ttl_seconds,
-- expires_at, schema-level CHECK constraints (fail-closed).
-- Cross-schema grants: USAGE on gitwire_auth + SELECT on identity tables +
-- SELECT on public.repositories + public.installations.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Schema additions (additive ALTER — fail-closed, no IF NOT EXISTS)
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

-- SELECT on public.repositories + public.installations for server-owned
-- repository / organization / installation resolution (scope-applicability).
-- repositories: github_id, installation_id, full_name, owner, name.
-- installations: github_id (= installation_id FK target), account_login.
GRANT SELECT (github_id, installation_id, full_name, owner, name) ON public.repositories TO gitwire_policy_fn_owner;
GRANT SELECT (github_id, account_login) ON public.installations TO gitwire_policy_fn_owner;

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

-- Normalization contract: 046 INTENTIONALLY normalizes the application-role
-- ACL to the fail-closed baseline. The REVOKE statements below are not advisory
-- — they are the authoritative removal of any prohibited direct-write privilege
-- gitwire_app may hold on the GP-03 append-only tables (a pre-existing INSERT/
-- UPDATE/DELETE grant from any source is removed). The REVOKE ALL ... FROM PUBLIC
-- on each function likewise removes any PUBLIC EXECUTE. The proof verifies the
-- complete prohibited-privilege matrix is absent post-migration and that the
-- exact final ACL matches a fresh apply. This is the chosen contract for the
-- grant-revocation gate (ACL normalization, not abort-on-unexpected-ACL).

-- Revoke direct writes from gitwire_app on GP-03 tables (normalization).
-- Table-level REVOKE does NOT remove pre-existing COLUMN-level grants, so revoke
-- column-level INSERT/UPDATE explicitly via a DO block that enumerates every
-- column of each GP-03 table. This ensures the complete write matrix is removed.
REVOKE INSERT, UPDATE, DELETE ON policy_approval_rules FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_approvals FROM gitwire_app;
REVOKE INSERT, UPDATE, DELETE ON policy_approval_lifecycle FROM gitwire_app;

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
      AND c.relname IN ('policy_approval_rules','policy_approvals','policy_approval_lifecycle')
      AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I) ON %I.%I FROM gitwire_app', r.attname, r.attname, r.nspname, r.relname);
  END LOOP;
END $$;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 1: create_policy_approval_rule
-- Creates an immutable approval rule. Self-approval, step-up, and assurance
-- are schema-enforced as fail-closed (true/false/level1 respectively).
-- Actor must be active principal with active, non-revoked, non-expired
-- fleet-scoped admin role. Rule hash covers ALL fields via canonical_jsonb.
-- rule_revision serialized per scope/family/risk via advisory lock.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

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
  v_now timestamptz;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_approval_rule: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

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

  -- Validate TTL
  IF p_approval_ttl_seconds IS NOT NULL AND p_approval_ttl_seconds <= 0 THEN
    RAISE EXCEPTION 'create_policy_approval_rule: approval_ttl_seconds must be positive when provided';
  END IF;

  -- Validate roles: must be nonempty array
  IF jsonb_typeof(p_required_roles) != 'array' OR jsonb_array_length(p_required_roles) = 0 THEN
    RAISE EXCEPTION 'create_policy_approval_rule: required_roles must be a nonempty array';
  END IF;

  -- Normalize: deduplicate, sort with COLLATE "C", validate each role exists & active
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

  -- Actor eligibility (current): active principal
  SELECT p.status = 'active' INTO v_actor_active
  FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id;
  IF NOT v_actor_active THEN
    RAISE EXCEPTION 'create_policy_approval_rule: actor principal is not active';
  END IF;

  -- Actor eligibility (current): active, non-revoked, non-expired fleet-scoped admin
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_principals p ON p.id = pr.principal_id
    WHERE pr.principal_id = p_actor_principal_id
      AND r.name = 'admin' AND r.status = 'active'
      AND pr.scope_type = 'fleet'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND p.status = 'active'
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

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 2: record_policy_approval
-- Records an approval with server-derived authority tuple.
-- Locks the change request FOR UPDATE (single lock domain; no FOR UPDATE on
-- lifecycle rows since fn_owner has only SELECT, INSERT there).
--
-- R3: Derives approval context from the awaiting_approval transition event,
--   validated against current state_revision + selected version_id; exactly
--   one matching event required (fail-closed on ambiguity). JSON detail is
--   type-checked before casting.
-- R4: Recomputes the effective rule and requires p_approval_rule_id == effective.
--   Rejects stale/superseded/wrong-scope/wrong-family/wrong-risk rule ids.
-- R1/R2: Scoped authorization — approver's role must be current (active
--   principal, active role, non-revoked, non-expired) AND scope-applicable:
--   repository request -> fleet | exact installation_id | exact repo github_id;
--   organization/fleet request -> fleet only.
-- Self-approval prohibition is absolute. Duplicate active approval rejected.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

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
  v_effective_rule_id uuid;
  v_approval_id uuid;
  v_approver_active boolean;
  v_has_role boolean;
  v_existing_count int;
  v_expires_at timestamptz;
  v_now timestamptz;
  v_context_count int;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
  v_detail_val_hash text;
  v_detail_sim_hash text;
  v_detail_risk text;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'record_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;

  -- Lock the change request (single serialization domain) BEFORE sampling the
  -- authority timestamp, so an assignment cannot expire during the lock wait
  -- and still be treated as current.
  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: change request % not found', p_change_request_id;
  END IF;
  IF v_cr.state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'record_policy_approval: change request is in state %, only awaiting_approval accepts approvals', v_cr.state;
  END IF;

  v_now := clock_timestamp();

  -- Get the selected version (must exist)
  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_policy_approval: no selected version';
  END IF;

  -- R3: Derive approval context. Require EXACTLY ONE awaiting_approval event
  -- whose detail carries the current state_revision, the selected version_id,
  -- and typed evidence/risk fields. policy_transition_events has no schema
  -- state_revision column, so we JSON-validate here. The count MUST include the
  -- value-match on state_revision + version_id so a stale historical event does
  -- not turn a single valid current event into a false ambiguity.
  SELECT count(*) INTO v_context_count
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  IF v_context_count = 0 THEN
    RAISE EXCEPTION 'record_policy_approval: no awaiting_approval context event matching current state_revision/version_id';
  END IF;
  IF v_context_count > 1 THEN
    RAISE EXCEPTION 'record_policy_approval: ambiguous awaiting_approval context (% events match current state)', v_context_count;
  END IF;

  -- Exactly one event matches current state; fetch its typed values.
  SELECT
    detail->>'validation_evidence_hash',
    detail->>'simulation_evidence_hash',
    detail->>'risk_classification'
  INTO v_detail_val_hash, v_detail_sim_hash, v_detail_risk
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  -- Validate the fetched evidence/risk values (type-check before use).
  IF v_detail_val_hash IS NULL OR btrim(v_detail_val_hash) = ''
     OR v_detail_sim_hash IS NULL OR btrim(v_detail_sim_hash) = ''
     OR v_detail_risk IS NULL OR v_detail_risk NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'record_policy_approval: context event has malformed evidence or risk';
  END IF;

  -- R4: Recompute the effective rule (repo -> org -> fleet, highest rule_revision).
  -- The supplied p_approval_rule_id MUST equal the effective rule id.
  SELECT e.id INTO v_effective_rule_id
  FROM (
    SELECT r.id,
           ROW_NUMBER() OVER (
             ORDER BY
               CASE r.resource_scope_type WHEN 'repository' THEN 3 WHEN 'organization' THEN 2 WHEN 'fleet' THEN 1 END DESC,
               r.rule_revision DESC
           ) AS rn
    FROM policy_approval_rules r
    WHERE r.policy_family = v_cr.policy_family
      AND r.risk_classification = v_detail_risk
      AND (
        (v_cr.resource_type = 'repository'
           AND ((r.resource_scope_type = 'repository' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'organization' AND r.resource_scope_id = (
                  SELECT i.account_login FROM public.repositories repo
                  JOIN public.installations i ON i.github_id = repo.installation_id
                  WHERE repo.full_name = v_cr.resource_id))
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'organization'
           AND ((r.resource_scope_type = 'organization' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'fleet'
           AND r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')
      )
  ) e
  WHERE e.rn = 1;

  IF v_effective_rule_id IS NULL THEN
    RAISE EXCEPTION 'record_policy_approval: no applicable approval rule found';
  END IF;
  IF v_effective_rule_id != p_approval_rule_id THEN
    RAISE EXCEPTION 'record_policy_approval: supplied rule is not the effective rule (stale/superseded/wrong-scope/family/risk)';
  END IF;

  SELECT * INTO v_rule FROM policy_approval_rules WHERE id = p_approval_rule_id;

  -- Self-approval prohibition (absolute)
  IF v_cr.author_principal_id = p_approver_principal_id THEN
    RAISE EXCEPTION 'record_policy_approval: self-approval prohibited (author == approver)';
  END IF;

  -- Approver eligibility (current): active principal
  SELECT p.status = 'active' INTO v_approver_active
  FROM gitwire_auth.auth_principals p WHERE p.id = p_approver_principal_id;
  IF NOT v_approver_active THEN
    RAISE EXCEPTION 'record_policy_approval: approver principal is not active';
  END IF;

  -- R1/R2: Scope-applicable role. Resolve the target repository's numeric IDs
  -- (fail-closed on zero/multiple rows). Organization/fleet requests accept
  -- fleet-only. Repository requests accept fleet | exact installation_id |
  -- exact repo github_id. System scope is NOT general approval authority.
  v_repo_installation_id := NULL;
  v_repo_github_id := NULL;
  IF v_cr.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_cr.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'record_policy_approval: repository % resolves to % rows (expected 1)', v_cr.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
    FROM public.repositories repo WHERE repo.full_name = v_cr.resource_id;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_principals p ON p.id = pr.principal_id
    WHERE pr.principal_id = p_approver_principal_id
      AND r.name = ANY(SELECT jsonb_array_elements_text(v_rule.required_roles))
      AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND p.status = 'active'
      AND (
        pr.scope_type = 'fleet'
        OR (v_cr.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
  ) INTO v_has_role;
  IF NOT v_has_role THEN
    RAISE EXCEPTION 'record_policy_approval: approver does not have a current scope-applicable required role';
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

  -- Insert approval (immutable core) bound to the exact evidence tuple
  INSERT INTO policy_approvals (
    version_id, content_hash,
    validation_evidence_hash, simulation_evidence_hash,
    approval_rule_id, approval_rule_hash,
    risk_classification, approver_principal_id,
    resource_scope_type, resource_scope_id,
    expires_at
  ) VALUES (
    v_version.id, v_version.content_hash,
    v_detail_val_hash, v_detail_sim_hash,
    p_approval_rule_id, v_rule.rule_hash,
    v_detail_risk, p_approver_principal_id,
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

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 3: revoke_policy_approval
-- CAS lifecycle transition active -> revoked.
-- R6: Genuine compare-before-insert lifecycle CAS.
--   The change-request row FOR UPDATE is the sole serialization domain
--   (fn_owner has only SELECT, INSERT on policy_approval_lifecycle, so no
--   FOR UPDATE on lifecycle rows). clock_timestamp() sampled after lock.
--   Existing UNIQUE(approval_id, lifecycle_revision) is the race backstop.
-- Actor: original approver or fleet admin (current authority).
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

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
  v_rule RECORD;
  v_cr_id uuid;
  v_cr_state text;
  v_cr_resource_type text;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_current_status text;
  v_current_revision bigint;
  v_latest_count int;
  v_is_approver boolean;
  v_is_admin boolean;
  v_now timestamptz;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'revoke_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;
  IF p_reason_code IS NULL OR btrim(p_reason_code) = '' THEN
    RAISE EXCEPTION 'revoke_policy_approval: reason_code must not be empty';
  END IF;

  -- Get the approval
  SELECT * INTO v_approval FROM policy_approvals WHERE id = p_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_policy_approval: approval % not found', p_approval_id;
  END IF;

  -- R6 step 1: Resolve the associated change request
  SELECT cr.id INTO v_cr_id
  FROM policy_change_requests cr
  JOIN policy_versions v ON v.change_request_id = cr.id
  WHERE v.id = v_approval.version_id;
  IF v_cr_id IS NULL THEN
    RAISE EXCEPTION 'revoke_policy_approval: no associated change request for approval %', p_approval_id;
  END IF;

  -- R6 step 2: Lock the change request FOR UPDATE (sole serialization domain)
  -- and require it to still be awaiting_approval. Once a request is approved,
  -- its approvals are consumed and must be immutable.
  SELECT cr.state, cr.resource_type INTO v_cr_state, v_cr_resource_type
  FROM policy_change_requests cr WHERE cr.id = v_cr_id FOR UPDATE;
  IF v_cr_state IS NULL THEN
    RAISE EXCEPTION 'revoke_policy_approval: associated change request not found';
  END IF;
  IF v_cr_state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'revoke_policy_approval: change request is in state %, only awaiting_approval allows revocation', v_cr_state;
  END IF;

  -- R6 step 3: Sample clock_timestamp() AFTER acquiring the lock
  v_now := clock_timestamp();

  -- Load the approval rule (needed for required_roles in the self-revoke check)
  SELECT * INTO v_rule FROM policy_approval_rules WHERE id = v_approval.approval_rule_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke_policy_approval: approval rule % not found', v_approval.approval_rule_id;
  END IF;

  -- R6 step 4: Read the latest lifecycle event with a plain SELECT (no FOR UPDATE)
  SELECT pal.to_status, pal.lifecycle_revision
  INTO v_current_status, v_current_revision
  FROM policy_approval_lifecycle pal
  WHERE pal.approval_id = p_approval_id
    AND pal.lifecycle_revision = (
      SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = p_approval_id
    );

  GET DIAGNOSTICS v_latest_count = ROW_COUNT;
  -- R6 step 5: Require exactly one latest row, expected==current, status active
  IF v_latest_count != 1 THEN
    RAISE EXCEPTION 'revoke_policy_approval: expected exactly one latest lifecycle event, found %', v_latest_count;
  END IF;
  IF v_current_revision IS NULL OR p_expected_lifecycle_revision IS NULL
     OR p_expected_lifecycle_revision != v_current_revision THEN
    RAISE EXCEPTION 'revoke_policy_approval: CAS failed — lifecycle revision mismatch (expected %, current %)',
      p_expected_lifecycle_revision, v_current_revision;
  END IF;
  IF v_current_status IS NULL OR v_current_status != 'active' THEN
    RAISE EXCEPTION 'revoke_policy_approval: approval is in status %, only active can be revoked', v_current_status;
  END IF;

  -- Actor eligibility (current): original approver (who must STILL be an active
  -- principal retaining a current role assignment) OR an active fleet admin.
  -- Equality with the original approver alone is not sufficient — a disabled
  -- former approver must not be able to self-revoke.
  v_is_approver := (v_approval.approver_principal_id = p_actor_principal_id);
  IF v_is_approver THEN
    -- Confirm the original approver STILL holds a CURRENT assignment to an ACTIVE
    -- role that is one of the rule's required_roles AND scope-applicable to the
    -- request (fleet, exact installation_id, or exact repo github_id; system scope
    -- is excluded — it is not approval authority). This matches the frozen
    -- current-authority rule for privileged checks.
    v_repo_installation_id := NULL;
    v_repo_github_id := NULL;
    IF v_cr_resource_type = 'repository' THEN
      SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
      FROM public.repositories repo WHERE repo.full_name = v_approval.resource_scope_id;
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM gitwire_auth.auth_principals p
      JOIN gitwire_auth.auth_principal_roles pr ON pr.principal_id = p.id
      JOIN gitwire_auth.auth_roles r ON r.id = pr.role_id
      WHERE p.id = p_actor_principal_id AND p.status = 'active'
        AND pr.revoked_at IS NULL
        AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
        AND r.status = 'active'
        AND r.name = ANY(SELECT jsonb_array_elements_text(v_rule.required_roles))
        AND pr.scope_type != 'system'
        AND (
          pr.scope_type = 'fleet'
          OR (v_cr_resource_type = 'repository'
              AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
                OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
        )
    ) INTO v_is_approver;
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_principals p ON p.id = pr.principal_id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND r.status = 'active'
      AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND p.status = 'active'
  ) INTO v_is_admin;
  IF NOT v_is_approver AND NOT v_is_admin THEN
    RAISE EXCEPTION 'revoke_policy_approval: actor must be the original approver (still active with a current role) or a current fleet admin';
  END IF;

  -- R6 step 6: Insert current_revision + 1. UNIQUE constraint is the backstop.
  INSERT INTO policy_approval_lifecycle (
    approval_id, lifecycle_revision, from_status, to_status,
    actor_principal_id, reason_code
  ) VALUES (
    p_approval_id, v_current_revision + 1, 'active', 'revoked',
    p_actor_principal_id, p_reason_code
  );
END;
$$;

ALTER FUNCTION revoke_policy_approval(uuid, bigint, uuid, text)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 4: expire_policy_approval
-- CAS lifecycle transition active -> expired.
-- R6: Genuine compare-before-insert lifecycle CAS (same pattern as revoke).
-- R1: System scope is allowed ONLY here, for the expiry automation path,
--   requiring an active system-type principal with an active, non-revoked,
--   non-expired system-scoped admin assignment. Fleet admin also allowed.
-- Uses clock_timestamp() for expiry comparison, sampled after lock.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

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
  v_cr_state text;
  v_current_status text;
  v_current_revision bigint;
  v_latest_count int;
  v_now timestamptz;
  v_is_admin boolean;
  v_actor record;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'expire_policy_approval: caller must be gitwire_app, got %', session_user;
  END IF;

  SELECT * INTO v_approval FROM policy_approvals WHERE id = p_approval_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expire_policy_approval: approval % not found', p_approval_id;
  END IF;

  -- R6 step 1: Resolve the associated change request
  SELECT cr.id INTO v_cr_id
  FROM policy_change_requests cr
  JOIN policy_versions v ON v.change_request_id = cr.id
  WHERE v.id = v_approval.version_id;
  IF v_cr_id IS NULL THEN
    RAISE EXCEPTION 'expire_policy_approval: no associated change request for approval %', p_approval_id;
  END IF;

  -- R6 step 2: Lock the change request FOR UPDATE (sole serialization domain)
  -- and require it to still be awaiting_approval. Once a request is approved,
  -- its approvals are consumed and must be immutable.
  SELECT cr.state INTO v_cr_state
  FROM policy_change_requests cr WHERE cr.id = v_cr_id FOR UPDATE;
  IF v_cr_state IS NULL THEN
    RAISE EXCEPTION 'expire_policy_approval: associated change request not found';
  END IF;
  IF v_cr_state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'expire_policy_approval: change request is in state %, only awaiting_approval allows expiry', v_cr_state;
  END IF;

  -- R6 step 3: Sample clock_timestamp() AFTER acquiring the lock
  v_now := clock_timestamp();

  -- R6 step 4: Read the latest lifecycle event with a plain SELECT
  SELECT pal.to_status, pal.lifecycle_revision
  INTO v_current_status, v_current_revision
  FROM policy_approval_lifecycle pal
  WHERE pal.approval_id = p_approval_id
    AND pal.lifecycle_revision = (
      SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = p_approval_id
    );

  GET DIAGNOSTICS v_latest_count = ROW_COUNT;
  -- R6 step 5: Require exactly one latest row, expected==current, status active
  IF v_latest_count != 1 THEN
    RAISE EXCEPTION 'expire_policy_approval: expected exactly one latest lifecycle event, found %', v_latest_count;
  END IF;
  IF v_current_revision IS NULL OR p_expected_lifecycle_revision IS NULL
     OR p_expected_lifecycle_revision != v_current_revision THEN
    RAISE EXCEPTION 'expire_policy_approval: CAS failed — lifecycle revision mismatch (expected %, current %)',
      p_expected_lifecycle_revision, v_current_revision;
  END IF;
  IF v_current_status IS NULL OR v_current_status != 'active' THEN
    RAISE EXCEPTION 'expire_policy_approval: approval is in status %, only active can be expired', v_current_status;
  END IF;

  -- Verify expiry time has passed
  IF v_approval.expires_at IS NULL THEN
    RAISE EXCEPTION 'expire_policy_approval: approval has no expiry time';
  END IF;
  IF v_approval.expires_at > v_now THEN
    RAISE EXCEPTION 'expire_policy_approval: approval has not expired yet (expires_at > now)';
  END IF;

  -- Actor eligibility (current): active fleet admin, OR (R1) an active
  -- system-type principal with an active, non-revoked, non-expired
  -- system-scoped admin assignment (the expiry automation path).
  SELECT p.status, p.principal_type INTO v_actor
  FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id;
  IF v_actor IS NULL OR v_actor.status != 'active' THEN
    RAISE EXCEPTION 'expire_policy_approval: actor principal is not active';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        (pr.scope_type = 'fleet')
        OR (pr.scope_type = 'system' AND v_actor.principal_type = 'system')
      )
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'expire_policy_approval: actor must be an active fleet admin or an authorized system principal';
  END IF;

  -- R6 step 6: Insert current_revision + 1. UNIQUE constraint is the backstop.
  INSERT INTO policy_approval_lifecycle (
    approval_id, lifecycle_revision, from_status, to_status,
    actor_principal_id, reason_code
  ) VALUES (
    p_approval_id, v_current_revision + 1, 'active', 'expired',
    p_actor_principal_id, 'ttl_expired'
  );
END;
$$;

ALTER FUNCTION expire_policy_approval(uuid, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION expire_policy_approval(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION expire_policy_approval(uuid, bigint, uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 5: evaluate_approval_sufficiency
-- Read-only advisory evaluation. Does not lock or mutate.
-- R5: ONE canonical eligible-approval predicate (single CTE feeding a single
--   aggregate) yields count, approval ids, approver ids, represented roles,
--   assignment ids, missing roles, earliest expiry — all from the identical
--   exact-evidence + current-authority predicate.
-- R3: Context binding (exactly-one typed event matching current revision).
-- R4: Effective rule via repo -> org -> fleet precedence.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

CREATE FUNCTION evaluate_approval_sufficiency(
  p_change_request_id uuid
) RETURNS jsonb
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_cr RECORD;
  v_version RECORD;
  v_detail_val_hash text;
  v_detail_sim_hash text;
  v_detail_risk text;
  v_context_count int;
  v_val_hash text;
  v_sim_hash text;
  v_risk text;
  v_rule RECORD;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
  v_result jsonb;
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

  -- R3: Derive context (exactly-one typed event matching current revision/version).
  -- Count MUST include the value-match so a stale historical event does not
  -- create a false ambiguity.
  SELECT count(*) INTO v_context_count
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  IF v_context_count = 0 THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: no awaiting_approval context event matching current state_revision/version_id';
  END IF;
  IF v_context_count > 1 THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: ambiguous awaiting_approval context (% events match current state)', v_context_count;
  END IF;

  SELECT
    detail->>'validation_evidence_hash', detail->>'simulation_evidence_hash',
    detail->>'risk_classification'
  INTO v_detail_val_hash, v_detail_sim_hash, v_detail_risk
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  IF v_detail_val_hash IS NULL OR btrim(v_detail_val_hash) = ''
     OR v_detail_sim_hash IS NULL OR btrim(v_detail_sim_hash) = ''
     OR v_detail_risk IS NULL OR v_detail_risk NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'evaluate_approval_sufficiency: context event has malformed evidence or risk';
  END IF;
  v_val_hash := v_detail_val_hash;
  v_sim_hash := v_detail_sim_hash;
  v_risk := v_detail_risk;

  -- Resolve repository numeric IDs for scope-applicability (fail-closed)
  v_repo_installation_id := NULL;
  v_repo_github_id := NULL;
  IF v_cr.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_cr.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'evaluate_approval_sufficiency: repository % resolves to % rows (expected 1)', v_cr.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
    FROM public.repositories repo WHERE repo.full_name = v_cr.resource_id;
  END IF;

  -- R4: Effective rule (repo -> org -> fleet, highest rule_revision)
  SELECT * INTO v_rule
  FROM (
    SELECT r.*,
           ROW_NUMBER() OVER (
             ORDER BY
               CASE r.resource_scope_type WHEN 'repository' THEN 3 WHEN 'organization' THEN 2 WHEN 'fleet' THEN 1 END DESC,
               r.rule_revision DESC
           ) AS rn
    FROM policy_approval_rules r
    WHERE r.policy_family = v_cr.policy_family
      AND r.risk_classification = v_risk
      AND (
        (v_cr.resource_type = 'repository'
           AND ((r.resource_scope_type = 'repository' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'organization' AND r.resource_scope_id = (
                  SELECT i.account_login FROM public.repositories repo
                  JOIN public.installations i ON i.github_id = repo.installation_id
                  WHERE repo.full_name = v_cr.resource_id))
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'organization'
           AND ((r.resource_scope_type = 'organization' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'fleet'
           AND r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')
      )
  ) e
  WHERE e.rn = 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('sufficient', false, 'error', 'no applicable rule found',
      'active_distinct_approver_count', 0, 'required_count', null,
      'missing_roles', '[]'::jsonb, 'earliest_approval_expiry', null);
  END IF;

  -- R5: ONE canonical eligible-approval CTE -> single aggregate.
  -- The predicate is the identical exact-evidence + current-authority set.
  -- INNER JOINs (not LEFT): an approval only counts when the approver CURRENTLY
  -- has an active, non-expired, scope-applicable role that is one of the rule's
  -- REQUIRED roles. A disabled principal, an approver with no current assignment,
  -- or a principal holding only an UNRELATED role does NOT count.
  WITH eligible AS (
    SELECT pa.id AS approval_id, pa.approver_principal_id, pa.expires_at,
           pr.id AS assignment_id, r.name AS role_name
    FROM policy_approvals pa
    JOIN policy_approval_lifecycle pal ON pal.approval_id = pa.id
    JOIN gitwire_auth.auth_principals p ON p.id = pa.approver_principal_id AND p.status = 'active'
    JOIN gitwire_auth.auth_principal_roles pr ON pr.principal_id = pa.approver_principal_id
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_cr.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
    JOIN gitwire_auth.auth_roles r ON r.id = pr.role_id AND r.status = 'active'
      AND r.name = ANY(SELECT jsonb_array_elements_text(v_rule.required_roles))
    WHERE pa.version_id = v_version.id
      AND pa.content_hash = v_version.content_hash
      AND pa.validation_evidence_hash = v_val_hash
      AND pa.simulation_evidence_hash = v_sim_hash
      AND pa.approval_rule_id = v_rule.id
      AND pa.approval_rule_hash = v_rule.rule_hash
      AND (pa.expires_at IS NULL OR pa.expires_at > v_now)
      AND pal.to_status = 'active'
      AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id)
  ),
  agg AS (
    SELECT
      count(DISTINCT pa.approver_principal_id) AS distinct_count,
      COALESCE(array_agg(DISTINCT pa.approval_id ORDER BY pa.approval_id), ARRAY[]::uuid[]) AS approval_ids,
      COALESCE(array_agg(DISTINCT pa.approver_principal_id ORDER BY pa.approver_principal_id), ARRAY[]::uuid[]) AS approver_ids,
      COALESCE(array_remove(array_agg(DISTINCT pa.role_name ORDER BY pa.role_name), NULL), ARRAY[]::text[]) AS represented_roles,
      COALESCE(array_remove(array_agg(DISTINCT pa.assignment_id ORDER BY pa.assignment_id), NULL), ARRAY[]::uuid[]) AS assignment_ids,
      min(pa.expires_at) AS earliest_expiry
    FROM eligible pa
  )
  SELECT jsonb_build_object(
    'sufficient', (SELECT count(*) FROM (SELECT DISTINCT approver_principal_id FROM eligible) x) >= v_rule.required_count
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(v_rule.required_roles) AS req(role)
                     WHERE NOT EXISTS (
                       SELECT 1 FROM eligible e
                       JOIN gitwire_auth.auth_principal_roles pr2 ON pr2.principal_id = e.approver_principal_id
                         AND pr2.revoked_at IS NULL
                         AND (pr2.expires_at IS NULL OR pr2.expires_at > v_now)
                       JOIN gitwire_auth.auth_roles r2 ON r2.id = pr2.role_id AND r2.status = 'active'
                       WHERE r2.name = req.role
                         AND (
                           pr2.scope_type = 'fleet'
                           OR (v_cr.resource_type = 'repository'
                               AND ((pr2.scope_type = 'installation' AND pr2.scope_id = v_repo_installation_id)
                                 OR (pr2.scope_type = 'repository' AND pr2.scope_id = v_repo_github_id)))
                         )
                     )
                   ),
    'effective_rule_id', v_rule.id,
    'effective_rule_hash', v_rule.rule_hash,
    'active_distinct_approver_count', (SELECT distinct_count FROM agg),
    'required_count', v_rule.required_count,
    'counted_approval_ids', to_jsonb((SELECT approval_ids FROM agg)),
    'counted_approver_principals', to_jsonb((SELECT approver_ids FROM agg)),
    'represented_roles', to_jsonb((SELECT represented_roles FROM agg)),
    'matched_assignment_ids', to_jsonb((SELECT assignment_ids FROM agg)),
    'missing_roles', to_jsonb(COALESCE((
      SELECT array_agg(role ORDER BY role COLLATE "C") FROM (
        SELECT req.role FROM jsonb_array_elements_text(v_rule.required_roles) AS req(role)
        WHERE NOT EXISTS (
          SELECT 1 FROM eligible e
          JOIN gitwire_auth.auth_principal_roles pr2 ON pr2.principal_id = e.approver_principal_id
            AND pr2.revoked_at IS NULL
            AND (pr2.expires_at IS NULL OR pr2.expires_at > v_now)
          JOIN gitwire_auth.auth_roles r2 ON r2.id = pr2.role_id AND r2.status = 'active'
          WHERE r2.name = req.role
            AND (
              pr2.scope_type = 'fleet'
              OR (v_cr.resource_type = 'repository'
                  AND ((pr2.scope_type = 'installation' AND pr2.scope_id = v_repo_installation_id)
                    OR (pr2.scope_type = 'repository' AND pr2.scope_id = v_repo_github_id)))
            )
        )
      ) z
    ), ARRAY[]::text[])),
    'earliest_approval_expiry', (SELECT earliest_expiry FROM agg)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

ALTER FUNCTION evaluate_approval_sufficiency(uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION evaluate_approval_sufficiency(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evaluate_approval_sufficiency(uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- Function 6: approve_policy_change_request
-- Atomic sufficiency evaluation + CAS transition awaiting_approval -> approved.
-- Locks change request FOR UPDATE. Re-evaluates under lock using the canonical
-- eligible-approval predicate (R5). Emits an approved event with a full
-- snapshot whose state_revision is the POST-CAS approved revision and whose
-- arrays are deterministic, sorted, duplicate-free, empty-not-null.
-- Actor must be a current fleet admin.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

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
  v_detail_val_hash text;
  v_detail_sim_hash text;
  v_detail_risk text;
  v_context_count int;
  v_val_hash text;
  v_sim_hash text;
  v_risk text;
  v_rule RECORD;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
  v_distinct_count int;
  v_missing_roles text[];
  v_approval_ids uuid[];
  v_approver_ids uuid[];
  v_represented_roles text[];
  v_assignment_ids uuid[];
  v_earliest_expiry timestamptz;
  v_now timestamptz;
  v_eval_now timestamptz;
  v_is_admin boolean;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'approve_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;

  -- Lock and load the change request BEFORE sampling the authority timestamp.
  SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: change request % not found', p_change_request_id;
  END IF;
  IF v_cr.state != 'awaiting_approval' THEN
    RAISE EXCEPTION 'approve_policy_change_request: change request is in state %, only awaiting_approval can be approved', v_cr.state;
  END IF;

  -- Sample the authority timestamp AFTER acquiring the lock.
  v_now := clock_timestamp();

  -- Actor eligibility (current): active fleet admin
  SELECT EXISTS(
    SELECT 1 FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_principals p ON p.id = pr.principal_id
    WHERE pr.principal_id = p_actor_principal_id AND r.name = 'admin' AND r.status = 'active'
      AND pr.scope_type = 'fleet' AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND p.status = 'active'
  ) INTO v_is_admin;
  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'approve_policy_change_request: actor must be a current fleet admin';
  END IF;

  -- Get version
  SELECT id, content_hash INTO v_version FROM policy_versions WHERE id = v_cr.selected_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: no selected version';
  END IF;

  -- R3: Derive context (exactly-one typed event matching current revision/version).
  -- Count MUST include the value-match so a stale historical event does not
  -- create a false ambiguity.
  SELECT count(*) INTO v_context_count
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  IF v_context_count = 0 THEN
    RAISE EXCEPTION 'approve_policy_change_request: no awaiting_approval context event matching current state_revision/version_id';
  END IF;
  IF v_context_count > 1 THEN
    RAISE EXCEPTION 'approve_policy_change_request: ambiguous awaiting_approval context (% events match current state)', v_context_count;
  END IF;

  SELECT
    detail->>'validation_evidence_hash', detail->>'simulation_evidence_hash',
    detail->>'risk_classification'
  INTO v_detail_val_hash, v_detail_sim_hash, v_detail_risk
  FROM policy_transition_events
  WHERE change_request_id = p_change_request_id
    AND to_state = 'awaiting_approval'
    AND detail ? 'validation_evidence_hash'
    AND detail ? 'simulation_evidence_hash'
    AND detail ? 'risk_classification'
    AND detail ? 'state_revision'
    AND detail ? 'version_id'
    AND jsonb_typeof(detail->'state_revision') = 'number'
    AND (detail->>'state_revision') = v_cr.state_revision::text
    AND (detail->>'version_id') = v_cr.selected_version_id::text;

  IF v_detail_val_hash IS NULL OR btrim(v_detail_val_hash) = ''
     OR v_detail_sim_hash IS NULL OR btrim(v_detail_sim_hash) = ''
     OR v_detail_risk IS NULL OR v_detail_risk NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'approve_policy_change_request: context event has malformed evidence or risk';
  END IF;
  v_val_hash := v_detail_val_hash;
  v_sim_hash := v_detail_sim_hash;
  v_risk := v_detail_risk;

  -- Resolve repository numeric IDs for scope-applicability (fail-closed)
  v_repo_installation_id := NULL;
  v_repo_github_id := NULL;
  IF v_cr.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_cr.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'approve_policy_change_request: repository % resolves to % rows (expected 1)', v_cr.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
    FROM public.repositories repo WHERE repo.full_name = v_cr.resource_id;
  END IF;

  -- R4: Effective rule
  SELECT * INTO v_rule
  FROM (
    SELECT r.*,
           ROW_NUMBER() OVER (
             ORDER BY
               CASE r.resource_scope_type WHEN 'repository' THEN 3 WHEN 'organization' THEN 2 WHEN 'fleet' THEN 1 END DESC,
               r.rule_revision DESC
           ) AS rn
    FROM policy_approval_rules r
    WHERE r.policy_family = v_cr.policy_family
      AND r.risk_classification = v_risk
      AND (
        (v_cr.resource_type = 'repository'
           AND ((r.resource_scope_type = 'repository' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'organization' AND r.resource_scope_id = (
                  SELECT i.account_login FROM public.repositories repo
                  JOIN public.installations i ON i.github_id = repo.installation_id
                  WHERE repo.full_name = v_cr.resource_id))
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'organization'
           AND ((r.resource_scope_type = 'organization' AND r.resource_scope_id = v_cr.resource_id)
             OR (r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')))
        OR (v_cr.resource_type = 'fleet'
           AND r.resource_scope_type = 'fleet' AND r.resource_scope_id = 'fleet')
      )
  ) e
  WHERE e.rn = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approve_policy_change_request: no applicable approval rule found';
  END IF;

  v_eval_now := clock_timestamp();

  -- R5: ONE canonical eligible-approval CTE -> single aggregate under the lock.
  -- INNER JOINs (not LEFT): an approval only counts when the approver CURRENTLY
  -- has an active, non-expired, scope-applicable REQUIRED role.
  WITH eligible AS (
    SELECT pa.id AS approval_id, pa.approver_principal_id, pa.expires_at,
           pr.id AS assignment_id, r.name AS role_name
    FROM policy_approvals pa
    JOIN policy_approval_lifecycle pal ON pal.approval_id = pa.id
    JOIN gitwire_auth.auth_principals p ON p.id = pa.approver_principal_id AND p.status = 'active'
    JOIN gitwire_auth.auth_principal_roles pr ON pr.principal_id = pa.approver_principal_id
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_eval_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_cr.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
    JOIN gitwire_auth.auth_roles r ON r.id = pr.role_id AND r.status = 'active'
      AND r.name = ANY(SELECT jsonb_array_elements_text(v_rule.required_roles))
    WHERE pa.version_id = v_version.id
      AND pa.content_hash = v_version.content_hash
      AND pa.validation_evidence_hash = v_val_hash
      AND pa.simulation_evidence_hash = v_sim_hash
      AND pa.approval_rule_id = v_rule.id
      AND pa.approval_rule_hash = v_rule.rule_hash
      AND (pa.expires_at IS NULL OR pa.expires_at > v_eval_now)
      AND pal.to_status = 'active'
      AND pal.lifecycle_revision = (SELECT max(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = pa.id)
  )
  SELECT
    agg.distinct_count,
    agg.approval_ids,
    agg.approver_ids,
    agg.represented_roles,
    agg.assignment_ids,
    agg.earliest_expiry,
    agg.missing_roles
  INTO v_distinct_count, v_approval_ids, v_approver_ids, v_represented_roles,
       v_assignment_ids, v_earliest_expiry, v_missing_roles
  FROM (
    SELECT
      count(DISTINCT e.approver_principal_id) AS distinct_count,
      COALESCE(array_agg(DISTINCT e.approval_id ORDER BY e.approval_id), ARRAY[]::uuid[]) AS approval_ids,
      COALESCE(array_agg(DISTINCT e.approver_principal_id ORDER BY e.approver_principal_id), ARRAY[]::uuid[]) AS approver_ids,
      COALESCE(array_remove(array_agg(DISTINCT e.role_name ORDER BY e.role_name), NULL), ARRAY[]::text[]) AS represented_roles,
      COALESCE(array_remove(array_agg(DISTINCT e.assignment_id ORDER BY e.assignment_id), NULL), ARRAY[]::uuid[]) AS assignment_ids,
      min(e.expires_at) AS earliest_expiry,
      COALESCE((
        SELECT array_agg(role ORDER BY role COLLATE "C") FROM (
          SELECT req.role
          FROM jsonb_array_elements_text(v_rule.required_roles) AS req(role)
          WHERE NOT EXISTS (
            SELECT 1 FROM eligible el
            JOIN gitwire_auth.auth_principal_roles pr2 ON pr2.principal_id = el.approver_principal_id
              AND pr2.revoked_at IS NULL
              AND (pr2.expires_at IS NULL OR pr2.expires_at > v_eval_now)
            JOIN gitwire_auth.auth_roles r2 ON r2.id = pr2.role_id AND r2.status = 'active'
            WHERE r2.name = req.role
              AND (
                pr2.scope_type = 'fleet'
                OR (v_cr.resource_type = 'repository'
                    AND ((pr2.scope_type = 'installation' AND pr2.scope_id = v_repo_installation_id)
                      OR (pr2.scope_type = 'repository' AND pr2.scope_id = v_repo_github_id)))
              )
          )
        ) z
      ), ARRAY[]::text[]) AS missing_roles
    FROM eligible e
  ) agg;

  -- Evaluate sufficiency (under lock)
  IF v_distinct_count < v_rule.required_count OR array_length(v_missing_roles, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'approve_policy_change_request: insufficient approvals (count=%, required=%, missing_roles=%)',
      v_distinct_count, v_rule.required_count, v_missing_roles;
  END IF;

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

  -- Approved-event snapshot. state_revision is the POST-CAS approved revision
  -- (from the updated row). Arrays are deterministic/sorted/duplicate-free/
  -- empty-not-null.
  INSERT INTO policy_transition_events (
    change_request_id, event_type, from_state, to_state, actor_principal_id, detail
  ) VALUES (
    p_change_request_id, 'approve', 'awaiting_approval', 'approved', p_actor_principal_id,
    jsonb_build_object(
      'state_revision', v_result.state_revision,
      'version_id', v_version.id,
      'content_hash', v_version.content_hash,
      'validation_evidence_hash', v_val_hash,
      'simulation_evidence_hash', v_sim_hash,
      'risk_classification', v_risk,
      'effective_rule_id', v_rule.id,
      'effective_rule_hash', v_rule.rule_hash,
      'counted_approval_ids', to_jsonb(v_approval_ids),
      'counted_approver_principals', to_jsonb(v_approver_ids),
      'represented_roles', to_jsonb(v_represented_roles),
      'matched_assignment_ids', to_jsonb(v_assignment_ids),
      'active_distinct_approver_count', v_distinct_count,
      'required_count', v_rule.required_count,
      'missing_roles', to_jsonb(v_missing_roles),
      'earliest_approval_expiry', v_earliest_expiry,
      'evaluation_timestamp', v_eval_now
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
