-- db/migrations/003_maintainer.sql
-- GitWire Maintainer: action tracking, stale management, branch cleanup

-- Tracks every maintainer action for idempotency and audit
CREATE TABLE IF NOT EXISTS maintainer_actions (
  id              BIGSERIAL PRIMARY KEY,
  repo_id         BIGINT      NOT NULL REFERENCES repositories(github_id),
  action_type     TEXT        NOT NULL,   -- stale_warn, stale_close, branch_cleanup, label_apply, protect_enforce, comment_command
  target_type     TEXT        NOT NULL,   -- issue, pr, branch
  target_number   TEXT        NOT NULL,   -- issue/PR number or branch name
  idempotency_key TEXT        NOT NULL UNIQUE,
  status          TEXT        NOT NULL DEFAULT 'pending',  -- pending, applied, skipped, failed
  result          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_maintainer_repo    ON maintainer_actions(repo_id);
CREATE INDEX IF NOT EXISTS idx_maintainer_status   ON maintainer_actions(status);
CREATE INDEX IF NOT EXISTS idx_maintainer_idemp    ON maintainer_actions(idempotency_key);

-- Per-repo maintainer settings (tunable via API or comment commands)
CREATE TABLE IF NOT EXISTS maintainer_settings (
  id                BIGSERIAL PRIMARY KEY,
  repo_id           BIGINT      NOT NULL UNIQUE REFERENCES repositories(github_id),
  stale_issue_days  INT         NOT NULL DEFAULT 60,
  stale_pr_days     INT         NOT NULL DEFAULT 30,
  stale_warn_days   INT         NOT NULL DEFAULT 7,
  cleanup_branches  BOOLEAN     NOT NULL DEFAULT TRUE,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
