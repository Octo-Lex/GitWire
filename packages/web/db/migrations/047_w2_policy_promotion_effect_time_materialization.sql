-- 047_w2_policy_promotion_effect_time_materialization.sql
-- W2-02: keep committed compatibility/audit timestamps on the immutable
-- promotion wall-clock effect time.
--
-- PostgreSQL NOW() is transaction-start time. A governed promotion can wait on
-- the repository mutex after its transaction begins, so repo_config.updated_at,
-- config_history.changed_at, and the rollout updated_at trigger must not retain
-- that earlier transaction timestamp. The immutable promotion record is the
-- canonical effect-time clock; only governed transitions that have such a
-- record are changed here. Legacy rollout promotion remains untouched pending
-- W2-03 direct-writer conversion.

-- Preserve legacy trigger semantics for non-governed transitions, but when an
-- approved rollout is entering promoted state through W2-02, copy the exact
-- immutable promotion time rather than transaction-start NOW().
CREATE OR REPLACE FUNCTION update_rollout_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_promotion_time TIMESTAMPTZ;
BEGIN
  IF NEW.status = 'promoted'
     AND OLD.status IS DISTINCT FROM 'promoted'
  THEN
    SELECT promoted_at
      INTO v_promotion_time
      FROM policy_promotion_records
     WHERE rollout_plan_id = NEW.id
       AND repo_id = NEW.repo_id;

    IF FOUND THEN
      NEW.updated_at := v_promotion_time;
      RETURN NEW;
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- All materialization writes happen before the final rollout transition in the
-- same transaction. At that transition, stamp the compatibility row and its
-- config-history audit row from the exact immutable promotion record. Because
-- these updates are still inside the promotion transaction, any missing or
-- mismatched governed materialization fails closed and rolls back the whole
-- promotion. A legacy promotion has no immutable W2-02 record and is ignored.
CREATE FUNCTION finalize_w2_policy_promotion_effect_time()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_promotion public.policy_promotion_records%ROWTYPE;
  v_actor_token TEXT;
  v_repo_config_rows INTEGER;
  v_history_rows INTEGER;
BEGIN
  SELECT *
    INTO v_promotion
    FROM policy_promotion_records
   WHERE rollout_plan_id = NEW.id
     AND repo_id = NEW.repo_id;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.promoted_at IS DISTINCT FROM v_promotion.promoted_at
     OR NEW.promoted_by IS DISTINCT FROM v_promotion.promoter_principal_id::text
  THEN
    RAISE EXCEPTION 'governed rollout audit identity does not match immutable promotion record';
  END IF;

  v_actor_token := format(
    'policy-promotion:%s:%s',
    v_promotion.promoter_principal_id,
    v_promotion.rollout_plan_id
  );

  WITH stamped AS (
    UPDATE repo_config
       SET updated_at = v_promotion.promoted_at
     WHERE repo_id = NEW.repo_id
       AND updated_by = v_actor_token
    RETURNING 1
  )
  SELECT count(*)::int INTO v_repo_config_rows FROM stamped;

  IF v_repo_config_rows <> 1 THEN
    RAISE EXCEPTION 'governed promotion compatibility materialization timestamp target missing';
  END IF;

  WITH stamped AS (
    UPDATE config_history
       SET changed_at = v_promotion.promoted_at
     WHERE repo_id = NEW.repo_id
       AND changed_by = v_actor_token
    RETURNING 1
  )
  SELECT count(*)::int INTO v_history_rows FROM stamped;

  IF v_history_rows <> 1 THEN
    RAISE EXCEPTION 'governed promotion config-history timestamp target missing or ambiguous';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rollout_w2_promotion_effect_time
  AFTER UPDATE ON policy_rollout_plans
  FOR EACH ROW
  WHEN (NEW.status = 'promoted' AND OLD.status IS DISTINCT FROM 'promoted')
  EXECUTE FUNCTION finalize_w2_policy_promotion_effect_time();
