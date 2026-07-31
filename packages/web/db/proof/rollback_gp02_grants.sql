-- Exact rollback for GP-02 migration 045.
-- Revokes the INSERT and UPDATE grants added by 045.
-- Run only against a disposable database owned by the proof harness.

SET search_path = gitwire_policy, pg_catalog;

REVOKE INSERT ON policy_change_requests FROM gitwire_app;
REVOKE UPDATE (state, state_revision, selected_version_id, submitted_at, updated_at)
  ON policy_change_requests FROM gitwire_app;
REVOKE INSERT ON policy_versions FROM gitwire_app;
REVOKE INSERT ON policy_transition_events FROM gitwire_app;

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '045_gp02_column_grants.sql';
