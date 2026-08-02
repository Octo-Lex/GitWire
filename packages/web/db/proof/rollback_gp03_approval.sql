-- Exact rollback for GP-03 migration 046.
-- Drops only what 046 created. Preserves all GP-01/GP-02 grants and functions.
-- No CASCADE.
--
-- PROVENANCE-AWARE AND FAIL-CLOSED: this rollback verifies that each GP-03
-- function it is about to drop has the exact provenance of a function created
-- by migration 046 (owner = gitwire_policy_fn_owner, SECURITY DEFINER, plpgsql,
-- search_path = 'gitwire_policy, pg_catalog'). If a same-signature function
-- exists but was NOT created by 046 (foreign provenance), the rollback ABORTS
-- without modification — it never drops a function it did not create.
--
-- PRECONDITION: requires a successfully recorded 046 ledger entry. If 046 was
-- never applied (or applied only partially via a non-transactional path), the
-- rollback aborts immediately.

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Precondition: 046 must be in the migration ledger
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ledger_count int;
BEGIN
  SELECT count(*) INTO v_ledger_count FROM public.schema_migrations WHERE version = '046_gp03_approval_functions.sql';
  IF v_ledger_count = 0 THEN
    RAISE EXCEPTION 'rollback_gp03_approval: precondition failed — 046 is not recorded in the migration ledger (never applied or partial)';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Provenance verification: each GP-03 function must have EXACT 046 provenance.
-- Reads gp03_function_provenance (recorded at migration time) and compares:
--   - prosrc hash (stable PL/pgSQL source, not pg_get_functiondef formatting)
--   - identity arguments, return type, language, owner, SECURITY DEFINER, proconfig
--   - canonical ACL (sorted grantor/grantee/privilege/grantability set)
-- Also requires exactly 6 unique provenance rows with no missing/extra signatures.
-- Aborts without modification on any mismatch.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_prov_count int;
  v_fn record;
  v_prosrc_hash text;
  v_acl text;
  v_prov record;
  v_provenance_ok boolean;
  v_expected_names text[] := ARRAY['approve_policy_change_request','create_policy_approval_rule','evaluate_approval_sufficiency','expire_policy_approval','record_policy_approval','revoke_policy_approval'];
BEGIN
  -- Require exactly 6 provenance rows
  SELECT count(*) INTO v_prov_count FROM gitwire_policy.gp03_function_provenance;
  IF v_prov_count != 6 THEN
    RAISE EXCEPTION 'rollback_gp03_approval: expected 6 provenance rows, found %', v_prov_count;
  END IF;
  -- Require no extra/missing signatures
  IF EXISTS (SELECT 1 FROM gitwire_policy.gp03_function_provenance WHERE NOT (proname = ANY(v_expected_names))) THEN
    RAISE EXCEPTION 'rollback_gp03_approval: unexpected provenance row detected';
  END IF;

  FOR v_fn IN
    SELECT p.proname, p.oid, pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS ret_type, p.proacl,
           pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef, l.lanname,
           COALESCE(array_to_string(p.proconfig,','),'') AS config
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname = 'gitwire_policy'
      AND p.proname IN ('create_policy_approval_rule','record_policy_approval','revoke_policy_approval',
                        'expire_policy_approval','evaluate_approval_sufficiency','approve_policy_change_request')
  LOOP
    -- Read expected provenance
    SELECT prosrc_hash, identity_args, ret_type, lang_name, owner_name, prosecdef, proconfig, acl_canonical
      INTO v_prov FROM gitwire_policy.gp03_function_provenance WHERE proname = v_fn.proname;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollback_gp03_approval: no provenance record for %', v_fn.proname;
    END IF;

    -- Compute current values
    v_prosrc_hash := encode(public.digest((SELECT prosrc FROM pg_proc WHERE oid = v_fn.oid), 'sha256'), 'hex');
    -- For ACL: use a separate SELECT ... INTO approach that avoids subquery-in-FROM issues
    BEGIN
      SELECT COALESCE(string_agg(
                 g1.rolname || '=' || a.privilege_type || '/' || g2.rolname || '(' ||
                 CASE WHEN a.is_grantable THEN 't' ELSE 'f' END || ')',
                 ',' ORDER BY g1.rolname, a.privilege_type, g2.rolname), 'NULL')
        INTO v_acl
        FROM aclexplode(v_fn.proacl) AS a
        JOIN pg_roles g1 ON g1.oid = a.grantee
        JOIN pg_roles g2 ON g2.oid = a.grantor;
    EXCEPTION WHEN OTHERS THEN
      v_acl := 'NULL';
    END;

    -- Full provenance comparison: prosrc hash + all attributes + canonical ACL
    v_provenance_ok := (v_prosrc_hash = v_prov.prosrc_hash
                        AND v_fn.args = v_prov.identity_args
                        AND v_fn.ret_type = v_prov.ret_type
                        AND v_fn.lanname = v_prov.lang_name
                        AND v_fn.owner_name = v_prov.owner_name
                        AND v_fn.prosecdef = v_prov.prosecdef
                        AND v_fn.config = v_prov.proconfig
                        AND v_acl = v_prov.acl_canonical);

    IF NOT v_provenance_ok THEN
      RAISE EXCEPTION 'rollback_gp03_approval: function % (%) provenance mismatch (prosrc_hash=% vs %, acl=% vs %). Aborting.',
        v_fn.proname, v_fn.args, v_prosrc_hash, v_prov.prosrc_hash, v_acl, v_prov.acl_canonical;
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Revoke EXECUTE from gitwire_app (all functions verified as 046-provenance above)
-- ════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION approve_policy_change_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION evaluate_approval_sufficiency(uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION expire_policy_approval(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION record_policy_approval(uuid, uuid, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) FROM gitwire_app;

-- Drop SECURITY DEFINER functions (all verified as 046-provenance above)
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

-- Drop provenance metadata table
DROP TABLE IF EXISTS gp03_function_provenance;

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '046_gp03_approval_functions.sql';
