-- 046_w2_policy_promotion.sql
-- W2-02: immutable promotion authority and single active-policy binding.
--
-- Boundary:
--   * promotion consumes W2-01 immutable version/change/evidence/approval authority;
--   * promotion records are append-only;
--   * active_policy_bindings is the single mutable pointer to governed live policy;
--   * repo_config remains the compatibility materialization until W2-03 converts
--     or disables the remaining direct writers;
--   * no role grants, production cutover, config layering, or Wave-3 machinery.
--
-- Authority identity exception to the general application-table BIGSERIAL
-- convention: W2-01 established UUID identities for immutable authority records,
-- so policy_promotion_records continues that model. active_policy_bindings uses
-- repo_id as its primary key deliberately so PostgreSQL itself enforces exactly
-- one live governed binding per repository; a surrogate key would not express
-- that singleton authority invariant.

-- Exact composite keys let promotion records prove their W2-01 bindings without
-- trusting application-side relationship assembly.
ALTER TABLE policy_change_requests
  ADD CONSTRAINT uq_policy_change_requests_promotion_binding
  UNIQUE (id, repo_id, policy_version_id, author_principal_id);

ALTER TABLE policy_change_requests
  ADD CONSTRAINT uq_policy_change_requests_rollout_binding
  UNIQUE (id, rollout_plan_id);

ALTER TABLE policy_approval_records
  ADD CONSTRAINT uq_policy_approval_records_promotion_binding
  UNIQUE (
    id,
    change_request_id,
    policy_version_id,
    approver_principal_id,
    evidence_set_hash
  );

CREATE TABLE policy_promotion_records (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id                    BIGINT NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
  rollout_plan_id            BIGINT NOT NULL,
  change_request_id          UUID NOT NULL,
  policy_version_id          UUID NOT NULL,
  previous_policy_version_id UUID,
  approval_record_id         UUID NOT NULL,
  author_principal_id        UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  approver_principal_id      UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  promoter_principal_id      UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  evidence_set_hash          TEXT NOT NULL,
  reason                     TEXT,
  promoted_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT uq_policy_promotion_change_request UNIQUE (change_request_id),
  CONSTRAINT uq_policy_promotion_version UNIQUE (policy_version_id),

  CONSTRAINT fk_policy_promotion_rollout_repo
    FOREIGN KEY (rollout_plan_id, repo_id)
    REFERENCES policy_rollout_plans(id, repo_id) ON DELETE RESTRICT,

  CONSTRAINT fk_policy_promotion_change_rollout
    FOREIGN KEY (change_request_id, rollout_plan_id)
    REFERENCES policy_change_requests(id, rollout_plan_id) ON DELETE RESTRICT,

  CONSTRAINT fk_policy_promotion_change_binding
    FOREIGN KEY (
      change_request_id,
      repo_id,
      policy_version_id,
      author_principal_id
    )
    REFERENCES policy_change_requests(
      id,
      repo_id,
      policy_version_id,
      author_principal_id
    ) ON DELETE RESTRICT,

  CONSTRAINT fk_policy_promotion_approval_binding
    FOREIGN KEY (
      approval_record_id,
      change_request_id,
      policy_version_id,
      approver_principal_id,
      evidence_set_hash
    )
    REFERENCES policy_approval_records(
      id,
      change_request_id,
      policy_version_id,
      approver_principal_id,
      evidence_set_hash
    ) ON DELETE RESTRICT,

  CONSTRAINT fk_policy_promotion_previous_repo
    FOREIGN KEY (previous_policy_version_id, repo_id)
    REFERENCES policy_versions(id, repo_id) ON DELETE RESTRICT,

  CONSTRAINT chk_policy_promotion_evidence_hash
    CHECK (evidence_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_policy_promotion_promoter_not_author
    CHECK (promoter_principal_id <> author_principal_id),
  CONSTRAINT chk_policy_promotion_promoter_not_approver
    CHECK (promoter_principal_id <> approver_principal_id)
);

CREATE INDEX idx_policy_promotion_repo_time
  ON policy_promotion_records (repo_id, promoted_at DESC);

CREATE TABLE active_policy_bindings (
  repo_id               BIGINT PRIMARY KEY REFERENCES repositories(github_id) ON DELETE RESTRICT,
  policy_version_id     UUID NOT NULL,
  promotion_record_id   UUID NOT NULL UNIQUE REFERENCES policy_promotion_records(id) ON DELETE RESTRICT,
  change_request_id     UUID NOT NULL REFERENCES policy_change_requests(id) ON DELETE RESTRICT,
  approval_record_id    UUID NOT NULL REFERENCES policy_approval_records(id) ON DELETE RESTRICT,
  author_principal_id   UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  approver_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  promoter_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  evidence_set_hash     TEXT NOT NULL,
  activated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT fk_active_policy_version_repo
    FOREIGN KEY (policy_version_id, repo_id)
    REFERENCES policy_versions(id, repo_id) ON DELETE RESTRICT,
  CONSTRAINT chk_active_policy_evidence_hash
    CHECK (evidence_set_hash ~ '^sha256:[0-9a-f]{64}$')
);

-- Promotion insertion is the storage-level stale-base and authority backstop.
-- It serializes all governed promotions for a repository by locking the
-- repositories row, then proves that the W2-01 approval is still structurally
-- usable and that the supplied previous version equals the current active
-- binding. Runtime authorization/revocation checks remain application-owned.
--
-- Approval expiry intentionally uses NOW(), PostgreSQL's transaction-start
-- timestamp. The service holds the change-request row lock for the promotion
-- transaction, so approval validity is evaluated against one stable authority
-- snapshot rather than changing mid-transaction.
CREATE FUNCTION prepare_w2_policy_promotion_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_active_version UUID;
  v_decision TEXT;
  v_expires_at TIMESTAMPTZ;
  v_manifest JSONB;
  v_validation_valid BOOLEAN;
BEGIN
  PERFORM 1
    FROM repositories
   WHERE github_id = NEW.repo_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion repository % not found', NEW.repo_id;
  END IF;

  SELECT policy_version_id
    INTO v_active_version
    FROM active_policy_bindings
   WHERE repo_id = NEW.repo_id
   FOR UPDATE;

  IF FOUND THEN
    IF NEW.previous_policy_version_id IS DISTINCT FROM v_active_version THEN
      RAISE EXCEPTION 'stale policy promotion base';
    END IF;
  ELSIF NEW.previous_policy_version_id IS NOT NULL THEN
    RAISE EXCEPTION 'first governed promotion requires null previous policy version';
  END IF;

  SELECT decision, expires_at, evidence_manifest
    INTO v_decision, v_expires_at, v_manifest
    FROM policy_approval_records
   WHERE id = NEW.approval_record_id;

  IF NOT FOUND OR v_decision <> 'approved' THEN
    RAISE EXCEPTION 'promotion requires an approved authority record';
  END IF;
  IF v_expires_at IS NOT NULL AND v_expires_at <= NOW() THEN
    RAISE EXCEPTION 'promotion approval is expired';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM policy_approval_records
     WHERE change_request_id = NEW.change_request_id
       AND decision = 'rejected'
  ) THEN
    RAISE EXCEPTION 'promotion is blocked by a rejection record';
  END IF;

  SELECT (e.evidence_payload->'valid') = 'true'::jsonb
    INTO v_validation_valid
    FROM jsonb_array_elements(v_manifest) item
    JOIN policy_evidence_records e
      ON e.id = (item->>'evidence_id')::uuid
     AND e.change_request_id = NEW.change_request_id
     AND e.policy_version_id = NEW.policy_version_id
     AND e.evidence_type = 'validation_result'
     AND e.evidence_hash = item->>'evidence_hash'
   LIMIT 1;

  IF v_validation_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'promotion validation evidence is not explicitly valid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_promotion_prepare_insert
  BEFORE INSERT ON policy_promotion_records
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_policy_promotion_insert();

