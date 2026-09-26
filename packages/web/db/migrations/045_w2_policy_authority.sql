-- 045_w2_policy_authority.sql
-- W2-01: immutable policy versions, change requests, evidence, and approvals.
--
-- Boundary:
--   * additive authority records only;
--   * existing policy_rollout_plans remains the compatibility workflow;
--   * this migration does NOT change active policy, promotion semantics, config
--     layering, or direct config writers (W2-02..W2-04).
--
-- Existing rollout rows are intentionally NOT backfilled: legacy actor strings
-- cannot be converted into authoritative principal ids without trustworthy
-- identity evidence. W2-02 must require a W2-01 authority envelope for
-- authoritative promotion; legacy rollouts must be explicitly re-proposed or
-- rebound from server-owned principal context rather than silently adopted.

-- Composite relationship used below to prove a change request refers to the
-- same repository as its compatibility rollout plan.
ALTER TABLE policy_rollout_plans
  ADD CONSTRAINT uq_policy_rollout_plans_id_repo UNIQUE (id, repo_id);

CREATE TABLE policy_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id                BIGINT NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
  base_policy_version_id UUID,
  policy_document        JSONB NOT NULL,
  normalized_document    JSONB,
  content_hash           TEXT NOT NULL DEFAULT 'pending',
  author_principal_id    UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_policy_versions_id_repo UNIQUE (id, repo_id),
  CONSTRAINT uq_policy_versions_id_repo_author UNIQUE (id, repo_id, author_principal_id),
  CONSTRAINT fk_policy_versions_base_repo
    FOREIGN KEY (base_policy_version_id, repo_id)
    REFERENCES policy_versions(id, repo_id) ON DELETE RESTRICT,
  CONSTRAINT chk_policy_versions_not_self_based
    CHECK (base_policy_version_id IS NULL OR base_policy_version_id <> id),
  CONSTRAINT chk_policy_versions_content_hash
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX idx_policy_versions_repo_created
  ON policy_versions (repo_id, created_at DESC);
CREATE INDEX idx_policy_versions_content_hash
  ON policy_versions (repo_id, content_hash);

CREATE TABLE policy_change_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_plan_id     BIGINT NOT NULL,
  repo_id             BIGINT NOT NULL,
  policy_version_id   UUID NOT NULL UNIQUE,
  author_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_policy_change_requests_rollout UNIQUE (rollout_plan_id),
  CONSTRAINT uq_policy_change_requests_id_version UNIQUE (id, policy_version_id),
  CONSTRAINT fk_policy_change_requests_rollout_repo
    FOREIGN KEY (rollout_plan_id, repo_id)
    REFERENCES policy_rollout_plans(id, repo_id) ON DELETE RESTRICT,
  CONSTRAINT fk_policy_change_requests_version_repo_author
    FOREIGN KEY (policy_version_id, repo_id, author_principal_id)
    REFERENCES policy_versions(id, repo_id, author_principal_id) ON DELETE RESTRICT
);

CREATE INDEX idx_policy_change_requests_repo_created
  ON policy_change_requests (repo_id, created_at DESC);
CREATE INDEX idx_policy_change_requests_author
  ON policy_change_requests (author_principal_id, created_at DESC);

CREATE TABLE policy_evidence_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id        UUID NOT NULL,
  policy_version_id        UUID NOT NULL,
  evidence_type            TEXT NOT NULL CHECK (evidence_type IN (
                             'validation_result',
                             'simulation_summary',
                             'diff_impact_summary',
                             'recommendations_summary'
                           )),
  evidence_payload         JSONB NOT NULL,
  evidence_hash            TEXT NOT NULL DEFAULT 'pending',
  recorded_by_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_policy_evidence_change_version
    FOREIGN KEY (change_request_id, policy_version_id)
    REFERENCES policy_change_requests(id, policy_version_id) ON DELETE RESTRICT,
  CONSTRAINT uq_policy_evidence_exact
    UNIQUE (change_request_id, evidence_type, evidence_hash),
  CONSTRAINT chk_policy_evidence_hash
    CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$')
);

CREATE INDEX idx_policy_evidence_change_request
  ON policy_evidence_records (change_request_id, recorded_at, id);

