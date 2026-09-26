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
-- identity evidence. New authority envelopes are created by the W2-01 service
-- from DB-owned rollout state and server-owned principal context.

CREATE TABLE policy_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id                BIGINT NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
  base_policy_version_id UUID REFERENCES policy_versions(id) ON DELETE RESTRICT,
  policy_document        JSONB NOT NULL,
  normalized_document    JSONB,
  content_hash           TEXT NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  author_principal_id    UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  author_display_name    TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_versions_repo_created
  ON policy_versions (repo_id, created_at DESC);
CREATE INDEX idx_policy_versions_content_hash
  ON policy_versions (repo_id, content_hash);

CREATE TABLE policy_change_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rollout_plan_id     INTEGER NOT NULL UNIQUE REFERENCES policy_rollout_plans(id) ON DELETE RESTRICT,
  repo_id             BIGINT NOT NULL REFERENCES repositories(github_id) ON DELETE RESTRICT,
  policy_version_id   UUID NOT NULL UNIQUE REFERENCES policy_versions(id) ON DELETE RESTRICT,
  author_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  author_display_name TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_policy_change_requests_repo_created
  ON policy_change_requests (repo_id, created_at DESC);
CREATE INDEX idx_policy_change_requests_author
  ON policy_change_requests (author_principal_id, created_at DESC);

CREATE TABLE policy_evidence_records (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id        UUID NOT NULL REFERENCES policy_change_requests(id) ON DELETE RESTRICT,
  policy_version_id        UUID NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  evidence_type            TEXT NOT NULL CHECK (evidence_type IN (
                             'validation_result',
                             'simulation_summary',
                             'diff_impact_summary',
                             'recommendations_summary'
                           )),
  evidence_payload         JSONB NOT NULL,
  evidence_hash            TEXT NOT NULL CHECK (evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  recorded_by_principal_id UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  recorded_by_display_name TEXT,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_policy_evidence_exact
    UNIQUE (change_request_id, evidence_type, evidence_hash)
);

CREATE INDEX idx_policy_evidence_change_request
  ON policy_evidence_records (change_request_id, recorded_at, id);

CREATE TABLE policy_approval_records (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id       UUID NOT NULL REFERENCES policy_change_requests(id) ON DELETE RESTRICT,
  policy_version_id       UUID NOT NULL REFERENCES policy_versions(id) ON DELETE RESTRICT,
  approver_principal_id   UUID NOT NULL REFERENCES gitwire_auth.auth_principals(id) ON DELETE RESTRICT,
  approver_display_name   TEXT,
  decision                TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason                  TEXT,
  evidence_manifest       JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_set_hash       TEXT NOT NULL CHECK (evidence_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_policy_approval_principal
    UNIQUE (change_request_id, approver_principal_id),
  CONSTRAINT chk_policy_approval_expiry
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idx_policy_approvals_change_request
  ON policy_approval_records (change_request_id, created_at DESC);

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

CREATE TRIGGER trg_policy_change_requests_no_update
  BEFORE UPDATE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_change_requests_no_delete
  BEFORE DELETE ON policy_change_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();

CREATE TRIGGER trg_policy_evidence_no_update
  BEFORE UPDATE ON policy_evidence_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_evidence_no_delete
  BEFORE DELETE ON policy_evidence_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();

CREATE TRIGGER trg_policy_approvals_no_update
  BEFORE UPDATE ON policy_approval_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
CREATE TRIGGER trg_policy_approvals_no_delete
  BEFORE DELETE ON policy_approval_records
  FOR EACH ROW EXECUTE FUNCTION enforce_w2_policy_authority_append_only();
