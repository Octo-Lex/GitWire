-- Exact rollback for GP-04 migration 047.
-- Provenance-aware, fail-closed, transactional.
-- Refuses when authoritative GP-04 evidence or transition events exist.

BEGIN;

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Precondition: 047 must be in the migration ledger
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ledger_count int;
BEGIN
  SELECT count(*) INTO v_ledger_count FROM public.schema_migrations WHERE version = '047_gp04_validation_simulation.sql';
  IF v_ledger_count = 0 THEN
    RAISE EXCEPTION 'rollback_gp04: precondition failed — 047 is not recorded in the migration ledger';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Refuse if authoritative GP-04 data exists (both evidence tables + events)
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_val_count int;
  v_sim_count int;
  v_event_count int;
BEGIN
  SELECT count(*) INTO v_val_count FROM policy_validation_evidence pev
    JOIN pg_proc p ON p.proname = 'finalize_policy_evaluation'
    JOIN pg_namespace n ON p.pronamespace = n.oid AND n.nspname = 'gitwire_policy'
    WHERE pev.result->>'schema_version' = 'gp04.validation.v1';
  SELECT count(*) INTO v_sim_count FROM policy_simulation_evidence pse
    WHERE pse.result->>'schema_version' = 'gp04.simulation.v1';
  SELECT count(*) INTO v_event_count FROM policy_transition_events
    WHERE event_type IN ('evaluation_complete','validation_rejected','simulation_rejected');
  IF v_val_count > 0 OR v_sim_count > 0 OR v_event_count > 0 THEN
    RAISE EXCEPTION 'rollback_gp04: cannot roll back — authoritative GP-04 validation evidence (%) or simulation evidence (%) or transition events (%) exist', v_val_count, v_sim_count, v_event_count;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Provenance verification: exact regprocedure lookup
-- ════════════════════════════════════════════════════════════════════════════
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

  -- Exact regprocedure lookup (not just proname)
  SELECT p.proname, p.oid, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_function_result(p.oid) AS ret_type, p.proacl,
         pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef, l.lanname,
         COALESCE(array_to_string(p.proconfig,','),'') AS config
    INTO v_fn
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    JOIN pg_language l ON p.prolang = l.oid
    WHERE n.nspname = 'gitwire_policy'
      AND p.oid = 'gitwire_policy.finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid)'::regprocedure;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_gp04: finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid) not found by exact regprocedure';
  END IF;

  SELECT * INTO v_prov FROM gitwire_policy.gp04_function_provenance WHERE proname = v_fn.proname AND identity_args = v_fn.args;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollback_gp04: no provenance record for % (%)', v_fn.proname, v_fn.args;
  END IF;

  v_prosrc_hash := encode(public.digest((SELECT prosrc FROM pg_proc WHERE oid = v_fn.oid), 'sha256'), 'hex');
  -- ACL canonicalization (no error suppression — fail closed)
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

  v_provenance_ok := (v_prosrc_hash = v_prov.prosrc_hash
                      AND v_fn.args = v_prov.identity_args
                      AND v_fn.ret_type = v_prov.ret_type
                      AND v_fn.lanname = v_prov.lang_name
                      AND v_fn.owner_name = v_prov.owner_name
                      AND v_fn.prosecdef = v_prov.prosecdef
                      AND v_fn.config = v_prov.proconfig
                      AND v_acl = v_prov.acl_canonical);

  IF NOT v_provenance_ok THEN
    RAISE EXCEPTION 'rollback_gp04: function % (%) provenance mismatch (prosrc_hash=% vs %, acl=% vs %). Aborting.',
      v_fn.proname, v_fn.args, v_prosrc_hash, v_prov.prosrc_hash, v_acl, v_prov.acl_canonical;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Destructive statements (all provenance verified above)
-- No IF EXISTS — use exact regprocedure
-- ════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid) FROM gitwire_app;
DROP FUNCTION finalize_policy_evaluation(uuid, bigint, jsonb, text, jsonb, text, uuid);

-- Revoke the least-privilege simulator SELECT grants added by migration 047.
-- Column lists mirror the GRANT in 047 exactly (derived from simulatePolicyObject()).
REVOKE SELECT (github_id, full_name, owner) ON public.repositories FROM gitwire_app;
REVOKE SELECT (id, source, trigger_event, target_type, target_number, pillar, decision, reason, repo_id)
  ON public.decision_log FROM gitwire_app;

-- Revoke only GP-04's INSERT grants (preserve GP-03's SELECT grants)
REVOKE INSERT ON policy_validation_evidence FROM gitwire_policy_fn_owner;
REVOKE INSERT ON policy_simulation_evidence FROM gitwire_policy_fn_owner;

DROP TABLE gp04_function_provenance;

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '047_gp04_validation_simulation.sql';

COMMIT;
