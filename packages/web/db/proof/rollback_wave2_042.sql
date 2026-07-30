-- rollback_wave2_042.sql
-- Exact rollback for Wave 2 migration 042 (attribution gap evidence).
SET search_path = gitwire_auth, pg_catalog;

-- Revoke grants before dropping
REVOKE INSERT ON gitwire_auth.attribution_gap_evidence FROM gitwire_app;
REVOKE SELECT ON gitwire_auth.attribution_gap_evidence FROM gitwire_operator;

DROP TRIGGER IF EXISTS trg_attribution_gap_no_delete ON gitwire_auth.attribution_gap_evidence;
DROP TRIGGER IF EXISTS trg_attribution_gap_no_update ON gitwire_auth.attribution_gap_evidence;
DROP FUNCTION IF EXISTS gitwire_auth.enforce_attribution_gap_append_only();
DROP TABLE IF EXISTS gitwire_auth.attribution_gap_evidence;
DELETE FROM public.schema_migrations WHERE version = '042_attribution_gap_evidence.sql';

RESET search_path;
