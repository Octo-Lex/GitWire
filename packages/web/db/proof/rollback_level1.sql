-- rollback_level1.sql
-- Exact rollback for Level 1 authority migrations 038/039/040.
--
-- Run only against a disposable database owned by the proof harness.
-- Removes 040 seed state, drops 039 SECURITY DEFINER functions BEFORE their
-- owner role, revokes/drops exact grants and all five Level 1 roles, and
-- removes 038 triggers, functions, tables, and schema in dependency order.
-- Uses NO CASCADE anywhere. Every statement names the exact object.
--
-- Idempotency: each DROP uses IF EXISTS so re-running a partially-applied
-- rollback completes cleanly. IF EXISTS does not weaken the fail-closed
-- migration apply (038/039/040 still use plain CREATE); it only makes the
-- rollback proof re-runnable, which is required by the acceptance gate
-- ("clean reapply" after "complete rollback").

SET search_path = gitwire_auth, pg_catalog;

-- ── 1. Remove 040 seed state (exact rows / defensive cleanup) ──────────────
-- The canonical roles/permissions are removed when their tables are dropped
-- below. No admin principal/credential/assignment exists in 040 to remove
-- (zero-admin bootstrap model). We do not DELETE from auth_roles here because
-- the table is dropped wholesale in step 5.

-- ── 2. Drop 039 SECURITY DEFINER functions (before their owner role) ───────
-- Order among functions does not matter (no inter-function dependencies), but
-- all must be dropped before gitwire_auth_fn_owner is dropped.
DROP FUNCTION IF EXISTS gitwire_auth.admit_command(uuid, uuid);
DROP FUNCTION IF EXISTS gitwire_auth.transition_admission(uuid, text, text, bigint);
DROP FUNCTION IF EXISTS gitwire_auth.transition_execution(uuid, text, text, bigint);
DROP FUNCTION IF EXISTS gitwire_auth.transition_enforcement_state(text, text, text);
DROP FUNCTION IF EXISTS gitwire_auth.enable_bootstrap_from_marker(text, integer);
DROP FUNCTION IF EXISTS gitwire_auth.complete_bootstrap(text, text, text, integer, text, text, text, integer);

-- ── 3. Drop 038 triggers (before their trigger functions) ──────────────────
DROP TRIGGER IF EXISTS trg_receipts_no_delete ON gitwire_auth.execution_receipts;
DROP TRIGGER IF EXISTS trg_receipts_no_update ON gitwire_auth.execution_receipts;
DROP TRIGGER IF EXISTS trg_events_no_delete ON gitwire_auth.mutation_events;
DROP TRIGGER IF EXISTS trg_events_no_update ON gitwire_auth.mutation_events;
DROP TRIGGER IF EXISTS trg_event_source_partition ON gitwire_auth.mutation_events;
DROP TRIGGER IF EXISTS trg_command_immutability ON gitwire_auth.mutation_commands;
DROP TRIGGER IF EXISTS trg_legal_lifecycle_transition ON gitwire_auth.mutation_commands;

-- ── 4. Drop 038 SECURITY INVOKER trigger functions ─────────────────────────
DROP FUNCTION IF EXISTS gitwire_auth.enforce_receipts_append_only();
DROP FUNCTION IF EXISTS gitwire_auth.enforce_events_append_only();
DROP FUNCTION IF EXISTS gitwire_auth.enforce_event_source_partition();
DROP FUNCTION IF EXISTS gitwire_auth.enforce_command_immutability();
DROP FUNCTION IF EXISTS gitwire_auth.enforce_legal_lifecycle_transition();

-- ── 5. Drop 038 tables (child before parent for FK order) ──────────────────
-- auth_principal_roles refs auth_principals + auth_roles.
-- auth_credentials refs auth_principals.
-- mutation_events refs mutation_commands + auth_principals.
-- execution_receipts refs mutation_commands.
-- auth_sessions refs auth_principals.
-- mutation_commands refs auth_principals (x3).
DROP TABLE IF EXISTS gitwire_auth.auth_bootstrap_recovery_markers;
DROP TABLE IF EXISTS gitwire_auth.auth_bootstrap_state;
DROP TABLE IF EXISTS gitwire_auth.auth_enforcement_state;
DROP TABLE IF EXISTS gitwire_auth.auth_sessions;
DROP TABLE IF EXISTS gitwire_auth.execution_receipts;
DROP TABLE IF EXISTS gitwire_auth.mutation_events;
DROP TABLE IF EXISTS gitwire_auth.mutation_commands;
DROP TABLE IF EXISTS gitwire_auth.auth_principal_roles;
DROP TABLE IF EXISTS gitwire_auth.auth_role_permissions;
DROP TABLE IF EXISTS gitwire_auth.auth_roles;
DROP TABLE IF EXISTS gitwire_auth.auth_credentials;
DROP TABLE IF EXISTS gitwire_auth.auth_principals;

-- ── 6. Drop the schema ─────────────────────────────────────────────────────
DROP SCHEMA IF EXISTS gitwire_auth;

-- ── 7. Drop the five Level 1 roles ─────────────────────────────────────────
-- The schema and all its objects (including the SECURITY DEFINER functions
-- owned by gitwire_auth_fn_owner and all table grants) were dropped in
-- steps 2–6, so no privileges remain. These five roles were created by 039,
-- so dropping them here is exact. IF EXISTS makes the rollback re-runnable.
-- DROP ROLE fails if the role still owns objects or has privileges — which is
-- the desired fail-closed behavior if an object was missed above.
DROP ROLE IF EXISTS gitwire_app;
DROP ROLE IF EXISTS gitwire_admission;
DROP ROLE IF EXISTS gitwire_executor;
DROP ROLE IF EXISTS gitwire_operator;
DROP ROLE IF EXISTS gitwire_auth_fn_owner;

RESET search_path;
