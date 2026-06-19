-- 035_source_snapshots.sql
-- Durable source-snapshot bindings for execution receipt verification.
--
-- A source snapshot records the exact file set materialized at a specific
-- base SHA. Its hash is content-addressed from the file contents. The
-- receipt verifier resolves this row under lock to verify that the receipt
-- was produced from the expected pinned commit snapshot, not an arbitrary
-- or incomplete file set.
--
-- The composite key (snapshot_hash, repo_full_name, base_sha) prevents
-- cross-repo collisions: identical file sets in different repos produce
-- the same content hash but are stored as distinct rows, so a receipt
-- from repo A cannot satisfy verification for repo B.
--
-- Write-once: INSERT ON CONFLICT DO NOTHING. Never deleted.

CREATE TABLE IF NOT EXISTS source_snapshots (
  snapshot_hash    TEXT NOT NULL,
  repo_full_name   TEXT NOT NULL,
  base_sha         TEXT NOT NULL,
  file_manifest    TEXT NOT NULL,
  blob_count       INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (snapshot_hash, repo_full_name, base_sha)
);
