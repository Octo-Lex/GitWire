-- Exact rollback for GP-04 migration 047.
-- Provenance-aware, fail-closed, transactional.
-- Refuses when authoritative GP-04 evidence or transition events exist.

BEGIN;

SET search_path = gitwire_policy, pg_catalog;

-- Precondition: 047 must be in the migration ledger
DO $$
DECLARE
  v_ledger_count int;
BEGIN
  SELECT count(*) INTO v_ledger_count FROM public.schema_migrations WHERE version = '047_gp04_validation_simulation.sql';
  IF v_ledger_count = 0 THEN
    RAISE EXCEPTION 'rollback_gp04: precondition failed — 047 is not recorded in the migration ledger';
  END IF;
END $$;

-- Refuse if authoritative GP-04 data exists (evidence or transition events)
DO $$
DECLARE
  v_evidence_count int;
  v_event_count int;
BEGIN
  SELECT count(*) INTO v_evidence_count FROM policy_validation_evidence WHERE validator_version IS NOT NULL;
  -- Check for GP-04 transition events
  SELECT count(*) INTO v_event_count FROM policy_transition_events
    WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected');
  IF v_evidence_count > 0 OR v_event_count > 0 THEN
    RAISE EXCEPTION 'rollback_gp04: cannot roll back — authoritative GP-04 evidence (%) or transition events (%) exist. Rollback refused to protect immutable data.', v_evidence_count, v_event_count;
  END IF;
END $$;

-- Provenance verification
DO $$
DECLARE
  v_prov_count int;
  v_fn record;
  v_prosrc_hash text;
  v_acl text;
  v_prov record;
  v_provenance_ok boolean;
BEGIN
  SELECT count(*) INTO v_prov_count FROM gitwire_policy.gp04_function_provenance;
  IF v_prov_count != 1 THEN
    RAISE EXCEPTION 'rollback_gp04: expected 1 provenance row, found %', v_prov_count;
  END IF;

  SELECT p.proname, p.oid, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS ret_type, p.proacl,
         pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef, l.lanname,
         COALESCE(array_to_string(p.proconfig,','),'') AS config
    INTO v_fn
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname = 'gitwire_policy'
      AND p.proname = 'finalize_policy_evaluation';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_gp04: finalize_policy_evaluation function not found';
  END IF;

  SELECT * INTO v_prov FROM gitwire_policy.gp04_function_provenance WHERE proname = v_fn.proname AND identity_args = v_fn.args;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_gp04: no provenance record for % (%)', v_fn.proname, v_fn.args;
  END IF;

  v_prosrc_hash := encode(public.digest((SELECT prosrc FROM pg_proc WHERE oid = v_fn.oid), 'sha256'), 'hex');
  BEGIN
    SELECT COALESCE(string_agg(
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g1.rolname END
             || '=' || a.privilege_type || '/' ||
             CASE WHEN a.grantor = 0 THEN 'PUBLIC' ELSE g2.rolname END
             || '(' || CASE WHEN a.is_grantable THEN 't' ELSE 'f' END || ')',
             ',' ORDER BY
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE g1.rolname END,
             a.privilege_type,
             CASE WHEN a.grantor = 0 THEN 'PUBLIC' ELSE g2.rolname END), 'NULL')
      INTO v_acl
      FROM aclexplode(v_fn.proacl) AS a
      LEFT JOIN pg_roles g1 ON g1.oid = a.grantee
      LEFT JOIN pg_roles g2 ON g2.oid = a.grantor;
  EXCEPTION WHEN OTHERS THEN v_acl := 'NULL';
  END;

  v_provenance_ok := (v_prosrc_hash = v_prov.prosrc_hash
                      AND v_fn.args = v_prov.identity_args
                      AND v_fn.ret_type = v_prov.ret_type
                      AND v_fn.lanname = v_prov.lang_name
                      AND v_fn.owner_name = v_prov.owner_name
                      AND v_fn.prosecdef = v_prov.prosecdef
                      AND v_fn.config = v_prov.proconfig
                      AND v_acl = v_prov.acl_canonical);

  IF NOT v_provenance_ok THEN
    RAISE EXCEPTION 'rollback_gp04: function % (%) provenance mismatch. Aborting.', v_fn.proname, v_fn.args;
  END IF;
END $$;

-- Destructive statements (all provenance verified above)
REVOKE EXECUTE ON FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid) FROM gitwire_app;
DROP FUNCTION IF EXISTS finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid);

-- Revoke only GP-04's INSERT grants (preserve GP-03's SELECT grants)
REVOKE INSERT ON policy_validation_evidence FROM gitwire_policy_fn_owner;
REVOKE INSERT ON policy_simulation_evidence FROM gitwire_policy_fn_owner;

DROP TABLE IF EXISTS gp04_function_provenance;

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '047_gp04_validation_simulation.sql';

COMMIT;
