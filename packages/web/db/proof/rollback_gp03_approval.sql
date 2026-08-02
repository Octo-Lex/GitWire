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
-- Checks: owner, SECURITY DEFINER, plpgsql, search_path, BODY HASH (from
-- gp03_function_provenance recorded at migration time), and exact ACL.
-- Abort if any function has non-046 provenance (foreign function, modified body,
-- or altered privileges).
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_fn record;
  v_body_hash text;
  v_acl_text text;
  v_expected_hash text;
  v_expected_acl text;
  v_provenance_ok boolean;
BEGIN
  FOR v_fn IN
    SELECT p.proname, p.oid, pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_userbyid(p.proowner) AS owner, p.prosecdef, l.lanname,
           COALESCE(array_to_string(p.proconfig,','),'') AS config
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname = 'gitwire_policy'
      AND p.proname IN ('create_policy_approval_rule','record_policy_approval','revoke_policy_approval',
                        'expire_policy_approval','evaluate_approval_sufficiency','approve_policy_change_request')
  LOOP
    -- Read the expected hash+ACL from the provenance table (recorded at migration time)
    SELECT fp.body_hash, fp.acl_text INTO v_expected_hash, v_expected_acl
    FROM gitwire_policy.gp03_function_provenance fp WHERE fp.proname = v_fn.proname;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollback_gp03_approval: no provenance record for function % — migration may be corrupt. Aborting.', v_fn.proname;
    END IF;

    -- Compute current body hash and ACL
    v_body_hash := encode(public.digest(pg_get_functiondef(v_fn.oid), 'sha256'), 'hex');
    BEGIN
      v_acl_text := COALESCE((SELECT string_agg(g1.rolname || '=' || a.privilege_type || '/' || g2.rolname, ',' ORDER BY g1.rolname)
                              FROM aclexplode(coalesce((SELECT proacl FROM pg_proc WHERE oid = v_fn.oid), '{}'::aclitem[])) a
                              JOIN pg_roles g1 ON g1.oid = a.grantee
                              JOIN pg_roles g2 ON g2.oid = a.grantor),
                             'NULL');
    EXCEPTION WHEN OTHERS THEN
      v_acl_text := 'ERROR';
    END;

    -- Full provenance check: structural + body hash + ACL
    v_provenance_ok := (v_fn.owner = 'gitwire_policy_fn_owner'
                        AND v_fn.prosecdef = true
                        AND v_fn.lanname = 'plpgsql'
                        AND v_fn.config = 'search_path=gitwire_policy, pg_catalog'
                        AND v_body_hash = v_expected_hash
                        AND v_acl_text = v_expected_acl);

    IF NOT v_provenance_ok THEN
      RAISE EXCEPTION 'rollback_gp03_approval: function % (%) has non-046 provenance (owner=%, prosecdef=%, lang=%, config=%, body_hash=%, acl=%). Aborting to preserve function.',
        v_fn.proname, v_fn.args, v_fn.owner, v_fn.prosecdef, v_fn.lanname, v_fn.config, v_body_hash, v_acl_text;
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
