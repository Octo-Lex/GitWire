-- 013_config_history.sql
-- Audit trail for .gitwire.yml config changes.
-- Every PUT/PATCH/DELETE is recorded with before/after snapshots.

CREATE TABLE IF NOT EXISTS config_history (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT      NOT NULL REFERENCES repositories(github_id),
  action      TEXT        NOT NULL,          -- 'set', 'patch', 'delete'
  config_old  JSONB,                         -- null on first set
  config_new  JSONB,                         -- null on delete
  changed_by  TEXT        NOT NULL DEFAULT 'system',
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_history_repo ON config_history (repo_id, changed_at DESC);

-- Prevent unbounded growth: keep last 90 days
-- (pg_cron or manual: DELETE FROM config_history WHERE changed_at < NOW() - INTERVAL '90 days')
