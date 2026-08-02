-- Exact rollback for GP-03 migration 046.
-- Drops only what 046 created. Preserves all GP-01/GP-02 grants and functions.
-- No CASCADE.
--
-- PROVENANCE-AWARE AND FAIL-CLOSED: this rollback verifies the exact six
-- GP-03 function identities created by migration 046. For each identity it
-- compares stable PL/pgSQL source hash, return type, language, owner,
-- SECURITY DEFINER, proconfig, and canonical ACL (including PUBLIC/OID 0).
-- Same-name overloads are outside the target set and are preserved.
--
-- PRECONDITION: requires a successfully recorded 046 ledger entry. If 046 was
-- never applied, only partially applied, or its provenance is uncertain, the
-- rollback aborts without committing any mutation.

BEGIN;

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Precondition: 046 must be in the migration ledger
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_ledger_count int;
BEGIN
  SELECT count(*) INTO v_ledger_count
  FROM public.schema_migrations
  WHERE version = '046_gp03_approval_functions.sql';

  IF v_ledger_count != 1 THEN
    RAISE EXCEPTION
      'rollback_gp03_approval: precondition failed — expected one 046 ledger row, found %',
      v_ledger_count;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Provenance verification for the exact six function identities.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_expected_oids oid[] := ARRAY[
    to_regprocedure('gitwire_policy.approve_policy_change_request(uuid,bigint,uuid)')::oid,
    to_regprocedure('gitwire_policy.create_policy_approval_rule(text,text,text,text,text,integer,jsonb,uuid,integer)')::oid,
    to_regprocedure('gitwire_policy.evaluate_approval_sufficiency(uuid)')::oid,
    to_regprocedure('gitwire_policy.expire_policy_approval(uuid,bigint,uuid)')::oid,
    to_regprocedure('gitwire_policy.record_policy_approval(uuid,uuid,uuid)')::oid,
    to_regprocedure('gitwire_policy.revoke_policy_approval(uuid,bigint,uuid,text)')::oid
  ];
  v_prov_count int;
  v_fn record;
  v_prov record;
  v_prosrc_hash text;
  v_acl text;
  v_provenance_ok boolean;
