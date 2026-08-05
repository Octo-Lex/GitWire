-- Migration 048: GP-05 atomic promotion and governed rollback
-- Governed Policy Authority (issue #101, GP-05).
--
-- Implements the single-writer atomic promotion finalizer and the governed
-- rollback lifecycle. Architecture accepted in #101 comment 5185886348;
-- proposal in #101 comment 5185802610.
--
-- Binding design decisions (accepted architecture):
--   1. promotion_kind discriminator (forward | rollback) on promotion records
--   2. Append-only policy_rollback_lifecycle with exact revision CAS
--   3. Same-binding rollback provenance via target_promotion_record_id
--   4. Server-derived rollback risk = max(base risk, target risk)
--   5. Separation of duties includes the selected version's author
--   6. Deterministic domain-failure vs operational-failure boundary
--   7. Identical namespaced JSON advisory lock for forward and rollback
--
-- Forward migration is FAIL-CLOSED: plain CREATE TABLE / CREATE FUNCTION
-- (no IF NOT EXISTS), plain ADD COLUMN (no IF NOT EXISTS). Collisions abort.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Precondition: refuse to run if authoritative data already exists.
-- The promotion/binding tables must be empty; a non-empty environment means
-- migration 048 was partially applied or the schema has diverged.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_promo_count int;
  v_bind_count int;
  v_rb_count int;
BEGIN
  SELECT count(*) INTO v_promo_count FROM policy_promotion_records;
  SELECT count(*) INTO v_bind_count FROM active_policy_bindings;
  SELECT count(*) INTO v_rb_count FROM policy_rollback_records;
  IF v_promo_count > 0 OR v_bind_count > 0 OR v_rb_count > 0 THEN
    RAISE EXCEPTION 'migration 048: cannot apply — authoritative data exists (promotion_records=%, bindings=%, rollback_records=%). Fail-closed.',
      v_promo_count, v_bind_count, v_rb_count;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Promotion discriminator column
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE policy_promotion_records
  ADD COLUMN promotion_kind text NOT NULL
    CHECK (promotion_kind IN ('forward', 'rollback'));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Rollback provenance and risk columns + foreign keys
-- Amendment 1: target_promotion_record_id, risk_classification, FKs
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE policy_rollback_records
  ADD COLUMN target_promotion_record_id uuid NOT NULL,
  ADD COLUMN risk_classification text NOT NULL
    CHECK (risk_classification IN ('standard', 'elevated', 'critical'));

-- Foreign keys for rollback provenance
ALTER TABLE policy_rollback_records
  ADD CONSTRAINT prr_base_version_fk
    FOREIGN KEY (base_version_id) REFERENCES policy_versions(id);

ALTER TABLE policy_rollback_records
  ADD CONSTRAINT prr_target_promotion_fk
    FOREIGN KEY (target_promotion_record_id) REFERENCES policy_promotion_records(id);

ALTER TABLE policy_rollback_records
  ADD CONSTRAINT prr_promotion_record_fk
    FOREIGN KEY (promotion_record_id) REFERENCES policy_promotion_records(id)
    DEFERRABLE INITIALLY DEFERRED;

-- Execution-terminal status integrity: promoted/failed must reference a
-- promotion record; non-execution statuses must not.
ALTER TABLE policy_rollback_records
  ADD CONSTRAINT prr_execution_record_check CHECK (
    (status IN ('promoted') AND promotion_record_id IS NOT NULL)
    OR (status = 'failed' AND promotion_record_id IS NOT NULL)
    OR (status IN ('requested','approved','rejected','withdrawn') AND promotion_record_id IS NULL)
    OR (status = 'promoting')  -- legal but never entered by GP-05
  );

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Rollback lifecycle table (append-only)
-- Amendment 2: exact revision CAS, server-owned detail
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_rollback_lifecycle (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rollback_record_id      uuid        NOT NULL REFERENCES policy_rollback_records(id),
  lifecycle_revision      bigint      NOT NULL,
  from_status             text,
  to_status               text        NOT NULL,
  actor_principal_id      uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  reason_code             text,
  promotion_record_id     uuid        REFERENCES policy_promotion_records(id),
  detail                  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prl_revision_check
    CHECK (lifecycle_revision >= 0),
  CONSTRAINT prl_to_status_check
    CHECK (to_status IN ('requested','approved','promoting','promoted','rejected','failed','withdrawn')),
  CONSTRAINT prl_from_status_check
    CHECK (from_status IS NULL OR from_status IN ('requested','approved','promoting','promoted','rejected','failed','withdrawn')),
  CONSTRAINT prl_revision_zero
    CHECK ((lifecycle_revision = 0 AND from_status IS NULL AND to_status = 'requested')
        OR (lifecycle_revision > 0 AND from_status IS NOT NULL)),
  CONSTRAINT prl_no_self_transition
    CHECK (lifecycle_revision = 0 OR from_status IS DISTINCT FROM to_status),
  CONSTRAINT prl_detail_is_object
    CHECK (jsonb_typeof(detail) = 'object'),
  -- promoted/failed must reference the promotion record that executed them
  CONSTRAINT prl_execution_record_check CHECK (
    (to_status IN ('promoted','failed') AND promotion_record_id IS NOT NULL)
    OR (to_status NOT IN ('promoted','failed') AND promotion_record_id IS NULL)
  ),
  -- unique lifecycle sequence per rollback record (race backstop)
  CONSTRAINT prl_record_revision_unique
    UNIQUE (rollback_record_id, lifecycle_revision)
);

CREATE INDEX idx_prl_record ON policy_rollback_lifecycle (rollback_record_id, lifecycle_revision);

-- Append-only enforcement (reuse the existing SECURITY INVOKER trigger function)
CREATE TRIGGER policy_rollback_lifecycle_no_update
  BEFORE UPDATE ON policy_rollback_lifecycle
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_rollback_lifecycle_no_delete
  BEFORE DELETE ON policy_rollback_lifecycle
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- 4. ACL normalization: no direct runtime writes to GP-05-owned tables
-- fn_owner (the SECURITY DEFINER function owner) gets the narrow privileges the
-- GP-05 finalizers need. gitwire_app keeps SELECT only — all writes go through
-- the functions.
-- ════════════════════════════════════════════════════════════════════════════

REVOKE INSERT, UPDATE, DELETE ON policy_rollback_lifecycle FROM gitwire_app;

-- fn_owner privileges for GP-05 functions:
GRANT SELECT, INSERT ON policy_rollback_lifecycle TO gitwire_policy_fn_owner;
-- active_policy_bindings: SELECT (resolve/lock), INSERT (initial), UPDATE (CAS replacement)
GRANT SELECT, INSERT, UPDATE ON active_policy_bindings TO gitwire_policy_fn_owner;
-- policy_promotion_records: SELECT (resolve prior), INSERT (record success/failure)
GRANT SELECT, INSERT ON policy_promotion_records TO gitwire_policy_fn_owner;
-- policy_rollback_records: SELECT (lock/resolve), INSERT (create), UPDATE (status transitions)
GRANT SELECT, INSERT, UPDATE ON policy_rollback_records TO gitwire_policy_fn_owner;
-- auth_role_permissions: SELECT needed for transactional permission checks
-- (GP-03/046 already grants auth_principals, auth_roles, auth_principal_roles)
GRANT SELECT ON gitwire_auth.auth_role_permissions TO gitwire_policy_fn_owner;
-- NOTE: policy_change_requests UPDATE is NOT granted here — GP-02/045 already
-- grants the column-level UPDATE the approved→promoted transition needs.
-- NOTE: policy_approval_lifecycle SELECT is NOT granted here — GP-03/046
-- already grants SELECT, INSERT on that table to gitwire_policy_fn_owner.

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Function provenance metadata (mandatory, GP-03/04 pattern)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE gp05_function_provenance (
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

REVOKE ALL ON gp05_function_provenance FROM PUBLIC;
REVOKE ALL ON gp05_function_provenance FROM gitwire_app;
REVOKE ALL ON gp05_function_provenance FROM gitwire_policy_fn_owner;

RESET search_path;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. Forward-promotion finalizer
-- Single atomic SECURITY DEFINER function. Uses a one-iteration LOOP so that
-- any domain refusal sets v_failure_code and EXITs to the single shared
-- failed-record writer. Operational errors (DB exceptions) propagate and roll
-- back the whole transaction.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

CREATE FUNCTION promote_policy_change_request(
  p_change_request_id         uuid,
  p_expected_state_revision   bigint,
  p_expected_binding_revision bigint,
  p_actor_principal_id        uuid
) RETURNS TABLE (
  out_promotion_record_id  uuid,
  out_outcome              text,
  out_failure_code         text,
  out_binding_id           uuid,
  out_binding_revision     bigint,
  out_change_request_id    uuid,
  out_new_state            text,
  out_new_state_revision   bigint
)
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_cr           RECORD;
  v_version      RECORD;
  v_val_hash     text;
  v_sim_hash     text;
  v_rule         RECORD;
  v_binding      RECORD;
  v_now          timestamptz;
  v_lock_key     text;
  v_risk         text;
  v_approval_ids uuid[];
  v_counted      int;
  v_distinct_approvers int;
  v_missing_roles text[];
  v_sod_ok       boolean;
  v_is_high_risk boolean;
  v_promo_id     uuid;
  v_binding_id   uuid;
  v_new_binding_rev bigint;
  v_new_state_rev   bigint;
  v_base_version_id uuid := NULL;
  v_base_revision   bigint := 0;
  v_evidence_snapshot jsonb;
  v_failure_code text := NULL;
  v_context_count int;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
  v_version_resolved boolean := false;
  v_rule_resolved    boolean := false;
  v_binding_resolved boolean := false;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'promote_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  -- ── Defect 1: transactional authorization (server time, before any lock) ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    -- cannot promote without an active identity: operational error, no failed record
    RAISE EXCEPTION 'promote_policy_change_request: actor principal % is not active', p_actor_principal_id;
  END IF;

  <<attempt>>
  LOOP
    -- ── Defect 3: resolve CR WITHOUT row lock first ──
    SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promote_policy_change_request: change request % not found', p_change_request_id;
    END IF;

    -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
    -- Permission check happens AFTER the resource tuple is resolved from the
    -- change request but BEFORE acquiring any locks. Repository resources
    -- resolve github_id/installation_id from public.repositories (exactly one
    -- row required; fail closed on zero or ambiguous).
    v_repo_github_id := NULL;
    v_repo_installation_id := NULL;
    IF v_cr.resource_type = 'repository' THEN
      SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_cr.resource_id;
      IF v_repo_row_count != 1 THEN
        RAISE EXCEPTION 'promote_policy_change_request: repository % resolves to % rows (expected 1)',
          v_cr.resource_id, v_repo_row_count;
      END IF;
      SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
        FROM public.repositories repo WHERE repo.full_name = v_cr.resource_id;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM gitwire_auth.auth_principal_roles pr
      JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
      JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
      WHERE pr.principal_id = p_actor_principal_id
        AND rp.permission = 'policy_change_request:promote'
        AND r.status = 'active'
        AND pr.revoked_at IS NULL
        AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
        AND (
          pr.scope_type = 'fleet'
          OR (v_cr.resource_type = 'repository'
              AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
                OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
        )
    ) THEN
      RAISE EXCEPTION 'promote_policy_change_request: actor lacks current policy_change_request:promote permission with applicable scope';
    END IF;

    -- Resolve version early so that resolved domain refusals (not_approved,
    -- stale_request_revision) can write a failed record with version context.
    IF v_cr.selected_version_id IS NOT NULL THEN
      SELECT id, content_hash, author_principal_id AS version_author INTO v_version
        FROM policy_versions WHERE id = v_cr.selected_version_id;
      IF FOUND THEN v_version_resolved := true; END IF;
    END IF;

    IF v_cr.state != 'approved' THEN
      v_failure_code := 'not_approved'; EXIT;
    END IF;
    IF v_cr.state_revision != p_expected_state_revision THEN
      v_failure_code := 'stale_request_revision'; EXIT;
    END IF;
    IF v_cr.selected_version_id IS NULL THEN
      v_failure_code := 'no_selected_version'; EXIT;
    END IF;
    IF NOT v_version_resolved THEN v_failure_code := 'version_not_found'; EXIT; END IF;

    -- ── Defect 2: resolve evidence hashes from the awaiting_approval event ──
    -- Match by version_id (not state_revision, since the CR has since transitioned
    -- to approved at a higher revision). Use the most recent awaiting_approval event.
    SELECT count(*) INTO v_context_count
      FROM policy_transition_events
      WHERE change_request_id = p_change_request_id
        AND to_state = 'awaiting_approval'
        AND detail ? 'validation_evidence_hash'
        AND detail ? 'simulation_evidence_hash'
        AND detail ? 'risk_classification'
        AND detail ? 'version_id'
        AND (detail->>'version_id') = v_version.id::text;
    IF v_context_count = 0 THEN
      RAISE EXCEPTION 'promote_policy_change_request: no awaiting_approval context event for version %', v_version.id;
    END IF;

    SELECT detail->>'validation_evidence_hash',
           detail->>'simulation_evidence_hash',
           detail->>'risk_classification'
      INTO v_val_hash, v_sim_hash, v_risk
      FROM policy_transition_events
      WHERE change_request_id = p_change_request_id
        AND to_state = 'awaiting_approval'
        AND detail ? 'validation_evidence_hash'
        AND detail ? 'simulation_evidence_hash'
        AND detail ? 'risk_classification'
        AND detail ? 'version_id'
        AND (detail->>'version_id') = v_version.id::text
      ORDER BY occurred_at DESC LIMIT 1;

    IF v_val_hash IS NULL OR btrim(v_val_hash) = ''
       OR v_sim_hash IS NULL OR btrim(v_sim_hash) = ''
       OR v_risk IS NULL OR v_risk NOT IN ('standard','elevated','critical') THEN
      v_failure_code := 'invalid_risk'; EXIT;
    END IF;
    v_is_high_risk := v_risk IN ('elevated','critical');

    -- step 5: re-evaluate approval sufficiency.
    -- ── Defect 2: rule selected filtered by risk_classification, not just
    -- scope/family (matches GP-03 effective-rule resolution). Repository
    -- github_id/installation_id were resolved above during the scope-applicable
    -- authorization check and are reused here. ──
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
    IF NOT FOUND THEN v_failure_code := 'no_approval_rule'; EXIT; END IF;
    v_rule_resolved := true;

    -- ── Defect 2: gather approvals on the FULL tuple, latest=active, never consumed ──
    SELECT array_agg(a.id ORDER BY a.id) INTO v_approval_ids
      FROM policy_approvals a
      WHERE a.version_id = v_version.id
        AND a.content_hash = v_version.content_hash
        AND a.validation_evidence_hash = v_val_hash
        AND a.simulation_evidence_hash = v_sim_hash
        AND a.approval_rule_id = v_rule.id
        AND a.approval_rule_hash = v_rule.rule_hash
        AND a.risk_classification = v_risk
        AND (a.expires_at IS NULL OR a.expires_at > v_now)
        AND EXISTS (
          SELECT 1 FROM policy_approval_lifecycle pal
          WHERE pal.approval_id = a.id
            AND pal.to_status = 'active'
            AND pal.lifecycle_revision = (
              SELECT MAX(pal2.lifecycle_revision) FROM policy_approval_lifecycle pal2 WHERE pal2.approval_id = a.id
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM policy_approval_lifecycle pal
          WHERE pal.approval_id = a.id AND pal.to_status = 'consumed'
        )
        AND EXISTS (  -- approver still active
          SELECT 1 FROM gitwire_auth.auth_principals p
            WHERE p.id = a.approver_principal_id AND p.status = 'active'
        );
    IF v_approval_ids IS NULL THEN v_approval_ids := ARRAY[]::uuid[]; END IF;
    v_counted := (SELECT count(DISTINCT a2.approver_principal_id)
                   FROM policy_approvals a2 WHERE a2.id = ANY(v_approval_ids));
    IF v_counted < v_rule.required_count THEN v_failure_code := 'insufficient_approvals'; EXIT; END IF;

    -- required role coverage among the counted approvers (current scope-applicable roles)
    SELECT COALESCE(array_agg(role ORDER BY role COLLATE "C"), ARRAY[]::text[]) INTO v_missing_roles
      FROM (
        SELECT req.role
        FROM jsonb_array_elements_text(v_rule.required_roles) AS req(role)
        WHERE NOT EXISTS (
          SELECT 1
          FROM policy_approvals aa
          JOIN gitwire_auth.auth_principal_roles pr2 ON pr2.principal_id = aa.approver_principal_id
            AND pr2.revoked_at IS NULL
            AND (pr2.expires_at IS NULL OR pr2.expires_at > v_now)
          JOIN gitwire_auth.auth_roles r2 ON r2.id = pr2.role_id AND r2.status = 'active'
          WHERE aa.id = ANY(v_approval_ids)
            AND r2.name = req.role
            AND (
              pr2.scope_type = 'fleet'
              OR (v_cr.resource_type = 'repository'
                  AND ((pr2.scope_type = 'installation' AND pr2.scope_id = v_repo_installation_id)
                    OR (pr2.scope_type = 'repository' AND pr2.scope_id = v_repo_github_id)))
            )
        )
      ) z;
    IF v_missing_roles IS NOT NULL AND array_length(v_missing_roles, 1) IS NOT NULL THEN
      v_failure_code := 'insufficient_approvals'; EXIT;
    END IF;

    -- step 7: ── Defect 3: acquire advisory lock BEFORE locking the binding ──
    v_lock_key := jsonb_build_array('gp05-active-binding', v_cr.resource_type, v_cr.resource_id, v_cr.policy_family)::text;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

    -- steps 8-9: lock and re-read the binding row under the advisory lock
    SELECT * INTO v_binding FROM active_policy_bindings
      WHERE resource_type = v_cr.resource_type AND resource_id = v_cr.resource_id AND policy_family = v_cr.policy_family
      FOR UPDATE;
    v_binding_resolved := FOUND;

    IF NOT v_binding_resolved THEN
      IF p_expected_binding_revision IS NOT NULL THEN v_failure_code := 'stale_binding_revision'; EXIT; END IF;
      v_base_version_id := NULL;
      v_base_revision := 0;
    ELSE
      IF p_expected_binding_revision IS NULL OR v_binding.binding_revision != p_expected_binding_revision THEN
        v_failure_code := 'stale_binding_revision'; EXIT;
      END IF;
      v_base_version_id := v_binding.active_policy_version_id;
      v_base_revision := v_binding.binding_revision;
    END IF;

    -- step 10: separation of duties (actor authorization was checked up front)
    -- SoD: counted approver distinct from change-request author
    IF EXISTS (SELECT 1 FROM policy_approvals a WHERE a.id = ANY(v_approval_ids) AND a.approver_principal_id = v_cr.author_principal_id) THEN
      v_failure_code := 'sod_author_as_approver'; EXIT;
    END IF;
    -- Amendment 5: counted approver distinct from selected version's author
    IF EXISTS (SELECT 1 FROM policy_approvals a WHERE a.id = ANY(v_approval_ids) AND a.approver_principal_id = v_version.version_author) THEN
      v_failure_code := 'sod_version_author_as_approver'; EXIT;
    END IF;
    -- High-risk: promoter distinct from author, version author, approvers
    IF v_is_high_risk THEN
      IF p_actor_principal_id = v_cr.author_principal_id THEN v_failure_code := 'sod_high_risk_promoter_is_author'; EXIT; END IF;
      IF p_actor_principal_id = v_version.version_author THEN v_failure_code := 'sod_high_risk_promoter_is_version_author'; EXIT; END IF;
      IF EXISTS (SELECT 1 FROM policy_approvals a WHERE a.id = ANY(v_approval_ids) AND a.approver_principal_id = p_actor_principal_id) THEN
        v_failure_code := 'sod_high_risk_promoter_is_approver'; EXIT;
      END IF;
    END IF;

    EXIT;  -- all checks passed; proceed to success path below
  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Domain-refusal path: write FAILED promotion record, return normally.
  -- No binding / request / approval-lifecycle / transition-event mutation.
  -- ── Defect 4: explicit resolution boundary. If the version/rule weren't
  -- resolved, this is an operational error (RAISE, no record). If the binding
  -- wasn't reached, use NULL for the binding fields. ──
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_failure_code IS NOT NULL THEN
    IF NOT v_version_resolved THEN
      -- request/version could not be resolved: operational error, no record
      RAISE EXCEPTION 'promote_policy_change_request: cannot write failed record — version not resolved (failure_code=%)', v_failure_code;
    END IF;

    SELECT gen_random_uuid() INTO v_promo_id;
    v_evidence_snapshot := jsonb_build_object(
      'schema_version', 'gp05.promotion.v1',
      'promotion_kind', 'forward',
      'change_request_id', p_change_request_id,
      'change_request_state_revision', v_cr.state_revision,
      'resource_type', v_cr.resource_type,
      'resource_id', v_cr.resource_id,
      'policy_family', v_cr.policy_family,
      'failure_code', v_failure_code,
      'target_version_id', v_version.id,
      'target_content_hash', v_version.content_hash,
      'validation_evidence_hash', v_val_hash,
      'simulation_evidence_hash', v_sim_hash,
      'risk_classification', v_risk,
      'approval_rule_id', CASE WHEN v_rule_resolved THEN v_rule.id ELSE NULL END,
      'counted_approval_ids', to_jsonb(v_approval_ids),
      'base_binding_id', CASE WHEN v_binding_resolved THEN v_binding.id ELSE NULL END,
      'base_version_id', v_base_version_id,
      'base_revision', v_base_revision,
      'promoter_principal_id', p_actor_principal_id,
      'decision_timestamp', v_now);
    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, CASE WHEN v_binding_resolved THEN v_binding.id ELSE NULL END,
       v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       p_change_request_id, v_version.id,
       v_base_version_id, v_base_revision,
       p_actor_principal_id, 'failed', v_failure_code, 'forward', v_evidence_snapshot, v_now);

    out_promotion_record_id := v_promo_id; out_outcome := 'failed';
    out_failure_code := v_failure_code;
    out_binding_id := CASE WHEN v_binding_resolved THEN v_binding.id ELSE NULL END;
    out_binding_revision := CASE WHEN v_binding_resolved THEN v_binding.binding_revision ELSE NULL END;
    out_change_request_id := p_change_request_id; out_new_state := v_cr.state; out_new_state_revision := v_cr.state_revision;
    RETURN NEXT; RETURN;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Success path: steps 11-18
  -- ══════════════════════════════════════════════════════════════════════════
  -- step 11-12: build evidence snapshot + generate IDs
  SELECT gen_random_uuid() INTO v_promo_id;

  v_evidence_snapshot := jsonb_build_object(
    'schema_version', 'gp05.promotion.v1',
    'promotion_kind', 'forward',
    'change_request_id', p_change_request_id,
    'change_request_state_revision', v_cr.state_revision,
    'resource_type', v_cr.resource_type,
    'resource_id', v_cr.resource_id,
    'policy_family', v_cr.policy_family,
    'target_version_id', v_version.id,
    'target_content_hash', v_version.content_hash,
    'validation_evidence_hash', v_val_hash,
    'simulation_evidence_hash', v_sim_hash,
    'risk_classification', v_risk,
    'approval_rule_id', v_rule.id,
    'approval_rule_version', v_rule.rule_revision,
    'approval_rule_hash', v_rule.rule_hash,
    'counted_approval_ids', to_jsonb(v_approval_ids),
    'counted_approval_revisions',
      (SELECT jsonb_agg(jsonb_build_object('approval_id', a.id, 'revision',
        (SELECT MAX(lifecycle_revision) FROM policy_approval_lifecycle WHERE approval_id = a.id)))
       FROM policy_approvals a WHERE a.id = ANY(v_approval_ids)),
    'base_binding_id', v_binding.id,
    'base_version_id', v_base_version_id,
    'base_revision', v_base_revision,
    'promoter_principal_id', p_actor_principal_id,
    'decision_timestamp', v_now
  );

  -- step 13-14: insert promotion record then binding (accepted write order)
  -- For initial promotion: generate both UUIDs up front, insert the promotion
  -- record first with the pre-generated binding_id (the existing DEFERRABLE
  -- INITIALLY DEFERRED policy_promotion_records.binding_id FK permits this),
  -- then insert the binding referencing the already-existing promotion record
  -- (the immediate active_policy_bindings.promotion_record_id FK is satisfied).
  -- No ALTER CONSTRAINT is needed — the existing schema's deferred binding_id
  -- FK is the cycle-breaking mechanism. Promotion records are append-only;
  -- no post-insert UPDATE.
  IF v_binding.id IS NULL THEN
    SELECT gen_random_uuid() INTO v_binding_id;
    v_new_binding_rev := 0;

    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding_id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       p_change_request_id, v_version.id, v_base_version_id, v_base_revision,
       p_actor_principal_id, 'succeeded', NULL, 'forward', v_evidence_snapshot, v_now);

    INSERT INTO active_policy_bindings
      (id, resource_type, resource_id, policy_family, active_policy_version_id,
       binding_revision, promotion_record_id, activated_at, updated_at)
    VALUES (v_binding_id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       v_version.id, 0, v_promo_id, v_now, v_now);
  ELSE
    -- replacement: binding exists, insert promo record then CAS-update binding
    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding.id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       p_change_request_id, v_version.id, v_base_version_id, v_base_revision,
       p_actor_principal_id, 'succeeded', NULL, 'forward', v_evidence_snapshot, v_now);

    UPDATE active_policy_bindings
      SET active_policy_version_id = v_version.id,
          binding_revision = binding_revision + 1,
          promotion_record_id = v_promo_id,
          updated_at = v_now
      WHERE id = v_binding.id AND binding_revision = p_expected_binding_revision
      RETURNING id, binding_revision INTO v_binding_id, v_new_binding_rev;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promote_policy_change_request: binding CAS failed during replacement';
    END IF;
  END IF;

  -- step 15: consume approvals (active → consumed), each linked to the promotion record
  INSERT INTO policy_approval_lifecycle
    (approval_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code, promotion_record_id)
  SELECT a.id,
    (SELECT COALESCE(MAX(pal.lifecycle_revision), 0) + 1 FROM policy_approval_lifecycle pal WHERE pal.approval_id = a.id),
    'active', 'consumed', p_actor_principal_id, 'consumed_by_promotion', v_promo_id
  FROM policy_approvals a WHERE a.id = ANY(v_approval_ids);

  -- step 16: transition request approved → promoted
  UPDATE policy_change_requests
    SET state = 'promoted', state_revision = state_revision + 1, updated_at = now()
    WHERE id = p_change_request_id AND state = 'approved' AND state_revision = p_expected_state_revision
    RETURNING state_revision INTO v_new_state_rev;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'promote_policy_change_request: CAS failed during request promotion transition';
  END IF;

  -- step 17: emit exactly one promotion transition event
  INSERT INTO policy_transition_events (change_request_id, event_type, from_state, to_state, actor_principal_id, detail)
  VALUES (p_change_request_id, 'promotion_complete', 'approved', 'promoted', p_actor_principal_id,
    jsonb_build_object(
      'promotion_record_id', v_promo_id,
      'binding_id', v_binding_id,
      'binding_revision', v_new_binding_rev,
      'promotion_kind', 'forward',
      'target_version_id', v_version.id,
      'risk_classification', v_risk,
      'state_revision', v_new_state_rev));

  -- step 18: return
  out_promotion_record_id := v_promo_id; out_outcome := 'succeeded';
  out_failure_code := NULL; out_binding_id := v_binding_id; out_binding_revision := v_new_binding_rev;
  out_change_request_id := p_change_request_id; out_new_state := 'promoted'; out_new_state_revision := v_new_state_rev;
  RETURN NEXT; RETURN;
