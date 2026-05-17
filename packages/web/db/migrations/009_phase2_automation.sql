-- db/migrations/009_phase2_automation.sql
-- Phase 2: Auto-merge queue, developer feedback, error recovery, observability.

-- ── Merge queue entries ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_queue_entries (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  pr_number       INT          NOT NULL,
  pr_title        TEXT         NOT NULL,
  head_sha        TEXT         NOT NULL,
  head_branch     TEXT         NOT NULL,
  base_branch     TEXT         NOT NULL DEFAULT 'main',
  author_login    TEXT         NOT NULL,
  position        INT          NOT NULL DEFAULT 0,
  status          TEXT         NOT NULL DEFAULT 'pending',
  required_checks TEXT[]       NOT NULL DEFAULT '{}',
  checks_passed   TEXT[]       NOT NULL DEFAULT '{}',
  checks_failed   TEXT[]       NOT NULL DEFAULT '{}',
  admitted_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  ready_at        TIMESTAMPTZ,
  merged_at       TIMESTAMPTZ,
  blocked_at      TIMESTAMPTZ,
  merge_method    TEXT         NOT NULL DEFAULT 'squash',
  delete_branch   BOOLEAN      NOT NULL DEFAULT TRUE,
  merge_error     TEXT,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, pr_number)
);

CREATE INDEX IF NOT EXISTS idx_mq_repo   ON merge_queue_entries(repo_id);
CREATE INDEX IF NOT EXISTS idx_mq_status ON merge_queue_entries(status);
CREATE INDEX IF NOT EXISTS idx_mq_pos    ON merge_queue_entries(repo_id, position);

-- ── Merge queue config per repo ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_queue_config (
  id                  BIGSERIAL    PRIMARY KEY,
  repo_id             BIGINT       NOT NULL UNIQUE REFERENCES repositories(github_id) ON DELETE CASCADE,
  enabled             BOOLEAN      NOT NULL DEFAULT FALSE,
  merge_method        TEXT         NOT NULL DEFAULT 'squash',
  delete_branch       BOOLEAN      NOT NULL DEFAULT TRUE,
  required_checks     TEXT[]       NOT NULL DEFAULT '{}',
  max_queue_depth     INT          NOT NULL DEFAULT 20,
  check_timeout_mins  INT          NOT NULL DEFAULT 60,
  rollback_enabled    BOOLEAN      NOT NULL DEFAULT FALSE,
  base_branch         TEXT         NOT NULL DEFAULT 'main',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Feedback rules ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS feedback_rules (
  id              BIGSERIAL    PRIMARY KEY,
  installation_id BIGINT       NOT NULL REFERENCES installations(github_id),
  name            TEXT         NOT NULL,
  event_type      TEXT         NOT NULL,
  repo_filter     TEXT,
  post_pr_comment BOOLEAN      NOT NULL DEFAULT TRUE,
  slack_webhook   TEXT,
  teams_webhook   TEXT,
  include_log_link     BOOLEAN  NOT NULL DEFAULT TRUE,
  include_diff_preview BOOLEAN  NOT NULL DEFAULT FALSE,
  enabled              BOOLEAN  NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Pipeline events (observability time-series) ────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_events (
  id          BIGSERIAL    PRIMARY KEY,
  repo_id     BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  event_type  TEXT         NOT NULL,
  actor       TEXT,
  ref         TEXT,
  pr_number   INT,
  duration_ms INT,
  success     BOOLEAN,
  metadata    JSONB        NOT NULL DEFAULT '{}',
  occurred_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pe_repo ON pipeline_events(repo_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_type ON pipeline_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pe_time ON pipeline_events(occurred_at DESC);

-- ── Rollback events ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rollback_events (
  id              BIGSERIAL    PRIMARY KEY,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  pr_number       INT,
  merge_commit    TEXT         NOT NULL,
  revert_commit   TEXT,
  revert_pr_number INT,
  trigger_reason  TEXT         NOT NULL,
  trigger_details TEXT,
  status          TEXT         NOT NULL DEFAULT 'pending',
  initiated_by    TEXT         NOT NULL DEFAULT 'gitwire[bot]',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rb_repo ON rollback_events(repo_id);
CREATE INDEX IF NOT EXISTS idx_rb_status ON rollback_events(status);