-- The mutable pointer may change only to an immutable promotion record whose
-- full authority tuple exactly matches the proposed binding.
CREATE FUNCTION prepare_w2_active_policy_binding_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_promotion public.policy_promotion_records%ROWTYPE;
BEGIN
  SELECT *
    INTO v_promotion
    FROM policy_promotion_records
   WHERE id = NEW.promotion_record_id;

  IF NOT FOUND
     OR v_promotion.repo_id <> NEW.repo_id
     OR v_promotion.policy_version_id <> NEW.policy_version_id
     OR v_promotion.change_request_id <> NEW.change_request_id
     OR v_promotion.approval_record_id <> NEW.approval_record_id
     OR v_promotion.author_principal_id <> NEW.author_principal_id
     OR v_promotion.approver_principal_id <> NEW.approver_principal_id
     OR v_promotion.promoter_principal_id <> NEW.promoter_principal_id
     OR v_promotion.evidence_set_hash <> NEW.evidence_set_hash
  THEN
    RAISE EXCEPTION 'active policy binding does not match immutable promotion record';
  END IF;

  NEW.activated_at := v_promotion.promoted_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_active_policy_binding_prepare_insert
  BEFORE INSERT ON active_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_active_policy_binding_write();

CREATE TRIGGER trg_active_policy_binding_prepare_update
  BEFORE UPDATE ON active_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_active_policy_binding_write();

CREATE FUNCTION enforce_w2_policy_promotion_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_policy_promotion_no_update
  BEFORE UPDATE ON policy_promotion_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_promotion_append_only();
CREATE TRIGGER trg_policy_promotion_no_delete
  BEFORE DELETE ON policy_promotion_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_promotion_append_only();
CREATE TRIGGER trg_policy_promotion_no_truncate
  BEFORE TRUNCATE ON policy_promotion_records
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_promotion_append_only();

-- Active bindings are mutable only by replacement with a valid immutable
-- promotion tuple. Removing the current pointer would erase live authority.
CREATE TRIGGER trg_active_policy_binding_no_delete
  BEFORE DELETE ON active_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_promotion_append_only();
CREATE TRIGGER trg_active_policy_binding_no_truncate
  BEFORE TRUNCATE ON active_policy_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_promotion_append_only();