BEGIN
  IF array_position(v_expected_oids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION
      'rollback_gp03_approval: one or more exact GP-03 function signatures are missing';
  END IF;

  SELECT count(*) INTO v_prov_count
  FROM gitwire_policy.gp03_function_provenance;
  IF v_prov_count != 6 THEN
    RAISE EXCEPTION
      'rollback_gp03_approval: expected 6 provenance rows, found %',
      v_prov_count;
  END IF;

  -- The provenance relation must be exactly the six expected composite keys.
  IF EXISTS (
    WITH expected AS (
      SELECT p.proname,
             pg_get_function_identity_arguments(p.oid) AS identity_args
      FROM unnest(v_expected_oids) AS expected_oid(oid)
      JOIN pg_proc p ON p.oid = expected_oid.oid
    )
    SELECT 1
    FROM gitwire_policy.gp03_function_provenance fp
    FULL JOIN expected e
      ON e.proname = fp.proname
     AND e.identity_args = fp.identity_args
    WHERE fp.proname IS NULL OR e.proname IS NULL
  ) THEN
    RAISE EXCEPTION
      'rollback_gp03_approval: provenance rows do not match the exact six GP-03 signatures';
  END IF;

  FOR v_fn IN
    SELECT p.proname,
           p.oid,
           p.prosrc,
           p.proacl,
           p.proowner,
           pg_get_function_identity_arguments(p.oid) AS identity_args,
           pg_get_function_result(p.oid) AS ret_type,
           l.lanname AS lang_name,
           pg_get_userbyid(p.proowner) AS owner_name,
           p.prosecdef,
           COALESCE(array_to_string(p.proconfig, ','), '') AS proconfig
    FROM unnest(v_expected_oids) AS expected_oid(oid)
    JOIN pg_proc p ON p.oid = expected_oid.oid
    JOIN pg_language l ON l.oid = p.prolang
    ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
  LOOP
    SELECT fp.prosrc_hash,
           fp.identity_args,
           fp.ret_type,
           fp.lang_name,
           fp.owner_name,
           fp.prosecdef,
           fp.proconfig,
           fp.acl_canonical
      INTO STRICT v_prov
    FROM gitwire_policy.gp03_function_provenance fp
    WHERE fp.proname = v_fn.proname
      AND fp.identity_args = v_fn.identity_args;

    v_prosrc_hash := encode(public.digest(v_fn.prosrc, 'sha256'), 'hex');

    SELECT COALESCE(string_agg(
             COALESCE(grantee_role.rolname,
                      CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                           ELSE '#' || acl.grantee::text END)
               || '=' || acl.privilege_type || '/'
               || COALESCE(grantor_role.rolname, '#' || acl.grantor::text)
               || '(' || CASE WHEN acl.is_grantable THEN 't' ELSE 'f' END || ')',
             ',' ORDER BY
               COALESCE(grantee_role.rolname,
                        CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
                             ELSE '#' || acl.grantee::text END),
               acl.privilege_type,
               COALESCE(grantor_role.rolname, '#' || acl.grantor::text),
               acl.is_grantable),
           'NULL')
      INTO v_acl
    FROM aclexplode(COALESCE(v_fn.proacl, acldefault('f', v_fn.proowner))) AS acl
    LEFT JOIN pg_roles grantee_role ON grantee_role.oid = acl.grantee
    LEFT JOIN pg_roles grantor_role ON grantor_role.oid = acl.grantor;

    v_provenance_ok := (
      v_prosrc_hash = v_prov.prosrc_hash
      AND v_fn.identity_args = v_prov.identity_args
      AND v_fn.ret_type = v_prov.ret_type
      AND v_fn.lang_name = v_prov.lang_name
      AND v_fn.owner_name = v_prov.owner_name
      AND v_fn.prosecdef = v_prov.prosecdef
      AND v_fn.proconfig = v_prov.proconfig
      AND v_acl = v_prov.acl_canonical
    );

    IF NOT v_provenance_ok THEN
      RAISE EXCEPTION
        'rollback_gp03_approval: function % (%) provenance mismatch (prosrc_hash=% vs %, acl=% vs %)',
        v_fn.proname,
        v_fn.identity_args,
        v_prosrc_hash,
        v_prov.prosrc_hash,
        v_acl,
        v_prov.acl_canonical;
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Destructive rollback begins only after all provenance checks pass.
-- ════════════════════════════════════════════════════════════════════════════
REVOKE EXECUTE ON FUNCTION approve_policy_change_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION evaluate_approval_sufficiency(uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION expire_policy_approval(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION revoke_policy_approval(uuid, bigint, uuid, text) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION record_policy_approval(uuid, uuid, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer) FROM gitwire_app;

DROP FUNCTION approve_policy_change_request(uuid, bigint, uuid);
DROP FUNCTION evaluate_approval_sufficiency(uuid);
DROP FUNCTION expire_policy_approval(uuid, bigint, uuid);
DROP FUNCTION revoke_policy_approval(uuid, bigint, uuid, text);
DROP FUNCTION record_policy_approval(uuid, uuid, uuid);
DROP FUNCTION create_policy_approval_rule(text, text, text, text, text, integer, jsonb, uuid, integer);

REVOKE SELECT, INSERT ON policy_approval_rules FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_approvals FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_approval_lifecycle FROM gitwire_policy_fn_owner;
REVOKE SELECT ON policy_validation_evidence FROM gitwire_policy_fn_owner;
REVOKE SELECT ON policy_simulation_evidence FROM gitwire_policy_fn_owner;

REVOKE SELECT ON policy_transition_events FROM gitwire_policy_fn_owner;

REVOKE SELECT ON gitwire_auth.auth_principal_roles FROM gitwire_policy_fn_owner;
REVOKE SELECT ON gitwire_auth.auth_roles FROM gitwire_policy_fn_owner;
REVOKE SELECT ON gitwire_auth.auth_principals FROM gitwire_policy_fn_owner;
REVOKE USAGE ON SCHEMA gitwire_auth FROM gitwire_policy_fn_owner;

REVOKE SELECT (github_id, installation_id, full_name, owner, name) ON public.repositories FROM gitwire_policy_fn_owner;
REVOKE SELECT (github_id, account_login) ON public.installations FROM gitwire_policy_fn_owner;

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

ALTER TABLE policy_approvals DROP COLUMN IF EXISTS expires_at;
ALTER TABLE policy_approval_rules DROP COLUMN IF EXISTS approval_ttl_seconds;
ALTER TABLE policy_approval_rules DROP COLUMN IF EXISTS rule_revision;

DROP TABLE gp03_function_provenance;

RESET search_path;

DELETE FROM public.schema_migrations
WHERE version = '046_gp03_approval_functions.sql';

COMMIT;
