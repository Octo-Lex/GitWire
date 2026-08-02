-- Exact rollback for GP-03 migration 046.
-- Drops only what 046 added. Preserves all GP-01/GP-02 grants and functions.
-- No CASCADE.
--
-- PARTIAL-STATE SAFE: if 046 applied only partially (e.g. a collision aborted
-- after the schema ALTERs but before all functions were created), the function
-- REVOKEs are guarded so they don't fail on non-existent functions. The DROP
-- FUNCTION IF EXISTS statements are inherently safe. This makes the rollback
-- usable both for full and partial 046 application.

SET search_path = gitwire_policy, pg_catalog;

-- Revoke EXECUTE from gitwire_app, guarding against non-existent functions
-- (partial 046 application may have created only some functions).
DO $$
DECLARE
  fn_oid oid;
BEGIN
  -- approve_policy_change_request(uuid, bigint, uuid)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='approve_policy_change_request'
    AND pg_get_function_identity_arguments(p.oid)='uuid, bigint, uuid';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.approve_policy_change_request(uuid, bigint, uuid) FROM gitwire_app';
  END IF;
  -- evaluate_approval_sufficiency(uuid)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='evaluate_approval_sufficiency'
    AND pg_get_function_identity_arguments(p.oid)='uuid';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.evaluate_approval_sufficiency(uuid) FROM gitwire_app';
  END IF;
  -- expire_policy_approval(uuid, bigint, uuid)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='expire_policy_approval'
    AND pg_get_function_identity_arguments(p.oid)='uuid, bigint, uuid';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.expire_policy_approval(uuid, bigint, uuid) FROM gitwire_app';
  END IF;
  -- revoke_policy_approval(uuid, bigint, uuid, text)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='revoke_policy_approval'
    AND pg_get_function_identity_arguments(p.oid)='uuid, bigint, uuid, text';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.revoke_policy_approval(uuid, bigint, uuid, text) FROM gitwire_app';
  END IF;
  -- record_policy_approval(uuid, uuid, uuid)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='record_policy_approval'
    AND pg_get_function_identity_arguments(p.oid)='uuid, uuid, uuid';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.record_policy_approval(uuid, uuid, uuid) FROM gitwire_app';
  END IF;
  -- create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer)
  SELECT p.oid INTO fn_oid FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
    WHERE n.nspname='gitwire_policy' AND p.proname='create_policy_approval_rule'
    AND pg_get_function_identity_arguments(p.oid)='text, text, text, text, text, integer, jsonb, uuid, integer';
  IF fn_oid IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION gitwire_policy.create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) FROM gitwire_app';
  END IF;
END $$;

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

-- Revoke public.repositories + public.installations column grants (046 added both)
REVOKE SELECT (github_id, installation_id, full_name, owner, name) ON public.repositories FROM gitwire_policy_fn_owner;
REVOKE SELECT (github_id, account_login) ON public.installations FROM gitwire_policy_fn_owner;

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
