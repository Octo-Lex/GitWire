-- db/migrations/011_phase4_intelligence.sql
-- Phase 4: Pre-merge AI review gate + Compliance & audit trails.

-- ═══════════════════════════════════════════════════════════════════════════
-- PILLAR 1: Pre-merge AI review gate
-- ═══════════════════════════════════════════════════════════════════════════

-- One row per AI review per PR (re-runs on new commits, so multiple rows per PR).
CREATE TABLE IF NOT EXISTS ai_reviews (
  id               BIGSERIAL    PRIMARY KEY,
  repo_id          BIGINT       NOT NULL REFERENCES repositories(github_id) ON DELETE CASCADE,
  pr_number        INT          NOT NULL,
  commit_sha       TEXT         NOT NULL,
  -- Review content
  summary          TEXT,
  verdict          TEXT         NOT NULL DEFAULT 'approved',
  -- approved | request_changes | needs_discussion
  confidence       TEXT         NOT NULL DEFAULT 'medium',
  -- high | medium | low
  -- Structured findings (JSONB array of finding objects)
  findings         JSONB        NOT NULL DEFAULT '[]',
  -- [{category, severity, title, description, file, line, suggestion}]
  -- Metrics
  files_reviewed   INT          NOT NULL DEFAULT 0,
  lines_added      INT          NOT NULL DEFAULT 0,
  lines_removed    INT          NOT NULL DEFAULT 0,
  tokens_used      INT,
  -- GitHub integration
  github_review_id BIGINT,
  check_run_id     BIGINT,
  -- Timing
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  -- Config snapshot used for this review
  config_snapshot  JSONB        NOT NULL DEFAULT '{}',
  UNIQUE(repo_id, pr_number, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_ar_repo    ON ai_reviews(repo_id);
CREATE INDEX IF NOT EXISTS idx_ar_pr      ON ai_reviews(repo_id, pr_number);
CREATE INDEX IF NOT EXISTS idx_ar_verdict ON ai_reviews(verdict);

-- Per-repo AI review configuration
CREATE TABLE IF NOT EXISTS ai_review_config (
  id                      BIGSERIAL    PRIMARY KEY,
  repo_id                 BIGINT       NOT NULL UNIQUE REFERENCES repositories(github_id) ON DELETE CASCADE,
  enabled                 BOOLEAN      NOT NULL DEFAULT FALSE,
  -- What the reviewer evaluates
  check_logic             BOOLEAN      NOT NULL DEFAULT TRUE,
  check_security          BOOLEAN      NOT NULL DEFAULT TRUE,
  check_architecture      BOOLEAN      NOT NULL DEFAULT TRUE,
  check_cost_leaks        BOOLEAN      NOT NULL DEFAULT TRUE,
  check_tests             BOOLEAN      NOT NULL DEFAULT TRUE,
  check_docs              BOOLEAN      NOT NULL DEFAULT FALSE,
  -- Behaviour
  block_on_verdict        TEXT[]       NOT NULL DEFAULT '{"request_changes"}',
  min_confidence_to_block TEXT         NOT NULL DEFAULT 'medium',
  max_files_to_review     INT          NOT NULL DEFAULT 30,
  max_lines_to_review     INT          NOT NULL DEFAULT 2000,
  -- Architecture context (free-text injected into the prompt)
  architecture_context    TEXT,
  -- Patterns to ignore (glob, e.g. '*.lock', 'dist/**')
  ignore_patterns         TEXT[]       NOT NULL DEFAULT '{"*.lock","package-lock.json","yarn.lock","*.min.js","dist/**","build/**"}',
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- PILLAR 2: Compliance & audit trails
-- ═══════════════════════════════════════════════════════════════════════════

-- The sequence used for the seq column (NO CYCLE = never wraps)
CREATE SEQUENCE IF NOT EXISTS audit_trail_seq START 1 INCREMENT 1 NO CYCLE;

-- Immutable, append-only audit trail.
-- Separate from audit_log (which is operational) — this is the compliance record.
-- Every AI decision, auto-merge, policy bypass, and branch-rule change lands here.
CREATE TABLE IF NOT EXISTS audit_trail_entries (
  id              BIGSERIAL    PRIMARY KEY,
  -- Sequence number: monotonically increasing, never reused, never updated.
  seq             BIGINT       NOT NULL UNIQUE DEFAULT nextval('audit_trail_seq'),
  -- Classification
  category        TEXT         NOT NULL,
  -- ai_decision | auto_merge | policy_bypass | branch_rule | config_change
  -- vulnerability_dismissed | quarantine | heal | rollback | review_gate
  event_type      TEXT         NOT NULL,
  -- Actors
  actor           TEXT         NOT NULL,
  actor_type      TEXT         NOT NULL DEFAULT 'human',
  -- human | bot | system
  -- Subject
  repo_full_name  TEXT,
  pr_number       INT,
  commit_sha      TEXT,
  -- Payload (immutable — never updated)
  payload         JSONB        NOT NULL DEFAULT '{}',
  -- Compliance metadata
  framework       TEXT[],
  -- ['soc2', 'iso27001', 'gdpr', 'hipaa']
  control_id      TEXT,
  -- Integrity
  payload_hash    TEXT         NOT NULL,
  -- SHA-256 of payload JSON
  prev_hash       TEXT,
  -- hash of previous entry (chain integrity)
  -- Timestamp — set once, never changed
  occurred_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ate_category  ON audit_trail_entries(category);
CREATE INDEX IF NOT EXISTS idx_ate_actor     ON audit_trail_entries(actor);
CREATE INDEX IF NOT EXISTS idx_ate_repo      ON audit_trail_entries(repo_full_name);
CREATE INDEX IF NOT EXISTS idx_ate_time      ON audit_trail_entries(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ate_framework ON audit_trail_entries USING GIN(framework);

-- Compliance report snapshots (generated on demand or nightly)
CREATE TABLE IF NOT EXISTS compliance_reports (
  id               BIGSERIAL    PRIMARY KEY,
  report_type      TEXT         NOT NULL,
  -- 'soc2' | 'iso27001' | 'custom'
  period_start     TIMESTAMPTZ  NOT NULL,
  period_end       TIMESTAMPTZ  NOT NULL,
  generated_by     TEXT         NOT NULL DEFAULT 'system',
  -- Report content
  summary          JSONB        NOT NULL DEFAULT '{}',
  controls         JSONB        NOT NULL DEFAULT '[]',
  -- Integrity
  entry_count      INT          NOT NULL DEFAULT 0,
  first_seq        BIGINT,
  last_seq         BIGINT,
  report_hash      TEXT,
  -- Export
  export_url       TEXT,
  export_signed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Nightly export tracking
CREATE TABLE IF NOT EXISTS audit_exports (
  id              BIGSERIAL    PRIMARY KEY,
  export_type     TEXT         NOT NULL DEFAULT 'nightly',
  date_covered    DATE         NOT NULL UNIQUE,
  entry_count     INT          NOT NULL DEFAULT 0,
  file_path       TEXT,
  file_hash       TEXT,
  signed          BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
