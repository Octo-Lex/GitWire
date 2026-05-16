-- 004_issue_fix.sql
-- Tracks autonomous fix attempts with rate limiting.

CREATE TABLE IF NOT EXISTS fix_attempts (
  id            BIGSERIAL PRIMARY KEY,
  repo_id       BIGINT NOT NULL REFERENCES repositories(github_id),
  issue_number  INT NOT NULL,
  branch_name   TEXT NOT NULL,
  pr_number     INT,
  status        TEXT NOT NULL DEFAULT 'pending',
                -- pending | analyzing | generating | submitted | failed | rejected
  complexity    TEXT,           -- trivial | simple | moderate | complex
  explanation   TEXT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_attempts_repo_issue
  ON fix_attempts (repo_id, issue_number);

CREATE INDEX IF NOT EXISTS idx_fix_attempts_created
  ON fix_attempts (repo_id, created_at);
