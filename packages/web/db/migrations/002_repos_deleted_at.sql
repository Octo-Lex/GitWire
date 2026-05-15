-- db/migrations/002_repos_deleted_at.sql
-- Adds soft-delete support to repositories.
-- Run after 001_initial_schema.sql

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_repos_deleted ON repositories(deleted_at)
  WHERE deleted_at IS NULL;
