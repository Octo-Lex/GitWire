-- db/migrations/008_phase1_enforcement.sql
-- Phase 1: Branch protection enforcement + config validation.

-- ── Policy definitions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policy_definitions (
  id              BIGSERIAL    PRIMARY KEY,
  installation_id BIGINT       NOT NULL REFERENCES installations(github_id),
  name            TEXT         NOT NULL,
  description     TEXT,
  repo_filter     TEXT,
  branch_pattern  TEXT         NOT NULL DEFAULT 'main',
  min_reviews          INT,
  require_signed_commits    BOOLEAN,
  require_linear_history    BOOLEAN,
  block_force_pushes        BOOLEAN,
  block_deletions           BOOLEAN,
  enforce_admins            BOOLEAN,
  require_status_checks     BOOLEAN,
  required_status_check_contexts TEXT[],
  mode            TEXT         NOT NULL DEFAULT 'enforce',
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(installation_id, name)
);

CREATE INDEX IF NOT EXISTS idx_policy_installation ON policy_definitions(installation_id);
CREATE INDEX IF NOT EXISTS idx_policy_enabled       ON policy_definitions(enabled);

-- ── Enforcement violations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS enforcement_violations (
  id            BIGSERIAL    PRIMARY KEY,
  policy_id     BIGINT       NOT NULL REFERENCES policy_definitions(id) ON DELETE CASCADE,
  repo_id       BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  branch        TEXT         NOT NULL,
  violations    JSONB        NOT NULL DEFAULT '[]',
  status        TEXT         NOT NULL DEFAULT 'open',
  remediated_at TIMESTAMPTZ,
  remediated_by TEXT,
  detected_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(policy_id, repo_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_violations_repo   ON enforcement_violations(repo_id);
CREATE INDEX IF NOT EXISTS idx_violations_status ON enforcement_violations(status);
CREATE INDEX IF NOT EXISTS idx_violations_policy ON enforcement_violations(policy_id);

-- ── Config validation results ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS config_validation_results (
  id          BIGSERIAL    PRIMARY KEY,
  repo_id     BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  commit_sha  TEXT         NOT NULL,
  file_path   TEXT         NOT NULL,
  file_type   TEXT         NOT NULL,
  valid       BOOLEAN      NOT NULL,
  errors      JSONB        NOT NULL DEFAULT '[]',
  warnings    JSONB        NOT NULL DEFAULT '[]',
  check_run_id BIGINT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cv_repo   ON config_validation_results(repo_id);
CREATE INDEX IF NOT EXISTS idx_cv_commit ON config_validation_results(commit_sha);
CREATE INDEX IF NOT EXISTS idx_cv_valid  ON config_validation_results(valid);

-- Add compliance fields to branch_rules
ALTER TABLE branch_rules
  ADD COLUMN IF NOT EXISTS require_signed_commits   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS require_linear_history   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS compliant                BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_checked_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS violation_ids            BIGINT[];
