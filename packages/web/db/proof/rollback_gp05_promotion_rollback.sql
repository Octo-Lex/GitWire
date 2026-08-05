-- Exact rollback for GP-05 migration 048.
-- Provenance-aware, fail-closed, transactional.
-- Refuses when authoritative GP-05 promotion/rollback data exists.

BEGIN;

SET search_path = gitwire_policy, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- Precondition: 048 must be in the migration ledger
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_ledger_count int;
BEGIN
  SELECT count(*) INTO v_ledger_count FROM public.schema_migrations WHERE version = '048_gp05_promotion_rollback.sql';
  IF v_ledger_count = 0 THEN
    RAISE EXCEPTION 'rollback_gp05: precondition failed — 048 is not recorded in the migration ledger';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Refuse if authoritative GP-05 data exists
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_promo_count int;
  v_bind_count int;
  v_rb_count int;
BEGIN
  SELECT count(*) INTO v_promo_count FROM policy_promotion_records WHERE promotion_kind IS NOT NULL;
  SELECT count(*) INTO v_bind_count FROM active_policy_bindings;
  SELECT count(*) INTO v_rb_count FROM policy_rollback_records;
  IF v_promo_count > 0 OR v_bind_count > 0 OR v_rb_count > 0 THEN
    RAISE EXCEPTION 'rollback_gp05: cannot roll back — authoritative GP-05 promotion records (%) or bindings (%) or rollback records (%) exist',
      v_promo_count, v_bind_count, v_rb_count;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Provenance verification: exact regprocedure lookup for all 6 functions
-- ════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_prov_count int;
  v_fn record;
  v_prosrc_hash text;
  v_acl text;
  v_prov record;
  v_provenance_ok boolean;
  v_sig text;
BEGIN
  SELECT count(*) INTO v_prov_count FROM gitwire_policy.gp05_function_provenance;
  IF v_prov_count != 6 THEN
    RAISE EXCEPTION 'rollback_gp05: expected 6 provenance rows, found %', v_prov_count;
  END IF;

  FOR v_sig IN SELECT unnest(ARRAY[
    'promote_policy_change_request(uuid, bigint, bigint, uuid)',
    'create_policy_rollback_request(uuid, bigint, uuid, uuid)',
    'approve_policy_rollback_request(uuid, bigint, uuid)',
    'reject_policy_rollback_request(uuid, bigint, uuid)',
    'withdraw_policy_rollback_request(uuid, bigint, uuid)',
    'promote_policy_rollback_request(uuid, bigint, bigint, uuid)'
  ]) LOOP
    EXECUTE format('SELECT p.proname, p.oid, pg_get_function_identity_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS ret_type, p.proacl, pg_get_userbyid(p.proowner) AS owner_name, p.prosecdef, l.lanname, COALESCE(array_to_string(p.proconfig,'',''),'''') AS config FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid JOIN pg_language l ON p.prolang=l.oid WHERE n.nspname=''gitwire_policy'' AND p.oid = %L::regprocedure', 'gitwire_policy.' || v_sig) INTO v_fn;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollback_gp05: % not found by exact regprocedure', v_sig;
    END IF;

    SELECT * INTO v_prov FROM gitwire_policy.gp05_function_provenance WHERE proname = v_fn.proname AND identity_args = v_fn.args;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rollback_gp05: no provenance record for % (%)', v_fn.proname, v_fn.args;
    END IF;

    v_prosrc_hash := encode(public.digest((SELECT prosrc FROM pg_proc WHERE oid = v_fn.oid), 'sha256'), 'hex');
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
      RAISE EXCEPTION 'rollback_gp05: function % (%) provenance mismatch. Aborting.', v_fn.proname, v_fn.args;
    END IF;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Destructive statements (all provenance verified above)
-- No IF EXISTS — use exact regprocedure. No CASCADE.
-- ════════════════════════════════════════════════════════════════════════════

-- Revoke EXECUTE from runtime role, then drop each function by exact signature
REVOKE EXECUTE ON FUNCTION promote_policy_change_request(uuid, bigint, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION create_policy_rollback_request(uuid, bigint, uuid, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION approve_policy_rollback_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION reject_policy_rollback_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION withdraw_policy_rollback_request(uuid, bigint, uuid) FROM gitwire_app;
REVOKE EXECUTE ON FUNCTION promote_policy_rollback_request(uuid, bigint, bigint, uuid) FROM gitwire_app;

DROP FUNCTION promote_policy_change_request(uuid, bigint, bigint, uuid);
DROP FUNCTION create_policy_rollback_request(uuid, bigint, uuid, uuid);
DROP FUNCTION approve_policy_rollback_request(uuid, bigint, uuid);
DROP FUNCTION reject_policy_rollback_request(uuid, bigint, uuid);
DROP FUNCTION withdraw_policy_rollback_request(uuid, bigint, uuid);
DROP FUNCTION promote_policy_rollback_request(uuid, bigint, bigint, uuid);

-- Revoke GP-05 fn_owner grants (only those added by migration 048)
REVOKE SELECT, INSERT ON policy_rollback_lifecycle FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT, UPDATE ON active_policy_bindings FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT ON policy_promotion_records FROM gitwire_policy_fn_owner;
REVOKE SELECT, INSERT, UPDATE ON policy_rollback_records FROM gitwire_policy_fn_owner;
REVOKE UPDATE ON policy_change_requests FROM gitwire_policy_fn_owner;
REVOKE SELECT ON policy_approval_lifecycle FROM gitwire_policy_fn_owner;

-- Drop the rollback lifecycle table (GP-05-owned, no GP-01..04 references it)
DROP TABLE policy_rollback_lifecycle;

-- Remove GP-05 columns and constraints from policy_rollback_records
ALTER TABLE policy_rollback_records DROP CONSTRAINT IF EXISTS prr_execution_record_check;
ALTER TABLE policy_rollback_records DROP CONSTRAINT IF EXISTS prr_promotion_record_fk;
ALTER TABLE policy_rollback_records DROP CONSTRAINT IF EXISTS prr_target_promotion_fk;
ALTER TABLE policy_rollback_records DROP CONSTRAINT IF EXISTS prr_base_version_fk;
ALTER TABLE policy_rollback_records DROP COLUMN IF EXISTS target_promotion_record_id;
ALTER TABLE policy_rollback_records DROP COLUMN IF EXISTS risk_classification;

-- Remove promotion_kind from promotion records
ALTER TABLE policy_promotion_records DROP COLUMN IF EXISTS promotion_kind;

-- Drop provenance table
DROP TABLE gp05_function_provenance;

-- Remove GP-05 permission declarations
DELETE FROM gitwire_auth.auth_role_permissions
WHERE permission IN (
  'policy_change_request:promote',
  'policy_rollback_request:create',
  'policy_rollback_request:approve',
  'policy_rollback_request:promote',
  'policy_rollback_request:read',
  'policy_active_binding:read',
  'policy_promotion_record:read'
);

RESET search_path;

DELETE FROM public.schema_migrations WHERE version = '048_gp05_promotion_rollback.sql';

COMMIT;
