-- db/migrations/001_initial_schema.sql
-- Run with: psql $DATABASE_URL -f db/migrations/001_initial_schema.sql

-- ── Installations ─────────────────────────────────────────────────────────────
-- One row per GitHub App installation (org or user account)
CREATE TABLE IF NOT EXISTS installations (
  id            BIGSERIAL PRIMARY KEY,
  github_id     BIGINT      NOT NULL UNIQUE,   -- installation.id from GitHub
  account_login TEXT        NOT NULL,           -- org or user login
  account_type  TEXT        NOT NULL,           -- "Organization" | "User"
  target_id     BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

-- ── Repositories ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS repositories (
  id              BIGSERIAL PRIMARY KEY,
  github_id       BIGINT      NOT NULL UNIQUE,
  installation_id BIGINT      NOT NULL REFERENCES installations(github_id),
  full_name       TEXT        NOT NULL,         -- "owner/repo"
  owner           TEXT        NOT NULL,
  name            TEXT        NOT NULL,
  private         BOOLEAN     NOT NULL DEFAULT FALSE,
  default_branch  TEXT        NOT NULL DEFAULT 'main',
  language        TEXT,
  stars           INT         NOT NULL DEFAULT 0,
  open_issues     INT         NOT NULL DEFAULT 0,
  open_prs        INT         NOT NULL DEFAULT 0,
  last_synced_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repos_installation ON repositories(installation_id);
CREATE INDEX IF NOT EXISTS idx_repos_full_name    ON repositories(full_name);

-- ── Issues ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS issues (
  id             BIGSERIAL PRIMARY KEY,
  github_id      BIGINT      NOT NULL UNIQUE,
  repo_id        BIGINT      NOT NULL REFERENCES repositories(github_id),
  number         INT         NOT NULL,
  title          TEXT        NOT NULL,
  state          TEXT        NOT NULL,          -- "open" | "closed"
  labels         TEXT[]      NOT NULL DEFAULT '{}',
  assignees      TEXT[]      NOT NULL DEFAULT '{}',
  -- AI triage fields
  triage_type     TEXT,                         -- bug | feature | question | ...
  triage_priority TEXT,                         -- critical | high | medium | low
  triage_summary  TEXT,
  triaged_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

CREATE INDEX IF NOT EXISTS idx_issues_repo  ON issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(state);

-- ── Pull requests ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pull_requests (
  id             BIGSERIAL PRIMARY KEY,
  github_id      BIGINT      NOT NULL UNIQUE,
  repo_id        BIGINT      NOT NULL REFERENCES repositories(github_id),
  number         INT         NOT NULL,
  title          TEXT        NOT NULL,
  state          TEXT        NOT NULL,          -- "open" | "closed" | "merged"
  draft          BOOLEAN     NOT NULL DEFAULT FALSE,
  head_branch    TEXT        NOT NULL,
  base_branch    TEXT        NOT NULL,
  labels         TEXT[]      NOT NULL DEFAULT '{}',
  -- AI triage fields
  triage_type    TEXT,
  triage_size    TEXT,                          -- size/XS .. size/XL
  triage_risk    TEXT,
  triage_summary TEXT,
  triaged_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

CREATE INDEX IF NOT EXISTS idx_prs_repo  ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_prs_state ON pull_requests(state);

-- ── CI workflow runs ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ci_runs (
  id              BIGSERIAL PRIMARY KEY,
  github_run_id   BIGINT      NOT NULL UNIQUE,
  repo_id         BIGINT      NOT NULL REFERENCES repositories(github_id),
  workflow_name   TEXT        NOT NULL,
  branch          TEXT        NOT NULL,
  head_sha        TEXT        NOT NULL,
  conclusion      TEXT,                         -- success | failure | cancelled | ...
  -- Healing fields
  heal_status     TEXT        NOT NULL DEFAULT 'pending',  -- pending | attempted | healed | failed | skipped
  heal_failure_type TEXT,
  heal_root_cause TEXT,
  heal_fix_applied TEXT,
  heal_confidence  TEXT,
  healed_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_repo       ON ci_runs(repo_id);
CREATE INDEX IF NOT EXISTS idx_runs_conclusion ON ci_runs(conclusion);
CREATE INDEX IF NOT EXISTS idx_runs_heal       ON ci_runs(heal_status);

-- ── Webhook delivery log (for debugging) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  delivery_id TEXT        NOT NULL UNIQUE,
  event_name  TEXT        NOT NULL,
  action      TEXT,
  repo        TEXT,
  processed   BOOLEAN     NOT NULL DEFAULT FALSE,
  error       TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
