-- db/migrations/010_phase3_trust.sql
-- Phase 3: Flaky test mitigation, fleet-wide policy-as-code, dependency lifecycle.

-- ═══════════════════════════════════════════════════════════════════════════
-- PILLAR 1: Flaky test mitigation
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS test_results (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  ci_run_id       BIGINT       REFERENCES ci_runs(id) ON DELETE SET NULL,
  commit_sha      TEXT         NOT NULL,
  branch          TEXT         NOT NULL,
  workflow_name   TEXT         NOT NULL,
  test_suite      TEXT         NOT NULL,
  test_name       TEXT         NOT NULL,
  test_id         TEXT         NOT NULL,
  status          TEXT         NOT NULL,
  duration_ms     INT,
  error_message   TEXT,
  error_class     TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tr_repo    ON test_results(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tr_test_id ON test_results(test_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tr_status  ON test_results(status);

CREATE TABLE IF NOT EXISTS flaky_tests (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  test_id         TEXT         NOT NULL,
  test_suite      TEXT         NOT NULL,
  test_name       TEXT         NOT NULL,
  run_count       INT          NOT NULL DEFAULT 0,
  pass_count      INT          NOT NULL DEFAULT 0,
  fail_count      INT          NOT NULL DEFAULT 0,
  flakiness_score REAL         NOT NULL DEFAULT 0,
  quarantined     BOOLEAN      NOT NULL DEFAULT FALSE,
  quarantined_at  TIMESTAMPTZ,
  quarantine_pr_number INT,
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_failed_at  TIMESTAMPTZ,
  graduated_at    TIMESTAMPTZ,
  UNIQUE(repo_id, test_id)
);

CREATE INDEX IF NOT EXISTS idx_ft_repo   ON flaky_tests(repo_id);
CREATE INDEX IF NOT EXISTS idx_ft_score  ON flaky_tests(flakiness_score DESC);
CREATE INDEX IF NOT EXISTS idx_ft_quar   ON flaky_tests(quarantined);

-- ═══════════════════════════════════════════════════════════════════════════
-- PILLAR 2: Fleet-wide policy as code
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS policy_repo_configs (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL UNIQUE REFERENCES repositories(github_id) ON DELETE CASCADE,
  desired_state   JSONB        NOT NULL DEFAULT '{}',
  observed_state  JSONB        NOT NULL DEFAULT '{}',
  in_sync         BOOLEAN,
  drift_fields    TEXT[]       NOT NULL DEFAULT '{}',
  last_reconciled_at TIMESTAMPTZ,
  next_reconcile_at  TIMESTAMPTZ,
  reconcile_skip  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prc_sync ON policy_repo_configs(in_sync);
CREATE INDEX IF NOT EXISTS idx_prc_next ON policy_repo_configs(next_reconcile_at);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id              BIGSERIAL    PRIMARY KEY,
  triggered_by    TEXT         NOT NULL DEFAULT 'scheduler',
  repos_checked   INT          NOT NULL DEFAULT 0,
  repos_synced    INT          NOT NULL DEFAULT 0,
  repos_drifted   INT          NOT NULL DEFAULT 0,
  repos_corrected INT          NOT NULL DEFAULT 0,
  repos_failed    INT          NOT NULL DEFAULT 0,
  duration_ms     INT,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PILLAR 3: Dependency & vulnerability lifecycle
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dependency_manifests (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  file_path       TEXT         NOT NULL,
  ecosystem       TEXT         NOT NULL,
  dependencies    JSONB        NOT NULL DEFAULT '[]',
  dep_count       INT          NOT NULL DEFAULT 0,
  scanned_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  commit_sha      TEXT,
  UNIQUE(repo_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_dm_repo ON dependency_manifests(repo_id);
CREATE INDEX IF NOT EXISTS idx_dm_eco  ON dependency_manifests(ecosystem);

CREATE TABLE IF NOT EXISTS vulnerability_advisories (
  id                BIGSERIAL    PRIMARY KEY,
  repo_id           BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  manifest_id       BIGINT       REFERENCES dependency_manifests(id) ON DELETE SET NULL,
  ghsa_id           TEXT,
  cve_id            TEXT,
  ecosystem         TEXT         NOT NULL,
  package_name      TEXT         NOT NULL,
  affected_range    TEXT         NOT NULL,
  patched_version   TEXT,
  installed_version TEXT,
  severity          TEXT         NOT NULL,
  cvss_score        REAL,
  summary           TEXT,
  status            TEXT         NOT NULL DEFAULT 'open',
  fix_pr_number     INT,
  fix_pr_url        TEXT,
  dismissed_reason  TEXT,
  published_at      TIMESTAMPTZ,
  detected_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, package_name, ghsa_id)
);

CREATE INDEX IF NOT EXISTS idx_va_repo     ON vulnerability_advisories(repo_id);
CREATE INDEX IF NOT EXISTS idx_va_severity ON vulnerability_advisories(severity);
CREATE INDEX IF NOT EXISTS idx_va_status   ON vulnerability_advisories(status);

CREATE TABLE IF NOT EXISTS dependency_update_batches (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  ecosystem       TEXT         NOT NULL,
  update_type     TEXT         NOT NULL,
  packages        JSONB        NOT NULL DEFAULT '[]',
  pr_number       INT,
  pr_url          TEXT,
  status          TEXT         NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dub_repo ON dependency_update_batches(repo_id);
CREATE INDEX IF NOT EXISTS idx_dub_status ON dependency_update_batches(status);
