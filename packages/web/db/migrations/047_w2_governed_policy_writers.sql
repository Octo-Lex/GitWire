-- W2-03 — close legacy live-policy writer bypasses.
--
-- repo_config is now a compatibility materialization of the immutable W2-01
-- authority + W2-02 promotion chain.  Any transaction that leaves a repo_config
-- row committed must also leave the exact governed active binding/promotion
-- tuple that owns that materialization.  The constraint trigger is deferred so
-- the canonical W2-02 transaction can write repo_config before it installs the
-- active binding and finalizes effect-time audit fields.

CREATE FUNCTION enforce_w2_governed_repo_config_materialization()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_repo_id BIGINT;
  v_config JSONB;
  v_updated_at TIMESTAMPTZ;
  v_updated_by TEXT;
  v_policy_document JSONB;
  v_promoted_at TIMESTAMPTZ;
  v_expected_actor TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_repo_id := OLD.repo_id;
  ELSE
    v_repo_id := NEW.repo_id;
  END IF;

  -- Read the final transaction-visible state rather than the trigger event's
  -- NEW record. W2-02 legitimately updates repo_config again in its rollout
  -- finalizer to stamp the immutable promotion effect time.
  SELECT rc.config,
         rc.updated_at,
         rc.updated_by,
         pv.policy_document,
         pr.promoted_at,
         format(
           'policy-promotion:%s:%s',
           pr.promoter_principal_id,
           pr.rollout_plan_id
         )
    INTO v_config,
         v_updated_at,
         v_updated_by,
         v_policy_document,
         v_promoted_at,
         v_expected_actor
    FROM public.repo_config rc
    JOIN public.active_policy_bindings apb
      ON apb.repo_id = rc.repo_id
    JOIN public.policy_versions pv
      ON pv.id = apb.policy_version_id
    JOIN public.policy_promotion_records pr
      ON pr.id = apb.promotion_record_id
   WHERE rc.repo_id = v_repo_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'repo_config live materialization requires governed active policy binding';
  END IF;

  IF v_config IS DISTINCT FROM v_policy_document
     OR v_updated_at IS DISTINCT FROM v_promoted_at
     OR v_updated_by IS DISTINCT FROM v_expected_actor
  THEN
    RAISE EXCEPTION
      'repo_config live materialization does not match governed promotion';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_repo_config_require_governed_materialization
  AFTER INSERT OR UPDATE OR DELETE ON repo_config
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_w2_governed_repo_config_materialization();
