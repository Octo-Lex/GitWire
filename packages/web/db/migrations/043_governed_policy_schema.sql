-- Migration 043: governed_policy_schema
-- Governed Policy Authority and Approval (issue #96, GP-01).
--
-- Creates the gitwire_policy schema with 12 tables for immutable policy
-- versioning, evidence-bound approvals, single-writer promotion, and
-- governed rollback. Follows the 038/041 migration pattern:
--   * Dedicated schema, CREATE revoked from PUBLIC
--   * Fixed search_path, all objects schema-qualified
--   * Plain CREATE TABLE (no IF NOT EXISTS) — collision aborts
--   * UUID primary keys, BIGINT revisions
--   * Append-only SECURITY INVOKER triggers on 8 immutable tables
--   * REVOKE ALL ON FUNCTION ... FROM PUBLIC on all trigger functions
--
-- All objects are additive. No existing table is modified destructively.

CREATE SCHEMA gitwire_policy;
REVOKE CREATE ON SCHEMA gitwire_policy FROM PUBLIC;

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Table 1: policy_change_requests
-- Governing workflow and target resource.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_change_requests (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type         text        NOT NULL,
  resource_id           text        NOT NULL,
  policy_family         text        NOT NULL,
  state                 text        NOT NULL DEFAULT 'draft',
  state_revision        bigint      NOT NULL DEFAULT 0,
  selected_version_id   uuid,
  author_principal_id   uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  submitted_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pcr_state_check
    CHECK (state IN ('draft','submitted','validating','awaiting_approval','approved','promoted','rejected','withdrawn','superseded','expired')),
  CONSTRAINT pcr_state_revision_check
    CHECK (state_revision >= 0),
  CONSTRAINT pcr_resource_type_check
    CHECK (resource_type IN ('fleet','organization','repository')),
  CONSTRAINT pcr_resource_id_check
    CHECK (length(btrim(resource_id)) > 0),
  CONSTRAINT pcr_fleet_sentinel_check
    CHECK ((resource_type = 'fleet' AND resource_id = 'fleet')
        OR (resource_type <> 'fleet' AND resource_id <> 'fleet'))
);

CREATE INDEX idx_pcr_resource ON policy_change_requests (resource_type, resource_id, policy_family);
CREATE INDEX idx_pcr_state ON policy_change_requests (state);
CREATE INDEX idx_pcr_author ON policy_change_requests (author_principal_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 2: policy_versions (APPEND-ONLY)
-- Immutable policy payloads and content hashes.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_versions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id     uuid        NOT NULL REFERENCES policy_change_requests(id),
  payload               jsonb       NOT NULL,
  content_hash          text        NOT NULL,
  author_principal_id   uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  frozen_at             timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pv_content_hash_format
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pv_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT pv_request_version_unique
    UNIQUE (change_request_id, id),
  CONSTRAINT pv_content_unique
    UNIQUE (id, content_hash)
);

CREATE INDEX idx_pv_request ON policy_versions (change_request_id);
CREATE INDEX idx_pv_content_hash ON policy_versions (content_hash);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 3: policy_validation_evidence (APPEND-ONLY)
-- Trusted schema and semantic validation results.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_validation_evidence (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id            uuid        NOT NULL REFERENCES policy_versions(id),
  evidence_hash        text        NOT NULL,
  result                jsonb       NOT NULL,
  validator_version     text        NOT NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pve_hash_format
    CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pve_result_is_object
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT pve_version_evidence_unique
    UNIQUE (version_id, evidence_hash)
);

CREATE INDEX idx_pve_version ON policy_validation_evidence (version_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 4: policy_simulation_evidence (APPEND-ONLY)
-- Trusted impact simulation results.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_simulation_evidence (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id            uuid        NOT NULL REFERENCES policy_versions(id),
  evidence_hash        text        NOT NULL,
  result                jsonb       NOT NULL,
  evaluator_version     text        NOT NULL,
  generated_at          timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pse_hash_format
    CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pse_result_is_object
    CHECK (jsonb_typeof(result) = 'object'),
  CONSTRAINT pse_version_evidence_unique
    UNIQUE (version_id, evidence_hash)
);

CREATE INDEX idx_pse_version ON policy_simulation_evidence (version_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 5: policy_approval_rules (APPEND-ONLY)
-- Versioned approval requirements. Immutable once created.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_approval_rules (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version             text        NOT NULL,
  rule_hash                text        NOT NULL,
  policy_family            text        NOT NULL,
  resource_scope_type      text        NOT NULL,
  resource_scope_id        text        NOT NULL,
  risk_classification      text        NOT NULL DEFAULT 'standard',
  required_count           integer     NOT NULL DEFAULT 1,
  required_roles           jsonb       NOT NULL DEFAULT '[]',
  min_assurance_level      text        NOT NULL DEFAULT 'level1',
  self_approval_prohibited boolean     NOT NULL DEFAULT true,
  step_up_required         boolean     NOT NULL DEFAULT false,
  created_by_principal_id  uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT par_hash_format
    CHECK (rule_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT par_required_roles_is_array
    CHECK (jsonb_typeof(required_roles) = 'array'),
  CONSTRAINT par_scope_type_check
    CHECK (resource_scope_type IN ('fleet','organization','repository')),
  CONSTRAINT par_scope_id_check
    CHECK (length(btrim(resource_scope_id)) > 0),
  CONSTRAINT par_fleet_sentinel_check
    CHECK ((resource_scope_type = 'fleet' AND resource_scope_id = 'fleet')
        OR (resource_scope_type <> 'fleet' AND resource_scope_id <> 'fleet')),
  CONSTRAINT par_rule_unique
    UNIQUE (id, rule_hash)
);

CREATE INDEX idx_par_scope ON policy_approval_rules (resource_scope_type, resource_scope_id, policy_family);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 6: policy_approvals (APPEND-ONLY — immutable core)
-- Principal-owned approvals bound to exact evidence tuple.
-- No status fields here — lifecycle is in policy_approval_lifecycle.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_approvals (
  id                          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id                  uuid    NOT NULL,
  content_hash                text    NOT NULL,
  validation_evidence_hash    text    NOT NULL,
  simulation_evidence_hash    text    NOT NULL,
  approval_rule_id            uuid    NOT NULL,
  approval_rule_hash          text    NOT NULL,
  risk_classification         text    NOT NULL,
  approver_principal_id       uuid    NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  resource_scope_type         text    NOT NULL,
  resource_scope_id           text    NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pa_content_hash_format
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pa_validation_hash_format
    CHECK (validation_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pa_simulation_hash_format
    CHECK (simulation_evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pa_rule_hash_format
    CHECK (approval_rule_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pa_scope_type_check
    CHECK (resource_scope_type IN ('fleet','organization','repository')),
  CONSTRAINT pa_scope_id_check
    CHECK (length(btrim(resource_scope_id)) > 0),
  CONSTRAINT pa_fleet_sentinel_check
    CHECK ((resource_scope_type = 'fleet' AND resource_scope_id = 'fleet')
        OR (resource_scope_type <> 'fleet' AND resource_scope_id <> 'fleet')),

  -- Composite FKs: approval must reference the exact version+content_hash,
  -- exact validation evidence, exact simulation evidence, and exact rule+hash.
  CONSTRAINT pa_version_content_fk
    FOREIGN KEY (version_id, content_hash)
    REFERENCES policy_versions(id, content_hash),
  CONSTRAINT pa_validation_fk
    FOREIGN KEY (version_id, validation_evidence_hash)
    REFERENCES policy_validation_evidence(version_id, evidence_hash),
  CONSTRAINT pa_simulation_fk
    FOREIGN KEY (version_id, simulation_evidence_hash)
    REFERENCES policy_simulation_evidence(version_id, evidence_hash),
  CONSTRAINT pa_rule_fk
    FOREIGN KEY (approval_rule_id, approval_rule_hash)
    REFERENCES policy_approval_rules(id, rule_hash)
);

CREATE INDEX idx_pa_version ON policy_approvals (version_id);
CREATE INDEX idx_pa_approver ON policy_approvals (approver_principal_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 7: policy_approval_lifecycle (APPEND-ONLY)
-- Immutable lifecycle events for approvals.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_approval_lifecycle (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id           uuid        NOT NULL REFERENCES policy_approvals(id),
  lifecycle_revision    bigint      NOT NULL,
  from_status           text,
  to_status             text        NOT NULL,
  actor_principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  reason_code           text        NOT NULL,
  promotion_record_id   bigint,
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pal_revision_check
    CHECK (lifecycle_revision >= 0),
  CONSTRAINT pal_to_status_check
    CHECK (to_status IN ('active','revoked','expired','invalidated','consumed')),
  CONSTRAINT pal_from_status_check
    CHECK (from_status IS NULL OR from_status IN ('active','revoked','expired','invalidated','consumed')),
  CONSTRAINT pal_revision_zero
    CHECK ((lifecycle_revision = 0 AND from_status IS NULL AND to_status = 'active')
        OR (lifecycle_revision > 0 AND from_status IS NOT NULL)),
  CONSTRAINT pal_distinct_transition
    CHECK (lifecycle_revision = 0 OR from_status IS DISTINCT FROM to_status),
  CONSTRAINT pal_reason_nonempty
    CHECK (length(btrim(reason_code)) > 0),
  CONSTRAINT pal_consumed_requires_promotion
    CHECK ((to_status = 'consumed' AND promotion_record_id IS NOT NULL)
        OR to_status <> 'consumed'),
  CONSTRAINT pal_approval_revision_unique
    UNIQUE (approval_id, lifecycle_revision)
);

CREATE INDEX idx_pal_approval ON policy_approval_lifecycle (approval_id, lifecycle_revision);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 8: policy_promotion_records (APPEND-ONLY)
-- Immutable successful and failed promotion attempts.
-- binding_id is nullable (null on failed promotion before binding exists).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_promotion_records (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id               uuid,
  resource_type            text        NOT NULL,
  resource_id              text        NOT NULL,
  policy_family            text        NOT NULL,
  change_request_id        uuid        NOT NULL REFERENCES policy_change_requests(id),
  target_version_id        uuid        NOT NULL REFERENCES policy_versions(id),
  base_version_id          uuid,
  base_revision            bigint      NOT NULL DEFAULT 0,
  promoter_principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  outcome                  text        NOT NULL,
  failure_code             text,
  evidence_snapshot        jsonb       NOT NULL,
  occurred_at              timestamptz NOT NULL DEFAULT now(),
  created_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ppr_outcome_check
    CHECK (outcome IN ('succeeded','failed')),
  CONSTRAINT ppr_outcome_binding_check
    CHECK ((outcome = 'succeeded' AND binding_id IS NOT NULL AND failure_code IS NULL)
        OR (outcome = 'failed' AND failure_code IS NOT NULL)),
  CONSTRAINT ppr_base_revision_check
    CHECK (base_revision >= 0),
  CONSTRAINT ppr_evidence_is_object
    CHECK (jsonb_typeof(evidence_snapshot) = 'object'),
  CONSTRAINT ppr_resource_type_check
    CHECK (resource_type IN ('fleet','organization','repository')),
  CONSTRAINT ppr_resource_id_check
    CHECK (length(btrim(resource_id)) > 0),
  CONSTRAINT ppr_fleet_sentinel_check
    CHECK ((resource_type = 'fleet' AND resource_id = 'fleet')
        OR (resource_type <> 'fleet' AND resource_id <> 'fleet'))
);

CREATE INDEX idx_ppr_binding ON policy_promotion_records (binding_id);
CREATE INDEX idx_ppr_resource ON policy_promotion_records (resource_type, resource_id, policy_family);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 9: active_policy_bindings
-- Current active version for fleet, organization, or repository.
-- Single-writer: gitwire_app has SELECT only; promotion via GP-05 function.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE active_policy_bindings (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type            text        NOT NULL,
  resource_id              text        NOT NULL,
  policy_family            text        NOT NULL,
  active_policy_version_id uuid        NOT NULL REFERENCES policy_versions(id),
  binding_revision         bigint      NOT NULL DEFAULT 0,
  promotion_record_id      uuid        NOT NULL REFERENCES policy_promotion_records(id),
  activated_at             timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT apb_binding_revision_check
    CHECK (binding_revision >= 0),
  CONSTRAINT apb_resource_type_check
    CHECK (resource_type IN ('fleet','organization','repository')),
  CONSTRAINT apb_resource_id_check
    CHECK (length(btrim(resource_id)) > 0),
  CONSTRAINT apb_fleet_sentinel_check
    CHECK ((resource_type = 'fleet' AND resource_id = 'fleet')
        OR (resource_type <> 'fleet' AND resource_id <> 'fleet')),
  CONSTRAINT apb_resource_unique
    UNIQUE (resource_type, resource_id, policy_family)
);

CREATE UNIQUE INDEX idx_apb_resource ON active_policy_bindings (resource_type, resource_id, policy_family);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 10: policy_rollback_records
-- Governed rollback requests with stale-state protection.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_rollback_records (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id                uuid        NOT NULL REFERENCES active_policy_bindings(id),
  expected_binding_revision bigint     NOT NULL,
  base_version_id           uuid        NOT NULL,
  target_version_id         uuid        NOT NULL REFERENCES policy_versions(id),
  requester_principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  status                    text        NOT NULL DEFAULT 'requested',
  status_revision           bigint      NOT NULL DEFAULT 0,
  promotion_record_id       uuid,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT prr_status_check
    CHECK (status IN ('requested','approved','promoting','promoted','rejected','failed','withdrawn')),
  CONSTRAINT prr_status_revision_check
    CHECK (status_revision >= 0),
  CONSTRAINT prr_expected_revision_check
    CHECK (expected_binding_revision >= 0),
  CONSTRAINT prr_base_ne_target
    CHECK (base_version_id <> target_version_id)
);

CREATE INDEX idx_prr_binding ON policy_rollback_records (binding_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 11: policy_transition_events (APPEND-ONLY)
-- Append-only workflow-state evidence.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_transition_events (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id     uuid        NOT NULL REFERENCES policy_change_requests(id),
  event_type            text        NOT NULL,
  from_state            text,
  to_state              text        NOT NULL,
  actor_principal_id    uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  detail                jsonb       NOT NULL DEFAULT '{}',
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT pte_detail_is_object
    CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX idx_pte_request ON policy_transition_events (change_request_id);

-- ════════════════════════════════════════════════════════════════════════════
-- Table 12: policy_idempotency_keys
-- Scoped duplicate request protection.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE policy_idempotency_keys (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace                 text        NOT NULL,
  initiating_principal_id   uuid        NOT NULL REFERENCES gitwire_auth.auth_principals(id),
  resource_type             text        NOT NULL,
  resource_id               text        NOT NULL,
  idempotency_key           text        NOT NULL,
  operation                 text        NOT NULL,
  request_hash              text        NOT NULL,
  change_request_id         uuid        REFERENCES policy_change_requests(id),
  created_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                timestamptz,

  CONSTRAINT pik_request_hash_format
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT pik_resource_type_check
    CHECK (resource_type IN ('fleet','organization','repository')),
  CONSTRAINT pik_resource_id_check
    CHECK (length(btrim(resource_id)) > 0),
  CONSTRAINT pik_fleet_sentinel_check
    CHECK ((resource_type = 'fleet' AND resource_id = 'fleet')
        OR (resource_type <> 'fleet' AND resource_id <> 'fleet')),
  CONSTRAINT pik_scope_unique
    UNIQUE (namespace, initiating_principal_id, resource_type, resource_id, idempotency_key)
);

CREATE INDEX idx_pik_scope ON policy_idempotency_keys (namespace, initiating_principal_id, resource_type, resource_id);

-- ════════════════════════════════════════════════════════════════════════════
-- CYCLIC FOREIGN KEYS (added after both tables exist)
-- ════════════════════════════════════════════════════════════════════════════

-- Change request selected version must belong to this request
ALTER TABLE policy_change_requests
  ADD CONSTRAINT pcr_selected_version_fk
  FOREIGN KEY (id, selected_version_id)
  REFERENCES policy_versions(change_request_id, id)
  DEFERRABLE INITIALLY DEFERRED;

-- Promotion record binding reference (nullable for failed promotions)
ALTER TABLE policy_promotion_records
  ADD CONSTRAINT ppr_binding_fk
  FOREIGN KEY (binding_id)
  REFERENCES active_policy_bindings(id)
  DEFERRABLE INITIALLY DEFERRED;

-- ════════════════════════════════════════════════════════════════════════════
-- APPEND-ONLY TRIGGER FUNCTIONS (SECURITY INVOKER)
-- Single generic function used by all 8 immutable tables.
-- ════════════════════════════════════════════════════════════════════════════

CREATE FUNCTION enforce_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Append-only table % does not allow % operations',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION enforce_append_only() FROM PUBLIC;

-- Append-only triggers: 8 tables × 2 triggers (no_update + no_delete)
-- Tables: policy_versions, policy_validation_evidence, policy_simulation_evidence,
--         policy_approval_rules, policy_approvals, policy_approval_lifecycle,
--         policy_promotion_records, policy_transition_events

CREATE TRIGGER policy_versions_no_update
  BEFORE UPDATE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_versions_no_delete
  BEFORE DELETE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_validation_evidence_no_update
  BEFORE UPDATE ON policy_validation_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_validation_evidence_no_delete
  BEFORE DELETE ON policy_validation_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_simulation_evidence_no_update
  BEFORE UPDATE ON policy_simulation_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_simulation_evidence_no_delete
  BEFORE DELETE ON policy_simulation_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_approval_rules_no_update
  BEFORE UPDATE ON policy_approval_rules
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_approval_rules_no_delete
  BEFORE DELETE ON policy_approval_rules
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_approvals_no_update
  BEFORE UPDATE ON policy_approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_approvals_no_delete
  BEFORE DELETE ON policy_approvals
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_approval_lifecycle_no_update
  BEFORE UPDATE ON policy_approval_lifecycle
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_approval_lifecycle_no_delete
  BEFORE DELETE ON policy_approval_lifecycle
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_promotion_records_no_update
  BEFORE UPDATE ON policy_promotion_records
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_promotion_records_no_delete
  BEFORE DELETE ON policy_promotion_records
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

CREATE TRIGGER policy_transition_events_no_update
  BEFORE UPDATE ON policy_transition_events
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();
CREATE TRIGGER policy_transition_events_no_delete
  BEFORE DELETE ON policy_transition_events
  FOR EACH ROW EXECUTE FUNCTION enforce_append_only();

RESET search_path;
