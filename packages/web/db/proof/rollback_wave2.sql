-- rollback_wave2.sql
-- Exact rollback for Wave 2 migration 041 (runtime identity).
--
-- Run only against a disposable database owned by the proof harness.
-- Removes Wave 2 objects in dependency order. Uses NO CASCADE.
-- IF EXISTS for re-runnability (the apply uses plain CREATE for new objects).

SET search_path = gitwire_auth, pg_catalog;

-- ── 1. Drop Wave 2 triggers (before their functions) ───────────────────────
DROP TRIGGER IF EXISTS trg_decision_log_no_delete ON gitwire_auth.auth_decision_log;
DROP TRIGGER IF EXISTS trg_decision_log_no_update ON gitwire_auth.auth_decision_log;

-- ── 2. Drop Wave 2 trigger function ────────────────────────────────────────
DROP FUNCTION IF EXISTS gitwire_auth.enforce_decision_log_append_only();

-- ── 3. Drop Wave 2 tables (legacy_key_mappings before auth_decision_log) ───
DROP TABLE IF EXISTS gitwire_auth.legacy_key_mappings;
DROP TABLE IF EXISTS gitwire_auth.auth_decision_log;

-- ── 4. Remove dual-write columns (public schema, schema-qualified) ──────────
DROP INDEX IF EXISTS public.ix_decision_log_principal;
ALTER TABLE public.decision_log DROP COLUMN IF EXISTS principal_id;
ALTER TABLE public.repair_proposals DROP COLUMN IF EXISTS principal_id;
ALTER TABLE public.repair_proposal_events DROP COLUMN IF EXISTS principal_id;
ALTER TABLE public.managed_actions DROP COLUMN IF EXISTS principal_id;

-- ── 5. Remove migration ledger record for 041 ──────────────────────────────
-- schema_migrations lives in the public schema; schema-qualify explicitly
-- since this file's search_path is fixed to (gitwire_auth, pg_catalog).
DELETE FROM public.schema_migrations WHERE version = '041_wave2_runtime_identity.sql';

RESET search_path;
