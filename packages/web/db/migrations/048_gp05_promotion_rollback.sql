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
-- 0b. Make active_policy_bindings.promotion_record_id FK deferrable
-- The inline FK created in 043 is immediate. GP-05 initial promotion inserts the
-- binding before the promotion record (the promotion record's CHECK requires a
-- non-null binding_id for succeeded). Deferring the binding's FK to the promotion
-- record allows both inserts to succeed within one transaction. Additive ALTER.
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE active_policy_bindings
  ALTER CONSTRAINT active_policy_bindings_promotion_record_id_fkey
  DEFERRABLE INITIALLY DEFERRED;

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
-- policy_change_requests: UPDATE needed for approved→promoted transition (SELECT+INSERT already via 045)
GRANT UPDATE ON policy_change_requests TO gitwire_policy_fn_owner;
-- policy_approval_lifecycle: INSERT already via 046; ensure SELECT for re-evaluation
GRANT SELECT ON policy_approval_lifecycle TO gitwire_policy_fn_owner;

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
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'promote_policy_change_request: caller must be gitwire_app, got %', session_user;
  END IF;

  v_now := clock_timestamp();

  <<attempt>>
  LOOP
    -- steps 1-2: lock and resolve the change request
    SELECT * INTO v_cr FROM policy_change_requests WHERE id = p_change_request_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'promote_policy_change_request: change request % not found', p_change_request_id;
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

    -- steps 3-4: resolve version + evidence
    SELECT id, content_hash, author_principal_id AS version_author INTO v_version
      FROM policy_versions WHERE id = v_cr.selected_version_id;
    IF NOT FOUND THEN v_failure_code := 'version_not_found'; EXIT; END IF;

    SELECT evidence_hash INTO v_val_hash FROM policy_validation_evidence
      WHERE version_id = v_version.id ORDER BY created_at DESC LIMIT 1;
    IF v_val_hash IS NULL THEN v_failure_code := 'evidence_missing'; EXIT; END IF;

    SELECT evidence_hash INTO v_sim_hash FROM policy_simulation_evidence
      WHERE version_id = v_version.id ORDER BY created_at DESC LIMIT 1;
    IF v_sim_hash IS NULL THEN v_failure_code := 'evidence_missing'; EXIT; END IF;

    -- step 5: re-evaluate approval sufficiency
    SELECT * INTO v_rule FROM policy_approval_rules
      WHERE resource_scope_type = v_cr.resource_type
        AND resource_scope_id   = v_cr.resource_id
        AND policy_family        = v_cr.policy_family
      ORDER BY rule_revision DESC LIMIT 1;
    IF NOT FOUND THEN v_failure_code := 'no_approval_rule'; EXIT; END IF;

    -- gather active, unconsumed approvals for this exact version
    SELECT array_agg(a.id ORDER BY a.id) INTO v_approval_ids
      FROM policy_approvals a
      WHERE a.version_id = v_version.id
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
        );
    IF v_approval_ids IS NULL THEN v_approval_ids := ARRAY[]::uuid[]; END IF;
    v_counted := COALESCE(array_length(v_approval_ids, 1), 0);
    IF v_counted < v_rule.required_count THEN v_failure_code := 'insufficient_approvals'; EXIT; END IF;

    -- step 6: derive authoritative risk
    v_risk := (SELECT result->'risk'->>'classification' FROM policy_simulation_evidence
               WHERE version_id = v_version.id ORDER BY created_at DESC LIMIT 1);
    IF v_risk NOT IN ('standard','elevated','critical') THEN v_failure_code := 'invalid_risk'; EXIT; END IF;
    v_is_high_risk := v_risk IN ('elevated','critical');

    -- step 7: acquire resource-binding advisory lock
    v_lock_key := jsonb_build_array('gp05-active-binding', v_cr.resource_type, v_cr.resource_id, v_cr.policy_family)::text;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

    -- steps 8-9: resolve and lock current binding, enforce CAS
    SELECT * INTO v_binding FROM active_policy_bindings
      WHERE resource_type = v_cr.resource_type AND resource_id = v_cr.resource_id AND policy_family = v_cr.policy_family
      FOR UPDATE;

    IF v_binding.id IS NULL THEN
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

    -- step 10: actor status + separation of duties
    IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
      v_failure_code := 'inactive_actor'; EXIT;
    END IF;

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
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_failure_code IS NOT NULL THEN
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
      'approval_rule_id', v_rule.id,
      'counted_approval_ids', to_jsonb(v_approval_ids),
      'base_binding_id', v_binding.id,
      'base_version_id', v_base_version_id,
      'base_revision', v_base_revision,
      'promoter_principal_id', p_actor_principal_id,
      'decision_timestamp', v_now);
    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding.id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       p_change_request_id, COALESCE(v_version.id, v_cr.selected_version_id),
       v_base_version_id, v_base_revision,
       p_actor_principal_id, 'failed', v_failure_code, 'forward', v_evidence_snapshot, v_now);

    out_promotion_record_id := v_promo_id; out_outcome := 'failed';
    out_failure_code := v_failure_code;
    out_binding_id := v_binding.id; out_binding_revision := v_binding.binding_revision;
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

  -- step 13-14: insert promotion record + binding (order depends on initial vs replacement)
  -- For initial promotion: binding doesn't exist yet. Generate both UUIDs up front,
  -- insert the binding first (deferred FK allows referencing not-yet-existing promo record),
  -- then insert the promotion record with the binding_id (satisfies the CHECK constraint).
  IF v_binding.id IS NULL THEN
    -- initial: generate binding ID, insert binding, then insert promo record
    SELECT gen_random_uuid() INTO v_binding_id;
    INSERT INTO active_policy_bindings
      (id, resource_type, resource_id, policy_family, active_policy_version_id,
       binding_revision, promotion_record_id, activated_at, updated_at)
    VALUES (v_binding_id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       v_version.id, 0, v_promo_id, v_now, v_now);
    v_new_binding_rev := 0;

    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding_id, v_cr.resource_type, v_cr.resource_id, v_cr.policy_family,
       p_change_request_id, v_version.id, v_base_version_id, v_base_revision,
       p_actor_principal_id, 'succeeded', NULL, 'forward', v_evidence_snapshot, v_now);
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
  v_risk_rank    int;
  v_base_rank    int;
  v_target_rank  int;
  v_risk         text;
  v_new_id       uuid;
  v_detail       jsonb;
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'create_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;

  IF p_binding_id IS NULL OR p_expected_binding_revision IS NULL
     OR p_target_version_id IS NULL OR p_requester_principal_id IS NULL THEN
    RAISE EXCEPTION 'create_policy_rollback_request: required parameters missing';
  END IF;

  v_now := clock_timestamp();

  -- acquire binding advisory lock BEFORE resolving anything
  SELECT * INTO v_binding FROM active_policy_bindings WHERE id = p_binding_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_policy_rollback_request: binding % not found', p_binding_id;
  END IF;

  v_lock_key := jsonb_build_array('gp05-active-binding', v_binding.resource_type, v_binding.resource_id, v_binding.policy_family)::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

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

  -- Amendment 4: authoritative rollback risk = max(base risk, target risk)
  v_base_rank   := CASE v_base_promo.evidence_snapshot->>'risk_classification' WHEN 'standard' THEN 1 WHEN 'elevated' THEN 2 WHEN 'critical' THEN 3 ELSE 1 END;
  v_target_rank := CASE v_target.evidence_snapshot->>'risk_classification'   WHEN 'standard' THEN 1 WHEN 'elevated' THEN 2 WHEN 'critical' THEN 3 ELSE 1 END;
  v_risk_rank   := GREATEST(v_base_rank, v_target_rank);
  v_risk        := CASE v_risk_rank WHEN 1 THEN 'standard' WHEN 2 THEN 'elevated' WHEN 3 THEN 'critical' END;

  -- requester must be active
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_requester_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'create_policy_rollback_request: requester principal is not active';
  END IF;

  -- create rollback record + revision-zero lifecycle atomically
  SELECT gen_random_uuid() INTO v_new_id;

  v_detail := jsonb_build_object(
    'risk_source', 'max(base_risk, target_risk)',
    'base_promotion_record_id', v_base_promo.id,
    'target_promotion_record_id', v_target.id,
    'base_risk', v_base_promo.evidence_snapshot->>'risk_classification',
    'target_risk', v_target.evidence_snapshot->>'risk_classification',
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
  v_max   bigint;
  v_new   bigint;
  v_detail jsonb;
  v_now   timestamptz := clock_timestamp();
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'approve_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
  IF v_rb.status != 'requested' THEN RAISE EXCEPTION 'approve_policy_rollback_request: status is %, only requested can be approved', v_rb.status; END IF;
  IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'approve_policy_rollback_request: CAS failed — expected %, got %', p_expected_status_revision, v_rb.status_revision; END IF;
  SELECT COALESCE(MAX(lifecycle_revision), 0) INTO v_max FROM policy_rollback_lifecycle WHERE rollback_record_id = p_rollback_record_id;
  IF v_max != v_rb.status_revision THEN RAISE EXCEPTION 'approve_policy_rollback_request: lifecycle max % != record revision %', v_max, v_rb.status_revision; END IF;
  -- actor must be active and distinct from requester
  IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
    RAISE EXCEPTION 'approve_policy_rollback_request: actor is not active';
  END IF;
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
DECLARE v_rb RECORD; v_max bigint; v_new bigint;
BEGIN
  IF session_user != 'gitwire_app' THEN RAISE EXCEPTION 'reject_policy_rollback_request: caller must be gitwire_app, got %', session_user; END IF;
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reject_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
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
DECLARE v_rb RECORD; v_max bigint; v_new bigint;
BEGIN
  IF session_user != 'gitwire_app' THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: caller must be gitwire_app, got %', session_user; END IF;
  SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'withdraw_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;
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
BEGIN
  IF session_user != 'gitwire_app' THEN
    RAISE EXCEPTION 'promote_policy_rollback_request: caller must be gitwire_app, got %', session_user;
  END IF;
  v_now := clock_timestamp();

  <<attempt>>
  LOOP
    SELECT * INTO v_rb FROM policy_rollback_records WHERE id = p_rollback_record_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'promote_policy_rollback_request: rollback record % not found', p_rollback_record_id; END IF;

    -- attempt-local refusals (these RAISE, not domain-refusal)
    IF v_rb.status != 'approved' THEN RAISE EXCEPTION 'promote_policy_rollback_request: status is %, only approved can be promoted', v_rb.status; END IF;
    IF v_rb.status_revision != p_expected_status_revision THEN RAISE EXCEPTION 'promote_policy_rollback_request: stale status revision (expected %, got %)', p_expected_status_revision, v_rb.status_revision; END IF;
    IF NOT EXISTS (SELECT 1 FROM gitwire_auth.auth_principals p WHERE p.id = p_actor_principal_id AND p.status = 'active') THEN
      RAISE EXCEPTION 'promote_policy_rollback_request: actor is not active';
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

    -- acquire binding advisory lock (same expression as forward promotion)
    SELECT * INTO v_binding FROM active_policy_bindings WHERE id = v_rb.binding_id FOR UPDATE;
    IF NOT FOUND THEN v_failure_code := 'binding_missing'; v_request_invalidating := true; EXIT; END IF;

    v_lock_key := jsonb_build_array('gp05-active-binding', v_binding.resource_type, v_binding.resource_id, v_binding.policy_family)::text;
    PERFORM pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));

    -- request-invalidating checks (binding drifted / target provenance broken)
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
  -- ══════════════════════════════════════════════════════════════════════════
  IF v_failure_code IS NOT NULL AND v_request_invalidating THEN
    SELECT gen_random_uuid() INTO v_promo_id;
    v_evidence_snapshot := jsonb_build_object(
      'schema_version', 'gp05.promotion.v1', 'promotion_kind', 'rollback',
      'rollback_record_id', p_rollback_record_id, 'failure_code', v_failure_code,
      'target_version_id', v_rb.target_version_id, 'risk_classification', v_rb.risk_classification,
      'binding_id', v_rb.binding_id, 'expected_binding_revision', p_expected_binding_revision,
      'promoter_principal_id', p_actor_principal_id, 'decision_timestamp', v_now);

    INSERT INTO policy_promotion_records
      (id, binding_id, resource_type, resource_id, policy_family,
       change_request_id, target_version_id, base_version_id, base_revision,
       promoter_principal_id, outcome, failure_code, promotion_kind, evidence_snapshot, occurred_at)
    VALUES (v_promo_id, v_binding.id, v_binding.resource_type, v_binding.resource_id, v_binding.policy_family,
       v_target_promo.change_request_id, v_rb.target_version_id, v_binding.active_policy_version_id, v_binding.binding_revision,
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
