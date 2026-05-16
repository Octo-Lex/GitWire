-- db/migrations/006_heal_prs.sql
-- Tracks every auto-generated heal PR so the dashboard can link to them
-- and avoid opening duplicates for the same run.

CREATE TABLE IF NOT EXISTS heal_prs (
  id              BIGSERIAL    PRIMARY KEY,
  ci_run_id       BIGINT       NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
  repo_id         BIGINT       NOT NULL REFERENCES repositories(github_id),
  github_pr_number INT,
  github_pr_url   TEXT,
  heal_branch     TEXT         NOT NULL,
  failure_type    TEXT         NOT NULL,
  files_changed   TEXT[]       NOT NULL DEFAULT '{}',
  pr_title        TEXT,
  status          TEXT         NOT NULL DEFAULT 'open',  -- open | merged | closed
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_heal_prs_run  ON heal_prs(ci_run_id);
CREATE INDEX IF NOT EXISTS idx_heal_prs_repo ON heal_prs(repo_id);

-- Add pr_url column to ci_runs so the frontend can link directly to the PR
ALTER TABLE ci_runs
  ADD COLUMN IF NOT EXISTS heal_pr_url     TEXT,
  ADD COLUMN IF NOT EXISTS heal_pr_number  INT;
