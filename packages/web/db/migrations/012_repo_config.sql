-- 012_repo_config.sql
-- Per-repo .gitwire.yml overrides stored in the database.
-- Takes precedence over YAML file, falls back to defaults.
-- Allows dashboard UI to control pillar settings.

CREATE TABLE IF NOT EXISTS repo_config (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT      NOT NULL UNIQUE REFERENCES repositories(github_id),
  config      JSONB       NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT        DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_repo_config_repo_id ON repo_config (repo_id);