CREATE TABLE policy_approval_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id        UUID NOT NULL,
  policy_version_id        UUID NOT NULL,
  approver_principal_id    UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  decision                 TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason                   TEXT,
  acknowledged_recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_manifest        JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_set_hash        TEXT NOT NULL DEFAULT 'pending',
  expires_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_policy_approval_change_version
    FOREIGN KEY (change_request_id, policy_version_id)
    REFERENCES policy_change_requests(id, policy_version_id) ON DELETE RESTRICT,
  CONSTRAINT uq_policy_approval_principal
    UNIQUE (change_request_id, approver_principal_id),
  CONSTRAINT chk_policy_approval_ack_array
    CHECK (jsonb_typeof(acknowledged_recommendations) = 'array'),
  CONSTRAINT chk_policy_approval_manifest_array
    CHECK (jsonb_typeof(evidence_manifest) = 'array'),
  CONSTRAINT chk_policy_approval_evidence_hash
    CHECK (evidence_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT chk_policy_approval_expiry
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idx_policy_approvals_change_request
  ON policy_approval_records (change_request_id, created_at DESC);

-- PostgreSQL JSONB text is the single database-owned canonical hash basis.
-- Callers never choose authority hashes; insert triggers derive them from the
-- stored JSONB payload before constraints/unique indexes are evaluated.
CREATE FUNCTION prepare_w2_policy_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.content_hash := 'sha256:' || encode(digest(NEW.policy_document::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_versions_prepare_insert
  BEFORE INSERT ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_policy_version_insert();

CREATE FUNCTION prepare_w2_policy_evidence_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_version_id UUID;
BEGIN
  -- Serialize evidence insertion against approval insertion for this change
  -- request so an approval cannot race with a late evidence append.
  SELECT policy_version_id
    INTO v_version_id
    FROM policy_change_requests
   WHERE id = NEW.change_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'policy change request % not found', NEW.change_request_id;
  END IF;
  IF v_version_id <> NEW.policy_version_id THEN
    RAISE EXCEPTION 'policy evidence version does not match change request';
  END IF;
  IF EXISTS (
    SELECT 1 FROM policy_approval_records
     WHERE change_request_id = NEW.change_request_id
  ) THEN
    RAISE EXCEPTION 'policy evidence is frozen after an approval decision exists';
  END IF;

  NEW.evidence_hash := 'sha256:' || encode(digest(NEW.evidence_payload::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_evidence_prepare_insert
  BEFORE INSERT ON policy_evidence_records
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_policy_evidence_insert();

CREATE FUNCTION prepare_w2_policy_approval_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_author_principal_id UUID;
  v_version_id UUID;
  v_manifest_item JSONB;
  v_evidence_count INTEGER;
BEGIN
  -- Same row lock as evidence insertion: whichever operation commits first
  -- determines whether a later evidence append is still permitted.
  SELECT author_principal_id, policy_version_id
    INTO v_author_principal_id, v_version_id
    FROM policy_change_requests
   WHERE id = NEW.change_request_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'policy change request % not found', NEW.change_request_id;
  END IF;
  IF v_version_id <> NEW.policy_version_id THEN
    RAISE EXCEPTION 'policy approval version does not match change request';
  END IF;
  IF NEW.decision = 'approved' AND v_author_principal_id = NEW.approver_principal_id THEN
    RAISE EXCEPTION 'self-approval is forbidden for policy change requests';
  END IF;

  -- Every manifest entry must identify immutable evidence belonging to this
  -- exact change request/version and must carry the stored content hash.
  FOR v_manifest_item IN
    SELECT value FROM jsonb_array_elements(NEW.evidence_manifest)
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM policy_evidence_records e
       WHERE e.id = (v_manifest_item->>'evidence_id')::uuid
         AND e.change_request_id = NEW.change_request_id
         AND e.policy_version_id = NEW.policy_version_id
         AND e.evidence_type = v_manifest_item->>'evidence_type'
         AND e.evidence_hash = v_manifest_item->>'evidence_hash'
    ) THEN
      RAISE EXCEPTION 'approval evidence manifest contains an invalid evidence binding';
    END IF;
  END LOOP;

  IF NEW.decision = 'approved' THEN
    SELECT COUNT(DISTINCT value->>'evidence_type')
      INTO v_evidence_count
      FROM jsonb_array_elements(NEW.evidence_manifest);
    IF jsonb_array_length(NEW.evidence_manifest) <> 4
       OR v_evidence_count <> 4
       OR EXISTS (
      SELECT required.type
        FROM (VALUES
          ('validation_result'),
          ('simulation_summary'),
          ('diff_impact_summary'),
          ('recommendations_summary')
        ) AS required(type)
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(NEW.evidence_manifest) item
          WHERE item->>'evidence_type' = required.type
       )
    ) THEN
      RAISE EXCEPTION 'approved policy change requires the complete evidence set';
    END IF;
  END IF;

  NEW.evidence_set_hash := 'sha256:' || encode(digest(NEW.evidence_manifest::text, 'sha256'), 'hex');
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_approvals_prepare_insert
  BEFORE INSERT ON policy_approval_records
  FOR EACH ROW EXECUTE FUNCTION prepare_w2_policy_approval_insert();

-- W2-01 authority artifacts are append-only. Corrections produce new policy
-- versions/evidence/approval records; they never rewrite historical authority.
CREATE FUNCTION enforce_w2_policy_authority_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER trg_policy_versions_no_update
  BEFORE UPDATE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_versions_no_delete
  BEFORE DELETE ON policy_versions
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_versions_no_truncate
  BEFORE TRUNCATE ON policy_versions
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_authority_append_only();

CREATE TRIGGER trg_policy_change_requests_no_update
  BEFORE UPDATE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_change_requests_no_delete
  BEFORE DELETE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_change_requests_no_truncate
  BEFORE TRUNCATE ON policy_change_requests
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_authority_append_only();

CREATE TRIGGER trg_policy_evidence_no_update
  BEFORE UPDATE ON policy_evidence_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_evidence_no_delete
  BEFORE DELETE ON policy_evidence_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_evidence_no_truncate
  BEFORE TRUNCATE ON policy_evidence_records
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_authority_append_only();

CREATE TRIGGER trg_policy_approvals_no_update
  BEFORE UPDATE ON policy_approval_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_approvals_no_delete
  BEFORE DELETE ON policy_approval_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_approvals_no_truncate
  BEFORE TRUNCATE ON policy_approval_records
  FOR EACH STATEMENT EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
