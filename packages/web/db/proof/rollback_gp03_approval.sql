-- Exact rollback for GP-03 migration 046.
-- Drops only what 046 added. Preserves all GP-01/GP-02 grants and functions.
-- No CASCADE.

SET search_path = gitwire_policy, pg_catalog;

-- Revoke EXECUTE from gitwire_app
REVOKE EXECUTE ON FUNCTION approve_policy_change_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION evaluate_approval_sufficiency(uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION expire_policy_approval(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION record_policy_approval(uuid, uuid, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) FROM gitwire_app;

-- Drop SECURITY DEFINER functions
DROP FUNCTION IF EXISTS approve_policy_change_request(uuid, bigint, uuid);
DROP FUNCTION IF EXISTS evaluate_approval_sufficiency(uuid);
DROP FUNCTION IF EXISTS expire_policy_approval(uuid, bigint, uuid);
DROP FUNCTION IF EXISTS revoke_policy_approval(uuid, bigint, uuid, text);
DROP FUNCTION IF EXISTS record_policy_approval(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer);

-- Revoke GP-03 table grants from fn_owner
REVOKE SELECT, INSERT ON policy_approval_rules FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_approvals FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_approval_lifecycle FROM gitwire_policy_fn_owner;
REVOKE SELECT ON policy_validation_evidence FROM gitwire_policy_fn_owner;
REVOKE SELECT ON policy_simulation_evidence FROM gitwire_policy_fn_owner;

-- Revoke SELECT on transition_events added by 046 (INSERT was from 045, leave that)
REVOKE SELECT ON policy_transition_events FROM gitwire_policy_fn_owner;

-- Revoke cross-schema grants
REVOKE SELECT ON gitwire_auth.auth_principal_roles FROM gitwire_policy_fn_owner;
REVOKE SELECT ON gitwire_auth.auth_roles FROM gitwire_policy_fn_owner;
REVOKE SELECT ON gitwire_auth.auth_principals FROM gitwire_policy_fn_owner;
REVOKE USAGE ON SCHEMA gitwire_auth FROM gitwire_policy_fn_owner;

-- Revoke public.repositories column grant
REVOKE SELECT (github_id, installation_id, full_name, owner, name) ON public.repositories FROM gitwire_policy_fn_owner;

-- Drop constraints added by 046
ALTER TABLE policy_approvals DROP CONSTRAINT IF EXISTS pa_expires_check;
ALTER TABLE policy_approvals DROP CONSTRAINT IF EXISTS pa_risk_enum_check;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_scope_revision_unique;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_ttl_positive;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_rule_revision_check;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_required_count_min;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_risk_enum_check;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_assurance_check;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_step_up_check;
ALTER TABLE policy_approval_rules DROP CONSTRAINT IF EXISTS par_self_approval_check;

-- Drop columns added by 046
ALTER TABLE policy_approvals DROP COLUMN IF EXISTS expires_at;
ALTER TABLE policy_approval_rules DROP COLUMN IF EXISTS approval_ttl_seconds;
ALTER TABLE policy_approval_rules DROP COLUMN IF EXISTS rule_revision;

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '046_gp03_approval_functions.sql';
