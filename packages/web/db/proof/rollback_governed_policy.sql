-- Exact rollback for governed policy migrations 043 and 044 (GP-01).
-- Run only against a disposable database owned by the proof harness.
--
-- Uses NO CASCADE. Drops objects in dependency order:
--   1. Named cyclic FK constraints
--   2. Table grants
--   3. Schema usage grants
--   4. Triggers (8 tables × 2)
--   5. Trigger function
--   6. Tables (reverse creation order)
--   7. Schema
--   8. Role
--   9. Migration ledger entries

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Drop named cyclic FK constraints (must precede table drops)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE policy_change_requests
  DROP CONSTRAINT IF EXISTS pcr_selected_version_fk;

ALTER TABLE policy_promotion_records
  DROP CONSTRAINT IF EXISTS ppr_binding_fk;

ALTER TABLE policy_approval_lifecycle
  DROP CONSTRAINT IF EXISTS pal_promotion_record_fk;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. Revoke table grants
-- ════════════════════════════════════════════════════════════════════════════

REVOKE SELECT ON ALL TABLES IN SCHEMA gitwire_policy
  FROM gitwire_app, gitwire_operator;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. Revoke schema usage
-- ════════════════════════════════════════════════════════════════════════════

REVOKE USAGE ON SCHEMA gitwire_policy
  FROM gitwire_app, gitwire_operator, gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. Drop triggers (8 tables × 2 triggers each = 16)
-- ════════════════════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS policy_transition_events_no_delete ON policy_transition_events;
DROP TRIGGER IF EXISTS policy_transition_events_no_update ON policy_transition_events;

DROP TRIGGER IF EXISTS policy_promotion_records_no_delete ON policy_promotion_records;
DROP TRIGGER IF EXISTS policy_promotion_records_no_update ON policy_promotion_records;

DROP TRIGGER IF EXISTS policy_approval_lifecycle_no_delete ON policy_approval_lifecycle;
DROP TRIGGER IF EXISTS policy_approval_lifecycle_no_update ON policy_approval_lifecycle;

DROP TRIGGER IF EXISTS policy_approvals_no_delete ON policy_approvals;
DROP TRIGGER IF EXISTS policy_approvals_no_update ON policy_approvals;

DROP TRIGGER IF EXISTS policy_approval_rules_no_delete ON policy_approval_rules;
DROP TRIGGER IF EXISTS policy_approval_rules_no_update ON policy_approval_rules;

DROP TRIGGER IF EXISTS policy_simulation_evidence_no_delete ON policy_simulation_evidence;
DROP TRIGGER IF EXISTS policy_simulation_evidence_no_update ON policy_simulation_evidence;

DROP TRIGGER IF EXISTS policy_validation_evidence_no_delete ON policy_validation_evidence;
DROP TRIGGER IF EXISTS policy_validation_evidence_no_update ON policy_validation_evidence;

DROP TRIGGER IF EXISTS policy_versions_no_delete ON policy_versions;
DROP TRIGGER IF EXISTS policy_versions_no_update ON policy_versions;

-- ════════════════════════════════════════════════════════════════════════════
-- 5. Drop trigger function
-- ════════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS enforce_append_only();

-- ════════════════════════════════════════════════════════════════════════════
-- 6. Drop tables (reverse creation order)
-- ════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS policy_idempotency_keys;
DROP TABLE IF EXISTS policy_transition_events;
DROP TABLE IF EXISTS policy_rollback_records;
DROP TABLE IF EXISTS active_policy_bindings;
DROP TABLE IF EXISTS policy_promotion_records;
DROP TABLE IF EXISTS policy_approval_lifecycle;
DROP TABLE IF EXISTS policy_approvals;
DROP TABLE IF EXISTS policy_approval_rules;
DROP TABLE IF EXISTS policy_simulation_evidence;
DROP TABLE IF EXISTS policy_validation_evidence;
DROP TABLE IF EXISTS policy_versions;
DROP TABLE IF EXISTS policy_change_requests;

-- ════════════════════════════════════════════════════════════════════════════
-- 7. Drop schema
-- ════════════════════════════════════════════════════════════════════════════

DROP SCHEMA IF EXISTS gitwire_policy;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. Drop role (after all grants revoked)
-- ════════════════════════════════════════════════════════════════════════════

DROP ROLE IF EXISTS gitwire_policy_fn_owner;

-- ════════════════════════════════════════════════════════════════════════════
-- 9. Remove migration ledger entries
-- ════════════════════════════════════════════════════════════════════════════

RESET search_path;

DELETE FROM public.schema_migrations
WHERE version IN (
  '043_governed_policy_schema.sql',
  '044_governed_policy_roles.sql'
);
