-- 033_patch_artifacts.sql
-- Durable content-addressed storage for patch proposal artifacts.
--
-- Artifacts are canonical JSON serializations of structured edit operations.
-- The artifact_hash (SHA-256 of the content bytes) is the primary key.
-- Artifacts are write-once: INSERT with ON CONFLICT DO NOTHING.
-- They are never deleted — proposals retain their artifact_ref across
-- process restarts, worker relocation, and multi-process deployments.

CREATE TABLE IF NOT EXISTS patch_artifacts (
  artifact_hash  TEXT PRIMARY KEY,
  artifact_ref   TEXT UNIQUE NOT NULL,
  content        TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