END;
$$;

ALTER FUNCTION promote_policy_change_request(uuid, bigint, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION promote_policy_change_request(uuid, bigint, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_policy_change_request(uuid, bigint, bigint, uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Rollback-request creation
-- Server-owned: resolves same-binding target promotion record and derives
-- rollback risk while holding the GP-05 binding advisory lock.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

CREATE FUNCTION create_policy_rollback_request(
  p_binding_id               uuid,
  p_expected_binding_revision bigint,
  p_target_version_id        uuid,
  p_requester_principal_id   uuid
) RETURNS TABLE (
  out_rollback_record_id    uuid,
  out_status                text,
  out_status_revision       bigint,
  out_risk_classification   text,
  out_target_promotion_record_id uuid
)
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_binding      RECORD;
  v_target       RECORD;
  v_base_promo   RECORD;
  v_lock_key     text;
  v_now          timestamptz;
  v_base_risk    text;
  v_target_risk  text;
  v_risk_rank    int;
  v_base_rank    int;
  v_target_rank  int;
  v_risk         text;
  v_new_id       uuid;
  v_detail       jsonb;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;

  IF p_binding_id IS NULL OR p_expected_binding_revision IS NULL
     OR p_target_version_id IS NULL OR p_requester_principal_id IS NULL THEN
    RAISE EXCEPTION 'create_policy_rollback_request: required parameters missing';
  END IF;

  v_now := clock_timestamp();

  -- ── Defect 1: transactional authorization (server time) ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_requester_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'create_policy_rollback_request: requester principal % is not active', p_requester_principal_id;
  END IF;

  -- ── Defect 3: resolve binding WITHOUT row lock first (needed for the
  -- scope-applicable authorization check below). Advisory lock + FOR UPDATE
  -- re-read happen after the permission check. ──
  SELECT * INTO v_binding FROM active_policy_bindings WHERE id = p_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_rollback_request: binding % not found', p_binding_id;
  END IF;

  -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
  -- Resource tuple comes from the active binding. Permission check happens
  -- AFTER the resource tuple is resolved but BEFORE acquiring locks.
  v_repo_github_id := NULL;
  v_repo_installation_id := NULL;
  IF v_binding.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_binding.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'create_policy_rollback_request: repository % resolves to % rows (expected 1)',
        v_binding.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
      FROM public.repositories repo WHERE repo.full_name = v_binding.resource_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
    WHERE pr.principal_id = p_requester_principal_id
      AND rp.permission = 'policy_rollback_request:create'
      AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_binding.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
  ) THEN
    RAISE EXCEPTION 'create_policy_rollback_request: requester lacks current policy_rollback_request:create permission with applicable scope';
  END IF;

  v_lock_key := jsonb_build_array('gp05-active-binding', v_binding.resource_type, v_binding.resource_id, v_binding.policy_family)::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

  SELECT * INTO v_binding FROM active_policy_bindings
    WHERE id = p_binding_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_rollback_request: binding % disappeared under advisory lock', p_binding_id;
  END IF;

  -- enforce expected binding revision
  IF v_binding.binding_revision != p_expected_binding_revision THEN
    RAISE EXCEPTION 'create_policy_rollback_request: stale binding revision (expected %, got %)',
      p_expected_binding_revision, v_binding.binding_revision;
  END IF;

  -- target must differ from current active version
  IF v_binding.active_policy_version_id = p_target_version_id THEN
    RAISE EXCEPTION 'create_policy_rollback_request: target version is the current active version';
  END IF;

  -- Amendment 3: exact same-binding rollback provenance.
  -- Resolve the prior SUCCESSFUL promotion record on THIS binding targeting the requested version.
  SELECT * INTO v_target FROM policy_promotion_records
    WHERE outcome = 'succeeded'
      AND binding_id = p_binding_id
      AND target_version_id = p_target_version_id
      AND resource_type = v_binding.resource_type
      AND resource_id = v_binding.resource_id
      AND policy_family = v_binding.policy_family
    ORDER BY occurred_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_rollback_request: target version % was never successfully promoted on this binding', p_target_version_id;
  END IF;

  -- resolve the base promotion record (the one establishing the current binding)
  SELECT * INTO v_base_promo FROM policy_promotion_records WHERE id = v_binding.promotion_record_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_rollback_request: base promotion record not found';
  END IF;

  -- Amendment 4: authoritative rollback risk = max(base risk, target risk).
  -- ── Defect 6: fail closed on unknown/malformed risk in EITHER source. ──
  v_base_risk   := v_base_promo.evidence_snapshot->>'risk_classification';
  v_target_risk := v_target.evidence_snapshot->>'risk_classification';
  IF v_base_risk NOT IN ('standard','elevated','critical')
     OR v_target_risk NOT IN ('standard','elevated','critical') THEN
    RAISE EXCEPTION 'create_policy_rollback_request: source promotion snapshot has invalid risk (base=%, target=%) — refusing rollback creation',
      v_base_risk, v_target_risk;
  END IF;
  v_base_rank   := CASE v_base_risk   WHEN 'standard' THEN 1 WHEN 'elevated' THEN 2 WHEN 'critical' THEN 3 END;
  v_target_rank := CASE v_target_risk WHEN 'standard' THEN 1 WHEN 'elevated' THEN 2 WHEN 'critical' THEN 3 END;
  v_risk_rank   := GREATEST(v_base_rank, v_target_rank);
  v_risk        := CASE v_risk_rank WHEN 1 THEN 'standard' WHEN 2 THEN 'elevated' WHEN 3 THEN 'critical' END;

  -- create rollback record + revision-zero lifecycle atomically
  SELECT gen_random_uuid() INTO v_new_id;

  v_detail := jsonb_build_object(
    'risk_source', 'max(base_risk, target_risk)',
    'base_promotion_record_id', v_base_promo.id,
    'target_promotion_record_id', v_target.id,
    'base_risk', v_base_risk,
    'target_risk', v_target_risk,
    'resolved_risk', v_risk,
    'authorization_basis', jsonb_build_object(
      'requester_principal_id', p_requester_principal_id,
      'binding_id', p_binding_id,
      'binding_revision', v_binding.binding_revision,
      'checked_at', v_now));

  INSERT INTO policy_rollback_records
    (id, binding_id, expected_binding_revision, base_version_id, target_version_id,
     requester_principal_id, status, status_revision,
     target_promotion_record_id, risk_classification, promotion_record_id)
  VALUES (v_new_id, p_binding_id, p_expected_binding_revision,
     v_binding.active_policy_version_id, p_target_version_id,
     p_requester_principal_id, 'requested', 0,
     v_target.id, v_risk, NULL);

  -- revision-zero lifecycle: NULL → requested
  INSERT INTO policy_rollback_lifecycle
    (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code, promotion_record_id, detail)
  VALUES (v_new_id, 0, NULL, 'requested', p_requester_principal_id, 'created', NULL, v_detail);

  out_rollback_record_id := v_new_id;
  out_status := 'requested';
  out_status_revision := 0;
  out_risk_classification := v_risk;
  out_target_promotion_record_id := v_target.id;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION create_policy_rollback_request(uuid, bigint, uuid, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION create_policy_rollback_request(uuid, bigint, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_policy_rollback_request(uuid, bigint, uuid, uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Rollback approve / reject / withdraw
-- Three narrow SECURITY DEFINER functions sharing the exact-status-revision-CAS
-- pattern: lock record, verify caller's expected revision == current record
-- revision == current lifecycle max, increment by one, append one event.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

-- ── approve: requested → approved ──────────────────────────────────────────
-- Requester cannot approve their own rollback.
CREATE FUNCTION approve_policy_rollback_request(
  p_rollback_record_id     uuid,
  p_expected_status_revision bigint,
  p_actor_principal_id     uuid
) RETURNS TABLE (out_rollback_record_id uuid, out_status text, out_status_revision bigint)
SECURITY DEFINER SET search_path = gitwire_policy, pg_catalog LANGUAGE plpgsql AS $$
DECLARE
  v_rb    RECORD;
  v_binding RECORD;
  v_max   bigint;
  v_new   bigint;
  v_detail jsonb;
  v_now   timestamptz := clock_timestamp();
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;

  -- ── Defect 1: transactional authorization (server time, before any lock) ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: actor principal % is not active', p_actor_principal_id;
  END IF;

  -- ── Defect 3: resolve tuple WITHOUT row lock first so the scope-applicable
  -- authorization check can use the resource tuple. FOR UPDATE re-read below. ──
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'approve_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
  SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'approve_policy_rollback_request: binding % not found', v_rb.binding_id; END IF;

  -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
  -- Resource tuple comes from rollback record → binding.
  v_repo_github_id := NULL;
  v_repo_installation_id := NULL;
  IF v_binding.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_binding.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'approve_policy_rollback_request: repository % resolves to % rows (expected 1)',
        v_binding.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
      FROM public.repositories repo WHERE repo.full_name = v_binding.resource_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id
      AND rp.permission = 'policy_rollback_request:approve'
      AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_binding.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
  ) THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: actor lacks current policy_rollback_request:approve permission with applicable scope';
  END IF;

  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF v_rb.status != 'requested' THEN RAISE EXCEPTION 'approve_policy_rollback_request: status is %, only requested can be approved', v_rb.status; END IF;
  IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'approve_policy_rollback_request: CAS failed — expected %, got %', p_expected_status_revision, v_rb.status_revision; END IF;
  SELECT COALESCE(MAX(lifecycle_revision), 0) INTO v_max FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id;
  IF v_max != v_rb.status_revision THEN RAISE EXCEPTION 'approve_policy_rollback_request: lifecycle max % != record revision %', v_max, v_rb.status_revision; END IF;
  -- distinct from requester
  IF p_actor_principal_id = v_rb.requester_principal_id THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: requester cannot approve their own rollback';
  END IF;

  UPDATE policy_rollback_records SET status = 'approved', status_revision = status_revision + 1, updated_at = now()
    WHERE id = p_rollback_record_id AND status = 'requested' AND status_revision = p_expected_status_revision
    RETURNING status_revision INTO v_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'approve_policy_rollback_request: CAS failed during transition'; END IF;

  v_detail := jsonb_build_object('authorization_basis', jsonb_build_object(
    'approver_principal_id', p_actor_principal_id, 'checked_at', v_now,
    'risk_classification', v_rb.risk_classification));
  INSERT INTO policy_rollback_lifecycle (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code, detail)
  VALUES (p_rollback_record_id, v_new, 'requested', 'approved', p_actor_principal_id, 'approved', v_detail);

  out_rollback_record_id := p_rollback_record_id; out_status := 'approved'; out_status_revision := v_new;
  RETURN NEXT;
END;
$$;
ALTER FUNCTION approve_policy_rollback_request(uuid, bigint, uuid) OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION approve_policy_rollback_request(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approve_policy_rollback_request(uuid, bigint, uuid) TO gitwire_app;

-- ── reject: requested → rejected ───────────────────────────────────────────
CREATE FUNCTION reject_policy_rollback_request(
  p_rollback_record_id     uuid,
  p_expected_status_revision bigint,
  p_actor_principal_id     uuid
) RETURNS TABLE (out_rollback_record_id uuid, out_status text, out_status_revision bigint)
SECURITY DEFINER SET search_path = gitwire_policy, pg_catalog LANGUAGE plpgsql AS $$
DECLARE v_rb RECORD; v_binding RECORD; v_max bigint; v_new bigint;
  v_now timestamptz := clock_timestamp();
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN RAISE EXCEPTION 'reject_policy_rollback_request: caller must be gitwire_app, got %', session_user; END IF;

  -- ── Defect 1: transactional authorization. The original reject did not even
  -- verify the actor was active. Reject is an approver's negative action, so
  -- it requires policy_rollback_request:approve. ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'reject_policy_rollback_request: actor principal % is not active', p_actor_principal_id;
  END IF;

  -- ── Defect 3: resolve tuple WITHOUT row lock first so the scope-applicable
  -- authorization check can use the resource tuple. FOR UPDATE re-read below. ──
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reject_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
  SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'reject_policy_rollback_request: binding % not found', v_rb.binding_id; END IF;

  -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
  -- Resource tuple comes from rollback record → binding.
  v_repo_github_id := NULL;
  v_repo_installation_id := NULL;
  IF v_binding.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_binding.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'reject_policy_rollback_request: repository % resolves to % rows (expected 1)',
        v_binding.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
      FROM public.repositories repo WHERE repo.full_name = v_binding.resource_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id
      AND rp.permission = 'policy_rollback_request:approve'
      AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_binding.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
  ) THEN
    RAISE EXCEPTION 'reject_policy_rollback_request: actor lacks current policy_rollback_request:approve permission with applicable scope';
  END IF;

  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF v_rb.status != 'requested' THEN RAISE EXCEPTION 'reject_policy_rollback_request: status is %, only requested can be rejected', v_rb.status; END IF;
  IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'reject_policy_rollback_request: CAS failed — expected %, got %', p_expected_status_revision, v_rb.status_revision; END IF;
  SELECT COALESCE(MAX(lifecycle_revision), 0) INTO v_max FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id;
  IF v_max != v_rb.status_revision THEN RAISE EXCEPTION 'reject_policy_rollback_request: lifecycle max % != record revision %', v_max, v_rb.status_revision; END IF;

  UPDATE policy_rollback_records SET status = 'rejected', status_revision = status_revision + 1, updated_at = now()
    WHERE id = p_rollback_record_id AND status = 'requested' AND status_revision = p_expected_status_revision
    RETURNING status_revision INTO v_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'reject_policy_rollback_request: CAS failed during transition'; END IF;
  INSERT INTO policy_rollback_lifecycle (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code)
  VALUES (p_rollback_record_id, v_new, 'requested', 'rejected', p_actor_principal_id, 'rejected');
  out_rollback_record_id := p_rollback_record_id; out_status := 'rejected'; out_status_revision := v_new;
  RETURN NEXT;
END;
$$;
ALTER FUNCTION reject_policy_rollback_request(uuid, bigint, uuid) OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION reject_policy_rollback_request(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reject_policy_rollback_request(uuid, bigint, uuid) TO gitwire_app;

-- ── withdraw: requested → withdrawn (by requester only) ────────────────────
CREATE FUNCTION withdraw_policy_rollback_request(
  p_rollback_record_id     uuid,
  p_expected_status_revision bigint,
  p_actor_principal_id     uuid
) RETURNS TABLE (out_rollback_record_id uuid, out_status text, out_status_revision bigint)
SECURITY DEFINER SET search_path = gitwire_policy, pg_catalog LANGUAGE plpgsql AS $$
DECLARE v_rb RECORD; v_binding RECORD; v_max bigint; v_new bigint;
  v_now timestamptz := clock_timestamp();
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: caller must be gitwire_app, got %', session_user; END IF;

  -- ── Defect 1: transactional authorization. Withdraw is by the requester, so
  -- it requires policy_rollback_request:create (the requester's permission). ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'withdraw_policy_rollback_request: actor principal % is not active', p_actor_principal_id;
  END IF;

  -- ── Defect 3: resolve tuple WITHOUT row lock first so the scope-applicable
  -- authorization check can use the resource tuple. FOR UPDATE re-read below. ──
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
  SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: binding % not found', v_rb.binding_id; END IF;

  -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
  -- Resource tuple comes from rollback record → binding.
  v_repo_github_id := NULL;
  v_repo_installation_id := NULL;
  IF v_binding.resource_type = 'repository' THEN
    SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_binding.resource_id;
    IF v_repo_row_count != 1 THEN
      RAISE EXCEPTION 'withdraw_policy_rollback_request: repository % resolves to % rows (expected 1)',
        v_binding.resource_id, v_repo_row_count;
    END IF;
    SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
      FROM public.repositories repo WHERE repo.full_name = v_binding.resource_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM gitwire_auth.auth_principal_roles pr
    JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
    JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
    WHERE pr.principal_id = p_actor_principal_id
      AND rp.permission = 'policy_rollback_request:create'
      AND r.status = 'active'
      AND pr.revoked_at IS NULL
      AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
      AND (
        pr.scope_type = 'fleet'
        OR (v_binding.resource_type = 'repository'
            AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
              OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
      )
  ) THEN
    RAISE EXCEPTION 'withdraw_policy_rollback_request: actor lacks current policy_rollback_request:create permission with applicable scope';
  END IF;

  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF v_rb.status NOT IN ('requested','approved') THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: status is %, only requested/approved can be withdrawn', v_rb.status; END IF;
  IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: CAS failed — expected %, got %', p_expected_status_revision, v_rb.status_revision; END IF;
  SELECT COALESCE(MAX(lifecycle_revision), 0) INTO v_max FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id;
  IF v_max != v_rb.status_revision THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: lifecycle max % != record revision %', v_max, v_rb.status_revision; END IF;
  IF p_actor_principal_id != v_rb.requester_principal_id THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: only the requester may withdraw'; END IF;

  UPDATE policy_rollback_records SET status = 'withdrawn', status_revision = status_revision + 1, updated_at = now()
    WHERE id = p_rollback_record_id AND status_revision = p_expected_status_revision
    RETURNING status_revision INTO v_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: CAS failed during transition'; END IF;
  INSERT INTO policy_rollback_lifecycle (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code)
  VALUES (p_rollback_record_id, v_new, v_rb.status, 'withdrawn', p_actor_principal_id, 'withdrawn');
  out_rollback_record_id := p_rollback_record_id; out_status := 'withdrawn'; out_status_revision := v_new;
  RETURN NEXT;
END;
$$;
ALTER FUNCTION withdraw_policy_rollback_request(uuid, bigint, uuid) OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION withdraw_policy_rollback_request(uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION withdraw_policy_rollback_request(uuid, bigint, uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Rollback promotion finalizer
-- Atomic single-writer. Uses the same binding advisory lock as forward promotion.
--
-- Two failure classes (amendment 6):
--   attempt-local refusals (unauthorized/stale-revision/SOD/malformed):
--     RAISE — transaction rolls back, rollback request stays at approved.
--   request-invalidating refusals (binding drifted / target provenance broken):
--     transition approved → failed, write one failed promotion record + lifecycle.
--   operational failures: RAISE — full rollback, request stays at approved.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

CREATE FUNCTION promote_policy_rollback_request(
  p_rollback_record_id       uuid,
  p_expected_status_revision bigint,
  p_expected_binding_revision bigint,
  p_actor_principal_id       uuid
) RETURNS TABLE (
  out_promotion_record_id  uuid,
  out_outcome              text,
  out_failure_code         text,
  out_rollback_record_id   uuid,
  out_status               text,
  out_status_revision      bigint,
  out_binding_id           uuid,
  out_binding_revision     bigint
)
SECURITY DEFINER
SET search_path = gitwire_policy, pg_catalog
LANGUAGE plpgsql AS $$
DECLARE
  v_rb           RECORD;
  v_binding      RECORD;
  v_target_promo RECORD;
  v_now          timestamptz;
  v_lock_key     text;
  v_failure_code text := NULL;
  v_request_invalidating boolean := false;
  v_is_high_risk boolean;
  v_promo_id     uuid;
  v_new_binding_rev bigint;
  v_new_status_rev  bigint;
  v_evidence_snapshot jsonb;
  v_lifecycle_max    bigint;
  v_fail_resource_type   text;
  v_fail_resource_id     text;
  v_fail_policy_family   text;
  v_fail_change_request_id uuid;
  v_repo_github_id bigint;
  v_repo_installation_id bigint;
  v_repo_row_count int;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'promote_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;
  v_now := clock_timestamp();

  -- ── Defect 1: transactional authorization (server time, before any lock) ──
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'promote_policy_rollback_request: actor principal % is not active', p_actor_principal_id;
  END IF;

  <<attempt>>
  LOOP
    -- ── Defect 3: resolve the rollback record WITHOUT row lock first ──
    SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'promote_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;

    -- ── Scope-applicable authorization (GP-03 scope hierarchy) ──
    -- Resource tuple comes from rollback record → binding. Resolve the binding
    -- WITHOUT a row lock so the permission check can use the resource tuple
    -- before any lock is acquired. If the binding is missing the request-
    -- invalidating 'binding_missing' path below handles it (RAISEs as a data
    -- integrity failure); the scope check only runs when the tuple resolves.
    SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id;
    IF FOUND THEN
      v_repo_github_id := NULL;
      v_repo_installation_id := NULL;
      IF v_binding.resource_type = 'repository' THEN
        SELECT count(*) INTO v_repo_row_count FROM public.repositories WHERE full_name = v_binding.resource_id;
        IF v_repo_row_count != 1 THEN
          RAISE EXCEPTION 'promote_policy_rollback_request: repository % resolves to % rows (expected 1)',
            v_binding.resource_id, v_repo_row_count;
        END IF;
        SELECT repo.github_id, repo.installation_id INTO v_repo_github_id, v_repo_installation_id
          FROM public.repositories repo WHERE repo.full_name = v_binding.resource_id;
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM gitwire_auth.auth_principal_roles pr
        JOIN gitwire_auth.auth_roles r ON pr.role_id = r.id
        JOIN gitwire_auth.auth_role_permissions rp ON rp.role_id = r.id
        WHERE pr.principal_id = p_actor_principal_id
          AND rp.permission = 'policy_rollback_request:promote'
          AND r.status = 'active'
          AND pr.revoked_at IS NULL
          AND (pr.expires_at IS NULL OR pr.expires_at > v_now)
          AND (
            pr.scope_type = 'fleet'
            OR (v_binding.resource_type = 'repository'
                AND ((pr.scope_type = 'installation' AND pr.scope_id = v_repo_installation_id)
                  OR (pr.scope_type = 'repository' AND pr.scope_id = v_repo_github_id)))
          )
      ) THEN
        RAISE EXCEPTION 'promote_policy_rollback_request: actor lacks current policy_rollback_request:promote permission with applicable scope';
      END IF;
    END IF;

    -- attempt-local refusals (these RAISE, not domain-refusal)
    IF v_rb.status != 'approved' THEN RAISE EXCEPTION 'promote_policy_rollback_request: status is %, only approved can be promoted', v_rb.status; END IF;
    IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'promote_policy_rollback_request: stale status revision (expected %, got %)', p_expected_status_revision, v_rb.status_revision; END IF;

    -- ── Defect 5: verify status_revision equals the current lifecycle maximum
    -- BEFORE executing. ──
    SELECT COALESCE(MAX(lifecycle_revision), 0) INTO v_lifecycle_max
      FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id;
    IF v_lifecycle_max != v_rb.status_revision THEN
      RAISE EXCEPTION 'promote_policy_rollback_request: lifecycle max % != record revision %', v_lifecycle_max, v_rb.status_revision;
    END IF;

    -- SoD: requester cannot be promoter; high-risk: approver cannot be promoter either
    IF p_actor_principal_id = v_rb.requester_principal_id THEN
      RAISE EXCEPTION 'promote_policy_rollback_request: requester cannot promote their own rollback';
    END IF;
    v_is_high_risk := v_rb.risk_classification IN ('elevated','critical');
    IF v_is_high_risk THEN
      IF EXISTS (SELECT 1 FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id AND to_status = 'approved' AND actor_principal_id = p_actor_principal_id) THEN
        RAISE EXCEPTION 'promote_policy_rollback_request: high-risk promoter cannot be the approver';
      END IF;
    END IF;

    -- ── Defect 3: acquire advisory lock BEFORE locking the binding row ──
    -- The advisory lock key requires binding columns; resolve them first with
    -- a non-locking SELECT (the lock namespace is the resource tuple).
    SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id;
    IF NOT FOUND THEN v_failure_code := 'binding_missing'; v_request_invalidating := true; EXIT; END IF;

    v_lock_key := jsonb_build_array('gp05-active-binding', v_binding.resource_type, v_binding.resource_id, v_binding.policy_family)::text;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

    -- now lock and re-read the binding row under the advisory lock
    SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id FOR UPDATE;
    IF NOT FOUND THEN v_failure_code := 'binding_missing'; v_request_invalidating := true; EXIT; END IF;

    -- request-invalidating checks (binding drifted / target provenance broken)

    -- ── Defect 5: frozen-revision enforcement. ALL THREE must be equal:
    -- caller-expected == rollback-record-expected == current binding. ──
    IF p_expected_binding_revision != v_rb.expected_binding_revision THEN
      v_failure_code := 'stale_binding_revision'; v_request_invalidating := true; EXIT;
    END IF;
    IF v_binding.binding_revision != p_expected_binding_revision THEN
      v_failure_code := 'stale_binding_revision'; v_request_invalidating := true; EXIT;
    END IF;
    IF v_binding.active_policy_version_id != v_rb.base_version_id THEN
      v_failure_code := 'base_version_mismatch'; v_request_invalidating := true; EXIT;
    END IF;

    -- revalidate target eligibility (same-binding prior promotion)
    SELECT * INTO v_target_promo FROM policy_promotion_records
      WHERE id = v_rb.target_promotion_record_id
        AND outcome = 'succeeded'
        AND binding_id = v_rb.binding_id
        AND target_version_id = v_rb.target_version_id
        AND resource_type = v_binding.resource_type
        AND resource_id = v_binding.resource_id
        AND policy_family = v_binding.policy_family;
    IF NOT FOUND THEN
      v_failure_code := 'target_provenance_invalid'; v_request_invalidating := true; EXIT;
    END IF;

    EXIT;  -- all checks passed
  END LOOP;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Request-invalidating refusal: approved → failed + failed promotion record
  -- ── Defect 4: do not dereference v_binding / v_target_promo fields when the
  -- matching path left them unassigned. binding_missing is an operational FK
  -- integrity error (RAISE, no record). For the other request-invalidating
  -- codes, v_binding is resolved; for change_request_id we use a guarded lookup
  -- rather than dereferencing v_target_promo (which is unassigned on
  -- target_provenance_invalid). ──
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_failure_code IS NOT NULL AND v_request_invalidating THEN
    IF v_failure_code = 'binding_missing' THEN
      -- The binding referenced by the rollback record does not exist. The FK
      -- constraint would normally prevent this; reaching here means data
      -- corruption. Do not attempt to write a promotion record (we have no
      -- resource_type/id/family); surface as an operational error.
      RAISE EXCEPTION 'promote_policy_rollback_request: binding % referenced by rollback % does not exist (data integrity failure)',
        v_rb.binding_id, p_rollback_record_id;
    END IF;

    -- v_binding IS resolved for stale_binding_revision / base_version_mismatch /
    -- target_provenance_invalid. Resolve change_request_id WITHOUT dereferencing
    -- v_target_promo (unassigned on target_provenance_invalid): pull from the
    -- target promotion row by id; if that row is gone too, fall back to the
    -- base binding's promotion record.
    v_fail_resource_type := v_binding.resource_type;
    v_fail_resource_id   := v_binding.resource_id;
    v_fail_policy_family := v_binding.policy_family;
    SELECT ppr.change_request_id INTO v_fail_change_request_id
      FROM policy_promotion_records ppr
      WHERE ppr.id = v_rb.target_promotion_record_id;
    IF v_fail_change_request_id IS NULL THEN
      SELECT ppr.change_request_id INTO v_fail_change_request_id
        FROM policy_promotion_records ppr WHERE ppr.id = v_binding.promotion_record_id;
    END IF;
    IF v_fail_change_request_id IS NULL THEN
      -- Cannot satisfy the NOT NULL change_request_id column; operational error.
      RAISE EXCEPTION 'promote_policy_rollback_request: cannot resolve change_request_id for failed record (failure_code=%)', v_failure_code;
    END IF;

    SELECT gen_random_uuid() INTO v_promo_id;
    v_evidence_snapshot := jsonb_build_object(
      'schema_version', 'gp05.promotion.v1', 'promotion_kind', 'rollback',
      'rollback_record_id', p_rollback_record_id, 'failure_code', v_failure_code,
      'target_version_id', v_rb.target_version_id, 'risk_classification', v_rb.risk_classification,
      'binding_id', v_rb.binding_id, 'expected_binding_revision', p_expected_binding_revision,
      'caller_expected_binding_revision', p_expected_binding_revision,
      'rollback_record_expected_binding_revision', v_rb.expected_binding_revision,
      'current_binding_revision', v_binding.binding_revision,
      'promoter_principal_id', p_actor_principal_id, 'decision_timestamp', v_now);

    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding.id, v_fail_resource_type, v_fail_resource_id, v_fail_policy_family,
       v_fail_change_request_id, v_rb.target_version_id, v_rb.base_version_id, v_binding.binding_revision,
       p_actor_principal_id, 'failed', v_failure_code, 'rollback', v_evidence_snapshot, v_now);

    -- transition rollback record approved → failed, link promotion record
    UPDATE policy_rollback_records
      SET status = 'failed', status_revision = status_revision + 1, promotion_record_id = v_promo_id, updated_at = now()
      WHERE id = p_rollback_record_id AND status = 'approved' AND status_revision = p_expected_status_revision
      RETURNING status_revision INTO v_new_status_rev;
    IF NOT FOUND THEN RAISE EXCEPTION 'promote_policy_rollback_request: CAS failed during fail transition'; END IF;

    INSERT INTO policy_rollback_lifecycle
      (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code, promotion_record_id, detail)
    VALUES (p_rollback_record_id, v_new_status_rev, 'approved', 'failed', p_actor_principal_id, v_failure_code, v_promo_id, v_evidence_snapshot);

    out_promotion_record_id := v_promo_id; out_outcome := 'failed'; out_failure_code := v_failure_code;
    out_rollback_record_id := p_rollback_record_id; out_status := 'failed'; out_status_revision := v_new_status_rev;
    out_binding_id := v_binding.id; out_binding_revision := v_binding.binding_revision;
    RETURN NEXT; RETURN;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════════
  -- Success path (amendment 7 ordering)
  -- ══════════════════════════════════════════════════════════════════════════
  SELECT gen_random_uuid() INTO v_promo_id;
  v_evidence_snapshot := jsonb_build_object(
    'schema_version', 'gp05.promotion.v1', 'promotion_kind', 'rollback',
    'rollback_record_id', p_rollback_record_id,
    'binding_id', v_binding.id, 'target_version_id', v_rb.target_version_id,
    'target_promotion_record_id', v_rb.target_promotion_record_id,
    'base_version_id', v_rb.base_version_id, 'risk_classification', v_rb.risk_classification,
    'promoter_principal_id', p_actor_principal_id, 'decision_timestamp', v_now);

  -- (a) insert successful rollback promotion record
  INSERT INTO policy_promotion_records
    (id, binding_id, resource_type, resource_id, policy_family,
     change_request_id, target_version_id, base_version_id, base_revision,
     promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
  VALUES (v_promo_id, v_binding.id, v_binding.resource_type, v_binding.resource_id, v_binding.policy_family,
     v_target_promo.change_request_id, v_rb.target_version_id, v_binding.active_policy_version_id, v_binding.binding_revision,
     p_actor_principal_id, 'succeeded', NULL, 'rollback', v_evidence_snapshot, v_now);

  -- (b) CAS-update active binding
  UPDATE active_policy_bindings
    SET active_policy_version_id = v_rb.target_version_id,
        binding_revision = binding_revision + 1,
        promotion_record_id = v_promo_id,
        updated_at = v_now
    WHERE id = v_binding.id AND binding_revision = p_expected_binding_revision
    RETURNING binding_revision INTO v_new_binding_rev;
  IF NOT FOUND THEN RAISE EXCEPTION 'promote_policy_rollback_request: binding CAS failed'; END IF;

  -- (c) update rollback record approved → promoted
  UPDATE policy_rollback_records
    SET status = 'promoted', status_revision = status_revision + 1, promotion_record_id = v_promo_id, updated_at = now()
    WHERE id = p_rollback_record_id AND status = 'approved' AND status_revision = p_expected_status_revision
    RETURNING status_revision INTO v_new_status_rev;
  IF NOT FOUND THEN RAISE EXCEPTION 'promote_policy_rollback_request: CAS failed during promote transition'; END IF;

  -- (d) append rollback lifecycle approved → promoted, linked to promotion record
  INSERT INTO policy_rollback_lifecycle
    (rollback_record_id, lifecycle_revision, from_status, to_status, actor_principal_id, reason_code, promotion_record_id, detail)
  VALUES (p_rollback_record_id, v_new_status_rev, 'approved', 'promoted', p_actor_principal_id, 'promoted', v_promo_id, v_evidence_snapshot);

  out_promotion_record_id := v_promo_id; out_outcome := 'succeeded'; out_failure_code := NULL;
  out_rollback_record_id := p_rollback_record_id; out_status := 'promoted'; out_status_revision := v_new_status_rev;
  out_binding_id := v_binding.id; out_binding_revision := v_new_binding_rev;
  RETURN NEXT;
END;
$$;

ALTER FUNCTION promote_policy_rollback_request(uuid, bigint, bigint, uuid)
  OWNER TO gitwire_policy_fn_owner;
REVOKE ALL ON FUNCTION promote_policy_rollback_request(uuid, bigint, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION promote_policy_rollback_request(uuid, bigint, bigint, uuid) TO gitwire_app;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- 10. Record function provenance for all GP-05 functions
-- Exact pattern from GP-03/04: prosrc sha256 + canonical ACL.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path = gitwire_policy, pg_catalog;

DO $$
DECLARE
  v_fn record;
  v_acl text;
BEGIN
  FOR v_fn IN
    SELECT p.proname, p.oid, p.prosrc, p.proacl,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_result(p.oid) AS ret_type,
           l.lanname, pg_get_userbyid(p.proowner) AS owner_name,
           p.prosecdef, COALESCE(array_to_string(p.proconfig,','),'') AS config
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      WHERE n.nspname = 'gitwire_policy'
        AND p.proname IN ('promote_policy_change_request','create_policy_rollback_request',
                          'approve_policy_rollback_request','reject_policy_rollback_request',
                          'withdraw_policy_rollback_request','promote_policy_rollback_request')
  LOOP
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

    INSERT INTO gp05_function_provenance
      (proname, identity_args, prosrc_hash, ret_type, lang_name, owner_name, prosecdef, proconfig, acl_canonical)
    VALUES (v_fn.proname, v_fn.identity_args,
            encode(public.digest(v_fn.prosrc, 'sha256'), 'hex'),
            v_fn.ret_type, v_fn.lanname, v_fn.owner_name,
            v_fn.prosecdef, v_fn.config, v_acl);
  END LOOP;
END $$;

RESET search_path;

-- ════════════════════════════════════════════════════════════════════════════
-- 11. Canonical permission declarations
-- Attached to the built-in admin role (040 pattern). ON CONFLICT DO NOTHING
-- so re-application is idempotent.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO gitwire_auth.auth_role_permissions (role_id, permission)
SELECT r.id, t.perm
FROM gitwire_auth.auth_roles r
CROSS JOIN (
  VALUES
    ('admin', 'policy_change_request:promote'),
    ('admin', 'policy_rollback_request:create'),
    ('admin', 'policy_rollback_request:approve'),
    ('admin', 'policy_rollback_request:promote'),
    ('admin', 'policy_rollback_request:read'),
    ('admin', 'policy_active_binding:read'),
    ('admin', 'policy_promotion_record:read')
) AS t(role, perm)
WHERE r.name = t.role AND r.is_builtin
ON CONFLICT (role_id, permission) DO NOTHING;
