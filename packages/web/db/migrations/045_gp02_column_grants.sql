-- Migration 045: GP-02 column-restricted INSERT and UPDATE grants
-- Governed Policy Authority (issue #98, GP-02).
--
-- Grants column-restricted INSERT and UPDATE to gitwire_app for the three
-- tables GP-02 owns: policy_change_requests, policy_versions, and
-- policy_transition_events.
--
-- UPDATE is granted only on lifecycle-control columns of
-- policy_change_requests (state, state_revision, selected_version_id,
-- submitted_at, updated_at). Immutable fields (resource_type, resource_id,
-- policy_family, author_principal_id) cannot be modified by the runtime role.
--
-- policy_versions and policy_transition_events are append-only — INSERT only,
-- no UPDATE or DELETE (enforced by triggers from GP-01).
--
-- Follows the 039 column-restricted grant pattern.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- policy_change_requests: INSERT (all columns for creation) +
-- UPDATE (lifecycle columns only for state transitions)
-- ════════════════════════════════════════════════════════════════════════════

GRANT INSERT ON policy_change_requests TO gitwire_app;

-- UPDATE only on lifecycle-control columns (CAS state transitions)
GRANT UPDATE (state, state_revision, selected_version_id, submitted_at, updated_at)
  ON policy_change_requests TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- policy_versions: INSERT only (append-only trigger blocks UPDATE/DELETE)
-- ════════════════════════════════════════════════════════════════════════════

GRANT INSERT ON policy_versions TO gitwire_app;

-- ════════════════════════════════════════════════════════════════════════════
-- policy_transition_events: INSERT only (append-only trigger blocks UPDATE/DELETE)
-- ════════════════════════════════════════════════════════════════════════════

GRANT INSERT ON policy_transition_events TO gitwire_app;

RESET search_path;
