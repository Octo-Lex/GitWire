-- Exact rollback for GP-02 migration 045.
-- Drops SECURITY DEFINER functions, helper, revokes grants from gitwire_app,
-- revokes table privileges from gitwire_policy_fn_owner.
-- Run only against a disposable database owned by the proof harness.
-- No CASCADE.

SET search_path = gitwire_policy, pg_catalog;

-- Revoke EXECUTE from gitwire_app
REVOKE EXECUTE ON FUNCTION submit_policy_change_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION select_policy_version(uuid, uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_version(uuid, jsonb, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_change_request(text, text, text, uuid) FROM gitwire_app;

-- Drop SECURITY DEFINER functions
DROP FUNCTION IF EXISTS submit_policy_change_request(uuid, bigint, uuid);
DROP FUNCTION IF EXISTS select_policy_version(uuid, uuid, bigint, uuid);
DROP FUNCTION IF EXISTS create_policy_version(uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS create_policy_change_request(text, text, text, uuid);

-- Drop helper function
DROP FUNCTION IF EXISTS canonical_jsonb(jsonb);

-- Revoke table privileges from gitwire_policy_fn_owner
REVOKE SELECT, INSERT ON policy_change_requests FROM gitwire_policy_fn_owner;
REVOKE UPDATE (state, state_revision, selected_version_id, submitted_at, updated_at)
  ON policy_change_requests FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_versions FROM gitwire_policy_fn_owner;
REVOKE INSERT ON policy_transition_events FROM gitwire_policy_fn_owner;

RESET search_path;

DELETE FROM public.schema_migrations
WHERE version = '045_gp02_security_definer_functions.sql';
