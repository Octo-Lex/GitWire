-- W2-03 — governed policy-writer cutover.
--
-- W2-02 made immutable promotion records + active-policy bindings canonical,
-- but compatibility/direct repo_config writers could still attempt live policy
-- mutations. This migration closes that storage escape hatch without rewriting
-- pre-existing legacy rows in place.
--
-- The constraint trigger is intentionally deferred: the canonical W2-02
-- promotion transaction writes repo_config before its active binding and final
-- rollout/audit timestamps are complete. At COMMIT, every touched live-policy
-- row must resolve to the exact immutable promotion bundle.

CREATE FUNCTION enforce_w2_governed_repo_config_end_state()
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
  v_promotion_time TIMESTAMPTZ;
  v_actor_token TEXT;
  v_promoter_principal_id UUID;
  v_rollout_status TEXT;
  v_rollout_promoted_by TEXT;
  v_rollout_promoted_at TIMESTAMPTZ;
  v_history_rows INTEGER;
BEGIN
  v_repo_id := COALESCE(NEW.repo_id, OLD.repo_id);

  -- Deleting the DB materialization changes live policy resolution (back to a
  -- lower layer) and therefore cannot be a compatibility-side operation.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct live-policy deletion is disabled; use governed policy promotion';
  END IF;

  -- Read the FINAL row state at deferred-trigger execution time rather than
  -- the event's NEW tuple. W2-02 deliberately canonicalizes repo_config time
  -- later in the same transaction after the first materialization write.
  SELECT rc.config,
         rc.updated_at,
         rc.updated_by,
         pv.policy_document,
         pr.promoted_at,
         format('policy-promotion:%s:%s', pr.promoter_principal_id, pr.rollout_plan_id),
         pr.promoter_principal_id,
         p.status,
         p.promoted_by,
         p.promoted_at,
         (
           SELECT count(*)::int
             FROM config_history ch
            WHERE ch.repo_id = rc.repo_id
              AND ch.changed_by = format(
                'policy-promotion:%s:%s',
                pr.promoter_principal_id,
                pr.rollout_plan_id
              )
              AND ch.config_new = pv.policy_document
              AND ch.changed_at = pr.promoted_at
         )
    INTO v_config,
         v_updated_at,
         v_updated_by,
         v_policy_document,
         v_promotion_time,
         v_actor_token,
         v_promoter_principal_id,
         v_rollout_status,
         v_rollout_promoted_by,
         v_rollout_promoted_at,
         v_history_rows
    FROM repo_config rc
    JOIN active_policy_bindings apb
      ON apb.repo_id = rc.repo_id
    JOIN policy_promotion_records pr
      ON pr.id = apb.promotion_record_id
     AND pr.repo_id = apb.repo_id
     AND pr.policy_version_id = apb.policy_version_id
     AND pr.change_request_id = apb.change_request_id
     AND pr.approval_record_id = apb.approval_record_id
    JOIN policy_versions pv
      ON pv.id = apb.policy_version_id
     AND pv.repo_id = apb.repo_id
    JOIN policy_rollout_plans p
      ON p.id = pr.rollout_plan_id
     AND p.repo_id = pr.repo_id
   WHERE rc.repo_id = v_repo_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'live policy materialization lacks governed active-policy authority';
  END IF;

  IF v_config IS DISTINCT FROM v_policy_document THEN
    RAISE EXCEPTION 'live policy materialization does not match governed policy version';
  END IF;

  IF v_updated_by IS DISTINCT FROM v_actor_token THEN
    RAISE EXCEPTION 'live policy materialization attribution does not match governed promotion';
  END IF;

  IF v_updated_at IS DISTINCT FROM v_promotion_time THEN
    RAISE EXCEPTION 'live policy materialization time does not match governed promotion';
  END IF;

  IF v_rollout_status IS DISTINCT FROM 'promoted'
     OR v_rollout_promoted_by IS DISTINCT FROM v_promoter_principal_id::text
     OR v_rollout_promoted_at IS DISTINCT FROM v_promotion_time
  THEN
    RAISE EXCEPTION 'live policy materialization rollout state does not match governed promotion';
  END IF;

  IF v_history_rows <> 1 THEN
    RAISE EXCEPTION 'live policy materialization lacks exact governed config-history evidence';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_repo_config_governed_end_state
  AFTER INSERT OR UPDATE OR DELETE ON repo_config
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION enforce_w2_governed_repo_config_end_state();
